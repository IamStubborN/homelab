# Homelab backups

The active backup path is Proxmox `vzdump` plus small application exports,
age-encrypted and uploaded with rclone to the ID-pinned `homelab-backups:` Google Drive alias.
`backup-to-google-drive.sh` is installed as
`/usr/local/sbin/homelab-backup-to-google-drive` on Proxmox. All jobs share
`/run/lock/homelab-google-drive-backup.lock`; normal successes are silent and
`backup-monitor.py` alerts the owner's private chat about failures or stale
copies.

| Job | Europe/Sofia schedule | Remote directory | Keep |
| --- | --- | --- | --- |
| OPNsense configuration | daily 04:00 | `Proxmox/OPNsense/config` | 5 |
| Application data | daily 04:05 | `Proxmox/Docker/apps` | 7 |
| Proxmox host configuration | Sunday 04:20 | `Proxmox/host-config` | 5 |
| Full OPNsense VM 100 | Sunday 04:25 | `Proxmox/OPNsense/full-vm` | 5 |
| Full Docker CT 300 | first Sunday of month 08:00 | `Proxmox/Docker/full-lxc` | 5 |

Daily and weekly backups run first in the 04:00–08:00 night window, before
the updates, so each night's copy is of the last working state; the monthly
Docker backup (about an hour, snapshot mode) runs after the window. Timers
name `Europe/Sofia` explicitly, so daylight saving time cannot move a backup
into the updates (see `watchtower/README.md`). The JacRed scheduler skips new
crawls during the backup hours.

The Docker guest's external bind mounts `/mnt/internal` and `/mnt/usb_drive`
are intentionally excluded; they are not covered by the application export
either. The monthly full guest archive is a recovery base, while the daily
archive reduces loss of application state. Archive creation, local `zstd`
validation, encryption, upload and provider SHA256/size checks must succeed
before retention prunes encrypted copies. Historical plaintext copies are preserved. Failed uploads leave the local archive for retry. Existing
Drive archives are not deleted by a schedule change.

## Daily application archive

`app-data-backup.py` runs inside CT 300 as
`/usr/local/sbin/homelab-app-data-backup`. It creates a private capture under
`/var/lib/homelab-app-backup`. The host packs that completed capture into one
`.tar.zst`, encrypts it as `.tar.zst.age`, uploads it to Drive, then deletes the capture.
The host script reuses an unfinished capture on retry. If that capture is from
an earlier UTC day, the same run then creates and uploads a fresh capture.
No uploaded capture stays on the guest disk. Its staging path is excluded from
full Docker guest backups.

The capture contains selected application bind state under the homelab
repository, configured Docker volumes, online SQLite copies and native
`pg_dump -Fc` exports from `media-postgres` and `freedium-db`. It omits caches,
logs, JacRed's regenerable database, most Plex media/metadata, raw PostgreSQL
storage, Docker images and external media disks. See the helper's `roots()`,
`SKIP_PREFIXES` and `POSTGRES` for the exact selection. SQLite is checked with
`PRAGMA quick_check` when possible; PostgreSQL dumps are checked with
`pg_restore --list`. These checks do not prove full application restoration.
Separate databases and file copies do not share one global transaction.

For recovery, first restore the monthly Docker guest archive if a complete
guest is needed. Download an appropriate daily archive separately and inspect
`manifest.json`. Stop affected applications before restoring `rootfs/` and
`volumes/`; import the PostgreSQL globals and dumps into compatible empty
databases. Do not overlay the daily set onto running containers. The Media
Service schema has previously required a scoped function `search_path` during
`pg_restore`; follow its application recovery notes rather than treating
`pg_restore --list` as a successful import.

Manual run: `systemctl start homelab-backup-apps.service`. Check
`systemctl show homelab-backup-apps.service -p Result -p ExecMainStatus` and
the Drive archive. The timer is `homelab-backup-apps.timer`. A periodic manual
download and sample restore is preferable to a permanent heavyweight validator.

