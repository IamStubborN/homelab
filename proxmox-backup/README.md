# Homelab backups

The active backup path is Proxmox `vzdump` plus small application exports,
uploaded with rclone to the ID-pinned `homelab-backups:` Google Drive alias.
`backup-to-google-drive.sh` is installed as
`/usr/local/sbin/homelab-backup-to-google-drive` on Proxmox. All jobs share
`/run/lock/homelab-google-drive-backup.lock`; normal successes are silent and
`backup-monitor.py` alerts the owner's private chat about failures or stale
copies.

| Job | Europe/Sofia schedule | Remote directory | Keep |
| --- | --- | --- | --- |
| OPNsense configuration | daily 05:20 | `Proxmox/OPNsense/config` | 5 |
| Application data | daily 05:40 | `Proxmox/Docker/apps` | 7 |
| Proxmox host configuration | Sunday 06:30 | `Proxmox/host-config` | 5 |
| Full OPNsense VM 100 | Sunday 07:00 | `Proxmox/OPNsense/full-vm` | 5 |
| Full Docker CT 300 | first Sunday of month 08:00 | `Proxmox/Docker/full-lxc` | 5 |

Timers name `Europe/Sofia` explicitly, so daylight saving time cannot move a
backup into the 04:00–05:00 update window (see `watchtower/README.md`). The
JacRed scheduler skips new crawls during the same backup hours.

The Docker guest's external bind mounts `/mnt/internal` and `/mnt/usb_drive`
are intentionally excluded; they are not covered by the application export
either. The monthly full guest archive is a recovery base, while the daily
archive reduces loss of application state. Archive creation, local `zstd`
validation, upload and remote size check must succeed before remote retention
prunes old copies. Failed uploads leave the local archive for retry. Existing
Drive archives are not deleted by a schedule change.

## Daily application archive

`app-data-backup.py` runs inside CT 300 as
`/usr/local/sbin/homelab-app-data-backup`. It creates a private capture under
`/var/lib/homelab-app-backup`. The host packs that completed capture into one
`.tar.zst`, uploads it directly to Drive, then marks the capture uploaded.
The host script reuses an unfinished capture on retry. If that capture is from
an earlier UTC day, the same run then creates and uploads a fresh capture.
It keeps one uploaded capture locally until the next run. Its staging path is
excluded from full Docker guest backups.

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
files, not committed. The Google Drive archives follow the existing direct
upload path and are **not encrypted by this wrapper**; the account and Drive
folder access therefore matter. The independent recovery-key kit is stored
outside the failed host and must remain accessible.

The former PBS/restic pilot is retired. It is not part of the active schedule
or recovery path; see Git history for the old scripts and evaluation notes.
