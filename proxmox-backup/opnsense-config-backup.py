#!/usr/bin/env python3
"""Export and validate a small OPNsense configuration bundle via QEMU agent."""
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import xml.etree.ElementTree as ET

FILES = (
    'conf/config.xml',
    'usr/local/opnsense/scripts/unbound-dnsbl/lib/__init__.py',
    'usr/local/opnsense/scripts/unbound-dnsbl/lib/dnsbl.py',
)
# Read each file once so manifest hashes describe the captured bytes exactly.
GUEST_CODE = '''
import base64, hashlib, io, json, tarfile, time
paths = %r
payload = {path: open('/' + path, 'rb').read() for path in paths}
manifest = {'created_unix': int(time.time()), 'sha256': {
    path: hashlib.sha256(data).hexdigest() for path, data in payload.items()}}
payload['manifest.json'] = json.dumps(manifest, sort_keys=True).encode()
output = io.BytesIO()
with tarfile.open(fileobj=output, mode='w:gz') as archive:
    for path, data in payload.items():
        info = tarfile.TarInfo(path)
        info.size = len(data)
        info.mode = 0o600
        archive.addfile(info, io.BytesIO(data))
print(base64.b64encode(output.getvalue()).decode())
''' % (FILES,)


def main():
    destination = Path(sys.argv[1])
    result = subprocess.run(
        ['qm', 'guest', 'exec', '100', '--timeout', '60', '--',
         '/usr/local/bin/python3', '-c', GUEST_CODE],
        check=True, capture_output=True, text=True, timeout=75,
    )
    execution = json.loads(result.stdout)
    if execution.get('exitcode') != 0 or not execution.get('exited'):
        raise RuntimeError('Guest configuration export failed')
    data = base64.b64decode(execution['out-data'].strip(), validate=True)
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        if set(archive.getnames()) != set(FILES) | {'manifest.json'}:
            raise RuntimeError('Unexpected backup contents')
        manifest = json.load(archive.extractfile('manifest.json'))
        for name in FILES:
            payload = archive.extractfile(name).read()
            if hashlib.sha256(payload).hexdigest() != manifest['sha256'][name]:
                raise RuntimeError('Backup checksum mismatch')
            if name == 'conf/config.xml' and ET.fromstring(payload).tag != 'opnsense':
                raise RuntimeError('Unexpected configuration XML root')
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'wb') as output:
        output.write(data)
    print('Validated OPNsense XML and DNSBL source bundle: %d bytes' % len(data))


if __name__ == '__main__':
    main()
