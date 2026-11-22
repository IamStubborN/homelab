# Homelab backups

Proxmox `vzdump` archives plus small application and configuration exports are
age-encrypted and uploaded with rclone to the ID-pinned `homelab-backups:`
Google Drive alias. `backup-to-google-drive.sh` is installed as
`/usr/local/sbin/homelab-backup-to-google-drive` on Proxmox. All jobs share
`/run/lock/homelab-google-drive-backup.lock` (a job waits up to 30 minutes for
it, then exits 75); normal successes are silent and `backup-monitor.py` alerts
the owner's private Telegram chat about failures, stale copies and recovery.

| Job | Europe/Sofia schedule | Remote directory | Keep |
| --- | --- | --- | --- |
| OPNsense configuration | daily 04:00 | `Proxmox/OPNsense/config` | 5 |
| Application data | daily 04:05 | `Proxmox/Docker/apps` | 7 |
| Proxmox host configuration | Sunday 04:20 | `Proxmox/host-config` | 5 |
| Full router VM | Sunday 04:25 | `Proxmox/OPNsense/full-vm` | 5 |
| Full Docker container | first Sunday of month 08:00 | `Proxmox/Docker/full-lxc` | 5 |

Daily and weekly backups run first in the 04:00–08:00 night window, before the
updates, so each night's copy is of the last working state; the monthly Docker
backup (about an hour, snapshot mode) runs after the window. Timers name
`Europe/Sofia` explicitly, so daylight saving time cannot move a backup into
the updates (see `watchtower/README.md`). The JacRed scheduler skips new crawls
during the backup hours.

The OPNsense configuration bundle holds `conf/config.xml` and the Unbound
DNSBL module sources (with the hotfix), exported through the QEMU guest agent.
The Docker guest's external bind mounts `/mnt/internal` and `/mnt/usb_drive`
are excluded from the full guest archive and from the application export.
Archive creation, local `zstd` validation, encryption, upload and provider
SHA256/size checks must succeed before retention prunes older copies. Failed
uploads leave the local archive for the next run.

## Install

As root on Proxmox, from a checkout of this repository. Create the root-only
`/etc/homelab-backup/proxmox.env` first and set `ROUTER_VM_ID` and
`DOCKER_CT_ID` to the intended guests (positive integers; the example leaves
them blank). The units load it with `EnvironmentFile=` without `-`, so they
fail to start while it is missing, and blank or invalid IDs fail closed.
Retention never broadens beyond these two IDs. Interactive recovery commands
must export the same values.

```sh
install -d -m 0700 /etc/homelab-backup
# First install only; then set the IDs and edit the jobs in place.
[ -e /etc/homelab-backup/proxmox.env ] || install -m 0600 proxmox-backup/proxmox.env.example /etc/homelab-backup/proxmox.env
[ -e /etc/homelab-backup/monitor.json ] || install -m 0600 proxmox-backup/monitor.example.json /etc/homelab-backup/monitor.json
install -m 0755 proxmox-backup/backup-to-google-drive.sh /usr/local/sbin/homelab-backup-to-google-drive
install -m 0755 proxmox-backup/age-upload.py /usr/local/libexec/homelab-age-upload
install -m 0755 proxmox-backup/backup-monitor.py /usr/local/libexec/homelab-backup-monitor
install -m 0755 proxmox-backup/opnsense-config-backup.py /usr/local/libexec/homelab-opnsense-config-backup
install -m 0755 proxmox-backup/host-config-backup.py /usr/local/libexec/homelab-host-config-backup
install -m 0644 proxmox-backup/homelab-backup@.service proxmox-backup/homelab-backup-apps.service \
  proxmox-backup/homelab-backup-monitor.service proxmox-backup/homelab-backup-*.timer /etc/systemd/system/
install -D -m 0644 proxmox-backup/homelab-backup-monitor.override.conf \
  /etc/systemd/system/homelab-backup@.service.d/monitor.conf
install -D -m 0644 proxmox-backup/homelab-backup-opnsense-config.override.conf \
  /etc/systemd/system/homelab-backup@opnsense-config.service.d/override.conf
systemctl daemon-reload
systemctl enable --now homelab-backup-opnsense-config.timer homelab-backup-apps.timer \
  homelab-backup-host-config.timer homelab-backup-opnsense.timer \
  homelab-backup-docker.timer homelab-backup-monitor.timer
```

