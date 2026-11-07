"""Isolated real-age roundtrips and transfer/retention failure checks; no cloud access."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('age_upload', Path(__file__).with_name('age-upload.py'))
a = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(a)

FAKE = '''import hashlib,json,os,pathlib,shutil,sys
root=pathlib.Path(sys.argv[1]); command=sys.argv[2]; args=sys.argv[3:]
def remote(value):
 return root/value.split(':',1)[1]
if os.environ.get('FAIL_CLOUD')==command: sys.exit(9)
if command=='mkdir':remote(args[0]).mkdir(parents=True,exist_ok=True)
elif command=='copyto':shutil.copyfile(args[0],remote(args[1]))
elif command=='cat':sys.exit(11) # Routine verification must never download payloads.
elif command=='lsjson':
 if '--stat' in args:
  p=remote(args[0]);h=hashlib.sha256(p.read_bytes()).hexdigest()
  if os.environ.get('CORRUPT_CLOUD'):h='0'*64
  hashes={} if os.environ.get('MISSING_HASH') else {'sha256':h}
  print(json.dumps({'Name':p.name,'IsDir':False,'Size':p.stat().st_size,'Hashes':hashes}))
 else:print(json.dumps([{'Name':p.name,'IsDir':False} for p in remote(args[0]).iterdir()]))
elif command=='deletefile':remote(args[0]).unlink()
else:sys.exit(10)
'''


class UploadChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.root.chmod(0o700)
        self.key = self.root / 'identity'
        subprocess.run(['age-keygen', '-o', str(self.key)], capture_output=True, check=True)
        self.recipient = self.root / 'recipient'
        self.recipient.write_bytes(subprocess.check_output(['age-keygen', '-y', str(self.key)]))
        self.fake = self.root / 'rclone.py'
        self.fake.write_text(FAKE)
        self.cloud = self.root / 'cloud'
        self.patch = patch.object(a, 'RCLONE', [sys.executable, str(self.fake), str(self.cloud)])
        self.patch.start()
        self.remote = a.REMOTE_ROOT + 'Docker/apps'
        self.source = self.root / 'apps-2026_11_06-12_00_00.tar.zst'
        with self.source.open('wb') as f:
            for _ in range(8):
                f.write(os.urandom(1024 * 1024))

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def test_real_roundtrip_and_exact_ciphertext_retry(self):
        a.upload(self.source, self.remote, self.recipient)
        cipher = self.source.with_name(self.source.name + '.age')
        before = cipher.read_bytes()
        a.upload(self.source, self.remote, self.recipient)
        self.assertEqual(before, cipher.read_bytes())
        downloaded = self.cloud / 'Proxmox/Docker/apps' / cipher.name
        plain = subprocess.check_output(['age', '-d', '-i', str(self.key), str(downloaded)])
        self.assertEqual(hashlib.sha256(plain).hexdigest(), a.digest(self.source))
        self.assertTrue(self.source.exists())

    def test_changed_source_or_cipher_refuses_retry(self):
        cipher, _ = a.encrypted(self.source, self.recipient)
        original=cipher.read_bytes()
        cipher.write_bytes(original+b'corruption')
        with self.assertRaises(ValueError):a.encrypted(self.source, self.recipient)
        cipher.write_bytes(original)
        with self.source.open('ab') as f:
            f.write(b'new data')
        with self.assertRaises(ValueError):a.encrypted(self.source, self.recipient)
        self.assertTrue(cipher.exists())

    def test_checksum_missing_hash_and_cloud_failure_preserve_local_files(self):
        for environment in ({'CORRUPT_CLOUD':'1'}, {'MISSING_HASH':'1'}, {'FAIL_CLOUD':'lsjson'}, {'FAIL_CLOUD':'copyto'}):
            with patch.dict(os.environ, environment):
                with self.assertRaises(RuntimeError):a.upload(self.source, self.remote, self.recipient)
            self.assertTrue(self.source.exists())
            self.assertTrue(self.source.with_name(self.source.name+'.age').exists())

    def test_free_space_guard_before_encryption(self):
        with patch.object(a.shutil, 'disk_usage', return_value=type('Space', (), {'free':0})()):
            with self.assertRaises(RuntimeError):a.encrypted(self.source, self.recipient)
        self.assertFalse(self.source.with_name(self.source.name+'.age').exists())

    def test_encryption_failure_cleans_partial_and_preserves_source(self):
        original = a.subprocess.run
        def fail_age(command, **kwargs):
            if command[0]=='age':
                Path(command[command.index('-o')+1]).write_bytes(b'partial')
                raise subprocess.CalledProcessError(1, ['age'])
            return original(command, **kwargs)
        with patch.object(a.subprocess, 'run', side_effect=fail_age):
            with self.assertRaises(subprocess.CalledProcessError):a.encrypted(self.source, self.recipient)
        self.assertTrue(self.source.exists())
        self.assertFalse(self.source.with_name(self.source.name+'.age.partial').exists())

    def test_retention_protects_current_plaintext_and_unowned_names(self):
        remote = a.REMOTE_ROOT + 'OPNsense/full-vm'
        directory = self.cloud/'Proxmox/OPNsense/full-vm'
        directory.mkdir(parents=True)
        names=[]
        for day in range(1,9):
            name=f'vzdump-qemu-100-2026_11_{day:02d}-04_25_00.vma.zst.age'
            names.append(name)
            for n in [name,name[:-4]+'.notes.age',name[:-len('.vma.zst.age')]+'.log.age']:
                (directory/n).write_bytes(b'cipher')
        old_plain=names[0][:-4]
        (directory/old_plain).write_bytes(b'old plaintext')
        (directory/'vzdump-qemu-100-unowned.vma.zst.age').write_bytes(b'unowned')
        a.prune(remote,'vzdump-qemu-100-*.vma.zst.age',5,names[0])
        self.assertTrue((directory/names[0]).exists())
        self.assertTrue((directory/old_plain).exists())
        self.assertTrue((directory/'vzdump-qemu-100-unowned.vma.zst.age').exists())
        self.assertEqual(sum((directory/name).exists() for name in names),5)
        for name in names[1:4]:
            self.assertFalse((directory/name).exists())
            self.assertFalse((directory/(name[:-4]+'.notes.age')).exists())
            self.assertFalse((directory/(name[:-len('.vma.zst.age')]+'.log.age')).exists())

    def test_recipient_rotation_cannot_change_captured_encryption_key(self):
        original_bytes=self.recipient.read_bytes()
        other_key=self.root/'other-identity'
        subprocess.run(['age-keygen','-o',str(other_key)],capture_output=True,check=True)
        other_recipient=subprocess.check_output(['age-keygen','-y',str(other_key)])
        original_run=a.subprocess.run
        def rotate_before_age(command, **kwargs):
            if command[0]=='age':self.recipient.write_bytes(other_recipient)
            return original_run(command, **kwargs)
        with patch.object(a.subprocess,'run',side_effect=rotate_before_age):
            cipher,meta=a.encrypted(self.source,self.recipient)
        self.assertEqual(meta['recipient_sha256'],hashlib.sha256(original_bytes).hexdigest())
        plain=subprocess.check_output(['age','-d','-i',str(self.key),str(cipher)])
        self.assertEqual(hashlib.sha256(plain).hexdigest(),a.digest(self.source))
        wrong=subprocess.run(['age','-d','-i',str(other_key),str(cipher)],capture_output=True)
        self.assertNotEqual(wrong.returncode,0)
        with self.assertRaises(ValueError):a.encrypted(self.source,self.recipient)

    def test_orphan_ciphertext_refuses_overwrite_and_keeps_source(self):
        cipher=self.source.with_name(self.source.name+'.age')
        cipher.write_bytes(b'orphan ciphertext')
        before=a.digest(self.source)
        with self.assertRaises(OSError):a.encrypted(self.source,self.recipient)
        self.assertEqual(cipher.read_bytes(),b'orphan ciphertext')
        self.assertEqual(before,a.digest(self.source))

    def test_listing_failure_does_not_delete(self):
        directory=self.cloud/'Proxmox/Docker/apps'
        directory.mkdir(parents=True)
        name=self.source.name+'.age';(directory/name).write_bytes(b'cipher')
        with patch.dict(os.environ, {'FAIL_CLOUD':'lsjson'}):
            with self.assertRaises(RuntimeError):a.prune(self.remote,'apps-*.tar.zst.age',7,name)
        self.assertTrue((directory/name).exists())
        with self.assertRaises(ValueError):a.prune('homelab-backups:Proxmox/Encrypted/Docker/apps','apps-*.tar.zst.age',7,name)

    def test_guest_sidecar_failure_prevents_prune_and_cleanup(self):
        wrapper=Path(__file__).with_name('backup-to-google-drive.sh').read_text()
        function=wrapper[wrapper.index('upload_guest_archive() {'):wrapper.index('latest_archive() {')]
        archive=self.root/'vzdump-qemu-100-2026_11_06-04_25_00.vma.zst'
        archive.write_bytes(b'native');Path(str(archive)+'.notes').write_bytes(b'notes')
        marker=self.root/'must-not-exist'
        script='''set -euo pipefail
LOCAL_BACKUP_DIR=$1
REMOTE_ROOT=homelab-backups:Proxmox
MARKER=$3
zstd() { :; }
pvesm() { :; }
upload_file() { [[ "$1" != *.notes ]]; }
prune_remote() { touch "$MARKER"; }
cleanup_file() { touch "$MARKER"; }
'''+function+'\nupload_guest_archive opnsense "$2"\n'
        result=subprocess.run(['bash','-c',script,'test',str(self.root),str(archive),str(marker)],capture_output=True)
        self.assertNotEqual(result.returncode,0)
        self.assertTrue(archive.exists())
        self.assertTrue(Path(str(archive)+'.notes').exists())
        self.assertFalse(marker.exists())


if __name__=='__main__':unittest.main()
