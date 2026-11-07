#!/usr/bin/env python3
"""Recipient-only encryption and cloud checksum verification for native backups."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess

CHUNK = 1024 * 1024
RECIPIENTS = Path('/etc/homelab-backup/router-recipients.txt')
RCLONE = ['rclone', '--bind', '0.0.0.0']
REMOTE_ROOT = 'homelab-backups:Proxmox/'
LOCATIONS = {
    'OPNsense/config': 'opnsense-config-*.tar.gz.age',
    'Docker/apps': 'apps-*.tar.zst.age',
    'host-config': 'proxmox-host-config-*.tar.zst.age',
    'OPNsense/full-vm': 'vzdump-qemu-100-*.vma.zst.age',
    'Docker/full-lxc': 'vzdump-lxc-300-*.tar.zst.age',
}
STAMP = r'[0-9]{4}_[0-9]{2}_[0-9]{2}-[0-9]{2}_[0-9]{2}_[0-9]{2}'


def archive_name(name, pattern):
    return re.fullmatch(re.escape(pattern).replace(r'\*', STAMP), name) is not None


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        while block := stream.read(CHUNK):
            value.update(block)
    return value.hexdigest()


def regular(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        raise ValueError('Expected an owned regular file')
    return info


def atomic_json(path, data):
    partial = path.with_name(path.name + '.partial')
    with partial.open('x') as stream:
        json.dump(data, stream, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())
    partial.replace(path)


def encrypted(source, recipient_file=RECIPIENTS):
    source = Path(source)
    before = regular(source)
    if source.parent.stat().st_mode & 0o077:
        raise ValueError('Archive directory must be owner-only')
    regular(recipient_file)
    recipient_bytes = recipient_file.read_bytes()
    recipients = [line.strip() for line in recipient_bytes.decode('utf-8').splitlines()
                  if line.strip() and not line.lstrip().startswith('#')]
    if len(recipients) != 1 or not re.fullmatch(r'age1[0-9a-z]{58}', recipients[0]):
        raise ValueError('Expected the single existing native age public recipient')
    cipher = source.with_name(source.name + '.age')
    metadata = cipher.with_name(cipher.name + '.meta.json')
    binding = {'format': 1, 'source_size': before.st_size,
               'source_sha256': digest(source), 'recipient_sha256': hashlib.sha256(recipient_bytes).hexdigest()}
    if cipher.exists() or metadata.exists():
        regular(cipher)
        regular(metadata)
        saved = json.loads(metadata.read_text())
        if any(saved.get(key) != value for key, value in binding.items()):
            raise ValueError('Existing ciphertext belongs to another source or recipient')
        if saved.get('cipher_size') != cipher.stat().st_size or saved.get('cipher_sha256') != digest(cipher):
            raise ValueError('Existing ciphertext integrity check failed')
        return cipher, saved
    overhead = max(64 * CHUNK, before.st_size // 500)
    if shutil.disk_usage(source.parent).free < before.st_size + overhead + 2 * 1024**3:
        raise RuntimeError('Insufficient free space for ciphertext and 2 GiB reserve')
    partial = cipher.with_name(cipher.name + '.partial')
    if partial.exists() or partial.is_symlink():
        regular(partial)
        partial.unlink()
    try:
        subprocess.run(['age', '-r', recipients[0], '-o', str(partial), str(source)],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        after = regular(source)
        if (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns) or digest(source) != binding['source_sha256']:
            raise ValueError('Source changed during encryption')
        regular(partial)
        os.chmod(partial, 0o600)
        with partial.open('rb') as stream:
            os.fsync(stream.fileno())
        binding.update(cipher_size=partial.stat().st_size, cipher_sha256=digest(partial))
        partial.replace(cipher)
        atomic_json(metadata, binding)
    finally:
        partial.unlink(missing_ok=True)
    return cipher, binding


def run_rclone(*args):
    result = subprocess.run([*RCLONE, *args], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    if result.returncode:
        raise RuntimeError('Cloud operation failed; source and ciphertext retained')
    return result.stdout


def remote_directory(remote):
    if remote not in {REMOTE_ROOT + location for location in LOCATIONS}:
        raise ValueError('Refusing a destination outside the five backup directories')


def verify_remote(destination, expected):
    # Read provider metadata only: never download a full archive to check it.
    info = json.loads(run_rclone('lsjson', destination, '--stat', '--hash-type', 'SHA-256'))
    if (info.get('IsDir') is not False
            or info.get('Name') != destination.rsplit('/', 1)[1]
            or info.get('Size') != expected['cipher_size']
            or info.get('Hashes', {}).get('sha256') != expected['cipher_sha256']):
        raise RuntimeError('Cloud ciphertext checksum verification failed; local files retained')


def upload(source, remote, recipient_file=RECIPIENTS):
    remote_directory(remote)
    cipher, metadata = encrypted(source, recipient_file)
    destination = remote + '/' + cipher.name
    run_rclone('mkdir', remote)
    run_rclone('copyto', str(cipher), destination, '--transfers', '1', '--checkers', '2', '--drive-chunk-size', '64M')
    verify_remote(destination, metadata)


def prune(remote, pattern, keep, current):
    remote_directory(remote)
    expected_pattern = LOCATIONS[remote[len(REMOTE_ROOT):]]
    if pattern != expected_pattern or keep not in (5, 7) or not archive_name(current, pattern):
        raise ValueError('Unexpected encrypted retention request')
    listing = json.loads(run_rclone('lsjson', remote, '--files-only'))
    names = set()
    for entry in listing:
        name = entry['Name']
        if '/' in name or '\\' in name or '\n' in name or '\r' in name or name in ('.', '..'):
            raise ValueError('Unexpected cloud filename')
        if not entry.get('IsDir', False):
            names.add(name)
    archives = sorted((name for name in names if archive_name(name, pattern)), reverse=True)
    if current not in archives:
        raise RuntimeError('Verified current archive is absent from retention listing')
    retained = {current, *[name for name in archives if name != current][:keep - 1]}
    for name in archives:
        if name in retained:
            continue
        # Only exact encrypted siblings belong to this retention transaction.
        siblings = [name, name[:-4] + '.notes.age']
        for suffix in ('.vma.zst.age', '.tar.zst.age'):
            if name.startswith('vzdump-') and name.endswith(suffix):
                siblings.append(name[:-len(suffix)] + '.log.age')
        for sibling in siblings:
            if sibling in names:
                run_rclone('deletefile', remote + '/' + sibling)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='operation', required=True)
    put = sub.add_parser('upload')
    put.add_argument('source', type=Path)
    put.add_argument('remote')
    retention = sub.add_parser('prune')
    retention.add_argument('remote')
    retention.add_argument('pattern')
    retention.add_argument('keep', type=int)
    retention.add_argument('current')
    args = parser.parse_args()
    try:
        if args.operation == 'upload':
            upload(args.source, args.remote)
        else:
            prune(args.remote, args.pattern, args.keep, args.current)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
        parser.exit(74, 'Encrypted backup operation failed; local recovery material retained.\n')


if __name__ == '__main__':
    main()