Other root-only files, not in Git: `/etc/homelab-backup/router-recipients.txt`
(the single age public recipient), `/etc/homelab-backup/telegram.json`
(`token` and `chat_id` of the owner's private chat) and root's rclone
configuration with the `homelab-backups` alias.

In the Docker guest, as root, from its checkout:

```sh
install -m 0755 proxmox-backup/app-data-backup.py /usr/local/sbin/homelab-app-data-backup
install -d -m 0700 /etc/homelab
[ -e /etc/homelab/backup.json ] || install -m 0600 proxmox-backup/backup.example.json /etc/homelab/backup.json  # first install only; then edit
install -D -m 0644 proxmox-backup/docker-journald-retention.conf /etc/systemd/journald.conf.d/90-retention.conf
systemctl restart systemd-journald
```

`/etc/homelab/backup.json` names the repository path and the Docker volumes
that `app-data-backup.py` captures. `90-retention.conf` caps the guest's
journal (128 MiB, 14 days, 1 GiB kept free).

Configuration files (`proxmox.env`, `monitor.json`, `backup.json`) are
edited in place on the host and never reinstalled. Source edits to scripts and
units reach a host only through these `install` commands. After changing one,
install it and compare hashes as root on Proxmox, from the same commit:

```sh
while read -r repo installed; do
  [ "$(sha256sum < "$repo")" = "$(sha256sum < "$installed")" ] || echo "drift: $installed"
done <<'EOF'
proxmox-backup/backup-to-google-drive.sh /usr/local/sbin/homelab-backup-to-google-drive
proxmox-backup/age-upload.py /usr/local/libexec/homelab-age-upload
proxmox-backup/backup-monitor.py /usr/local/libexec/homelab-backup-monitor
proxmox-backup/opnsense-config-backup.py /usr/local/libexec/homelab-opnsense-config-backup
proxmox-backup/host-config-backup.py /usr/local/libexec/homelab-host-config-backup
proxmox-backup/homelab-backup@.service /etc/systemd/system/homelab-backup@.service
proxmox-backup/homelab-backup-apps.service /etc/systemd/system/homelab-backup-apps.service
proxmox-backup/homelab-backup-monitor.service /etc/systemd/system/homelab-backup-monitor.service
proxmox-backup/homelab-backup-apps.timer /etc/systemd/system/homelab-backup-apps.timer
proxmox-backup/homelab-backup-docker.timer /etc/systemd/system/homelab-backup-docker.timer
proxmox-backup/homelab-backup-host-config.timer /etc/systemd/system/homelab-backup-host-config.timer
proxmox-backup/homelab-backup-monitor.timer /etc/systemd/system/homelab-backup-monitor.timer
proxmox-backup/homelab-backup-opnsense-config.timer /etc/systemd/system/homelab-backup-opnsense-config.timer
proxmox-backup/homelab-backup-opnsense.timer /etc/systemd/system/homelab-backup-opnsense.timer
proxmox-backup/homelab-backup-monitor.override.conf /etc/systemd/system/homelab-backup@.service.d/monitor.conf
proxmox-backup/homelab-backup-opnsense-config.override.conf /etc/systemd/system/homelab-backup@opnsense-config.service.d/override.conf
EOF
```

In the Docker guest, run the same loop with
`proxmox-backup/app-data-backup.py /usr/local/sbin/homelab-app-data-backup` and
`proxmox-backup/docker-journald-retention.conf /etc/systemd/journald.conf.d/90-retention.conf`.

## Daily application archive

`app-data-backup.py` runs inside the configured Docker container as
`/usr/local/sbin/homelab-app-data-backup`. It creates a private capture under
`/var/lib/homelab-app-backup`. The host packs that completed capture into one
`.tar.zst`, encrypts it as `.tar.zst.age`, uploads it to Drive, then deletes the
capture. The host script reuses an unfinished capture on retry. If that capture
is from an earlier UTC day, the same run then creates and uploads a fresh
capture. No uploaded capture stays on the guest disk. Its staging path is
excluded from full Docker guest backups.

The capture contains selected application bind state under the homelab
repository, the volumes listed in `/etc/homelab/backup.json`, online SQLite
copies and native `pg_dump -Fc` exports from `media-postgres` and
`freedium-db`. It omits caches, logs, JacRed's regenerable database, most Plex
media/metadata, raw PostgreSQL storage, Docker images and external media disks.
See the helper's `roots()`, `SKIP_PREFIXES` and `POSTGRES` for the exact
selection. SQLite is checked with `PRAGMA quick_check` when possible;
PostgreSQL dumps are checked with `pg_restore --list`. These checks do not prove
full application restoration. Separate databases and file copies do not share
one global transaction.

For recovery, first restore the monthly Docker guest archive if a complete
guest is needed. Download an appropriate daily archive separately and inspect
`manifest.json`. Stop affected applications before restoring `rootfs/` and
`volumes/`; import the PostgreSQL globals and dumps into compatible empty
databases. Do not overlay the daily set onto running containers. The Media
Service schema needs a scoped function `search_path` during `pg_restore`;
follow its application recovery notes rather than treating `pg_restore --list`
as a successful import.

Manual run: `systemctl start homelab-backup-apps.service`. Check
`systemctl show homelab-backup-apps.service -p Result -p ExecMainStatus` and
the Drive archive. A periodic manual download and sample restore is preferable
to a permanent heavyweight validator.

## Encryption

- `age-upload.py` (`/usr/local/libexec/homelab-age-upload`) encrypts each
  validated archive and its guest notes/log to the single public recipient in
  `/etc/homelab-backup/router-recipients.txt` and uploads `NAME.age`. No private
  identity is on the uploaders; its escrow is documented in the private home
  repository.
- Uploads are verified against Google Drive SHA256 and size metadata, without
  downloading; a missing or mismatching hash fails the job and keeps the local
  source and ciphertext.
- An existing `.age` without its `.age.meta.json` binding (or with a mismatching
  one) fails the job and is left for operator inspection; it is never reused or
  overwritten.
- Retention prunes only `.age` archives matching the job's exact pattern and
  their `.age` sidecars. Plaintext archives from before encryption remain in the
  same folders and are not touched.
- Encryption needs free space for a second copy of the archive plus a 2-GiB
  reserve in the dump directory.
- Restores tested: the full OPNsense VM and one application's daily data from
  Drive. Not tested: a complete Docker container or full daily application
  restore.

To decrypt on a trusted machine:
`age -d -i age-identity.txt -o ORIGINAL-NAME ARCHIVE.age`, then restore the
native archive with the normal guest or application procedure.

## Monitor

`homelab-backup-monitor.timer` runs `homelab-backup-monitor check` hourly
(up to 5 minutes random delay). Each backup unit's `ExecStopPost` runs
`homelab-backup-monitor record JOB` (the `homelab-backup@` drop-in passes the
instance name, the apps unit `daily-apps`), which stores the result and starts
a check; a lock skip (exit 75) is not recorded as a failure. A Telegram message
is sent only when the issue list changes, including a recovery message.
`homelab-backup-monitor test` sends a test message.

Jobs live in `/etc/homelab-backup/monitor.json` (see `monitor.example.json`).
Every job also alerts when its last recorded run failed:

| Keys | Check |
| --- | --- |
| `remote`, `pattern`, `max_age_hours` | The newest file in `remote` matching `pattern` (rclone filter, e.g. `apps-*.tar.zst{,.age}`) has a name timestamp newer than `max_age_hours`. Notes, logs and partials do not match. |
| `success_file`, `max_age_hours` | The JSON receipt's `completed_utc` is newer than `max_age_hours`. Used for the router configuration backups from `scripts/router-config-backup` in the private home repository, one receipt per router under its state directory. |
| `failure_only: true` | Only the recorded failure, for jobs without an archive (`host-update`, `host-boot` from `proxmox-update/`). |
| `dnsbl_hotfix_vm` | Through the QEMU guest agent, both the installed and the running Unbound DNSBL module of that VM carry the hotfix. The value must equal `ROUTER_VM_ID`. OPNsense updates replace the module; reinstall it from `scripts/dnsbl-hotfix` in the home repository. |

## Checks

```sh
python3 -m unittest discover -s proxmox-backup -p 'test_*.py'
bash -n proxmox-backup/backup-to-google-drive.sh
```

Tests use real age with disposable keys and a fake cloud; routine verification
fails if it downloads payloads.