First-run check (2026-10-10): the 1,603,212,532-byte archive
`apps-2026_10_10-15_00_41.tar.zst` was downloaded back from Drive. Its MD5
matched the local archive (`c7f5239ae542dd8cac918f2b9a13532b`), and
`manifest.json` was readable from the compressed tar. This verifies transfer
integrity, not a complete application restore.

## Credentials and old pilot

Rclone OAuth configuration and Telegram credentials are root-only private
files, not committed. New cloud archives are encrypted with the existing age
public recipient. Historical plaintext archives were not converted or deleted.
The private identity is absent from uploaders; tested independent escrow in
Bitwarden/iCloud/Google is documented in the home repository. The older
credential kit alone is not independent identity escrow.

The former PBS/restic pilot is retired. It is not part of the active schedule
or recovery path; see Git history for the old scripts and evaluation notes.

## Age encryption

Verified 2026-11-06: **deployed and tested** after explicit user approval and
independent source/installation review. A normal small host-config run passed
provider checksum verification, Mac authenticated decryption and native zstd/tar
validation, including the expected installed helpers and recovery metadata.
The backup freshness monitor checked its configured jobs without issues.
The first future scheduled encrypted runs of the other families have not yet
been observed. Full native guest/application restoration remains untested.

The earlier `candidate/` installer is withdrawn. A separately authorized and
reviewed one-time check of existing latest archives is **completed and tested**.
Native validation, encrypted upload, full ciphertext readback and independent
Mac authenticated decryption/source-hash validation passed, including guest
sidecars. Existing cloud objects were preserved, owned staging was cleaned,
and installed helpers and schedules remained unchanged. Exact inventories,
transfer quantities and private evidence stay in
`home/local/backup-encryption-20261106/full-check/`. This did not create fresh
guest/application captures or change routine verification below.

The wrapper calls `age-upload.py` as
`/usr/local/libexec/homelab-age-upload` for archives and guest notes/logs. It
reads only the existing public recipient from
`/etc/homelab-backup/router-recipients.txt`; private identities stay off uploaders.
New archives are stored in the existing five directories with `.age` appended.
All historical plaintext files remain intact. Strict retention owns only the
new encrypted archive names and their exact encrypted sidecars.

Native validation precedes encryption. Source and ciphertext stay in the private
dump directory until archive/sidecar uploads, provider SHA256+size verification
and encrypted retention succeed. Verification uses Google Drive metadata, with
no full readback or download fallback; absent/mismatching hashes fail safely.
Ordinary network transfer is one upload, plus small metadata requests. A single
small actual backup was downloaded/decrypted for initial rollout acceptance.
The separately authorized one-time existing-copy check is outside routine jobs.

Encryption needs a second archive's disk space plus overhead and a 2-GiB reserve.
Existing ciphertext is reused only with matching source, recipient and ciphertext
hashes. Failed uploads keep source/staging for recovery. Orphan complete ciphertext
without metadata fails safely for operator inspection. Application retry behavior
is preserved; this does not add a general replay queue to other jobs.

The unchanged monitor supports the transition through rclone alternatives such
as `apps-*.tar.zst{,.age}`: old and encrypted native archives both count, using
the original capture timestamps. Notes/logs/meta/partials do not count. The
presence of an old copy during transition does not prove the first scheduled
encrypted run has occurred. Other router backup jobs remain unchanged.

Checks: `python3 -m unittest discover -s proxmox-backup -p test_age_upload.py -v`
and `bash -n proxmox-backup/backup-to-google-drive.sh`. Tests use real age with
disposable keys and a fake cloud; routine verification fails if it downloads
payloads. Installed rclone filtering and Drive SHA256 availability are checked
separately before deployment. Full native system restoration remains untested.

Recovery: download `.age`, then use
`age -d -i age-identity.txt -o ORIGINAL-NAME ARCHIVE.age` on a trusted machine;
restore the recovered native archive with the normal application/guest procedure.
The tested key escrow is documented in the home repository.
