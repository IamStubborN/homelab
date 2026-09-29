# Proxmox backups

These units upload verified backups to `Google Drive/Homelab Backups/Proxmox`.

- OPNsense VM 100: weekly on Sunday at 04:00 UTC, keep 5 full VM archives.
- Docker LXC 300: first Sunday of each month at 05:00 UTC, keep 5 full rootfs archives.
- Proxmox host configuration: weekly on Sunday at 03:30 UTC, keep 5 archives.

Retention was increased to five on September 25. The legacy schedules and paths
remain active while complete final PBS cloud-restoration acceptance is pending.
Production OPNsense and Proxmox reboot checks have passed. A reported Plex outage
after the Proxmox reboot was resolved; Plex and all 59 containers were verified
healthy at the post-reboot checkpoint. No further production downtime is
authorized. Activate replacement timers only after complete final isolated
restoration succeeds and the cutover is explicitly released; preserve existing
archives. Do not repeat production reboots as part of that remaining acceptance.

Targeted restoration of the actual daily app snapshot passed all 31 SQLite and
three PostgreSQL checks, including native Plex validation and a documented
recovery-only PostgreSQL `search_path` workaround. These results do not create
a complete pipeline success receipt: the final cloud-to-guests-to-apps run is
still pending. See [recovery validation](recovery/VALIDATION.md) and the
[prepared cutover](CUTOVER.md).

The Docker LXC bind mounts `/mnt/internal` and `/mnt/usb_drive` are excluded by
Proxmox `vzdump`. A local guest archive is removed only after upload and remote
size verification succeed. Failed jobs retain their local archive for recovery.

The rclone configuration is stored only on the Proxmox host at
`/root/.config/rclone/rclone.conf` with mode `0600`; it is not committed.

## Host recovery coverage and owner alerts

The September 25 host helper captures `/etc/fstab`, `/etc/vzdump.conf`, complete
network/default settings, boot/kernel/module/sysctl/udev settings, systemd units,
SSH client/server configuration and authorized public keys, and the backup
helpers themselves. `recovery-inventory/` records disk UUIDs and partitions,
LVM devices, mounts, interface MACs and bridges, routes, package/PVE versions,
boot mode and CPU layout. Compression uses one thread. Optional absent paths
are recorded in its manifest; required host configuration and failed inventory
commands stop the backup. Deploy `host-config-backup.py` atomically as
`/usr/local/libexec/homelab-host-config-backup`, mode `0750`.

These existing host archives contain sensitive `/etc/pve` configuration and are
not encrypted by this wrapper. Newly introduced SSH private keys, Google OAuth
tokens and Telegram credentials are deliberately excluded. On a fresh host,
regenerate SSH host keys, restore authorized public keys, and authorize rclone
from an independently accessible Google account (`rclone config`, using remote
authorization from a separate browser machine if necessary). Do not overwrite
live `/etc/pve` or network files wholesale; reconstruct the replacement system
using the inventory. Encrypted credential delivery remains a separate recovery
kit step; the self-hosted Vaultwarden server alone is not an independent copy.

`backup-monitor.py` runs on Proxmox independently of Docker and reuses the
existing Primary Hermes bot only to send notifications to Primary's private chat.
It checks `getChat` before each delivery and refuses group chats. Credentials
are root-only `/etc/homelab-backup/telegram.json`; never print or commit them.
`monitor.example.json` is deployed to `/etc/homelab-backup/monitor.json` and
contains only backup locations and freshness thresholds. Keep its cadence in
sync when replacing monthly Docker backups with the PBS pilot. The current
thresholds allow 50 hours for daily configuration, 194 hours for weekly copies,
and 866 hours for the existing first-Sunday monthly Docker archive.

The template service drop-in invokes `record JOB` after completion. This writes
the outcome locally and queues the independent monitor unit without waiting for
network probes; slow Drive/Telegram requests cannot stall backup shutdown. Lock skips
(exit 75) are not failures. The hourly timer independently lists Drive archives
and checks their filename creation timestamps, so a job that never started is
also detected. Alerts report failures, stale/missing copies or unavailable
Drive checks; unchanged conditions are silent, and clearing all conditions
produces one recovery message. Normal successful backups are silent. Local
state is `/var/lib/homelab-backup-monitor`, mode `0700`. Notification errors do
not turn a successful backup into a failure; a pending alert retries on the next
check. This monitor cannot report while the Proxmox host or its internet access
is completely unavailable; it is not an external availability monitor.

The PBS pilot check reports datastore utilization at or above 90%, inactive
PBS services, and a maintenance flag left behind after cloud replication.
Expected offline/service-stop state is suppressed only while the actual
`pbs-pilot-cloud-backup` shell process runs inside CT 101; a long guest backup
alone does not suppress those checks. Capacity checks remain active during
cloud copying. Probe commands are bounded and never include credential URLs.

The monitor checks archive presence/freshness and wrapper success, not the
integrity of all historical cloud data. Periodic PBS/restic verification and
isolated restoration remain separate requirements. One explicit setup message
was delivered to the verified private owner chat on September 25.

The replacement schedule uses these completion receipts. Each receipt is
advanced only after its complete pipeline succeeds, not when it merely starts:

| Monitor job | Receipt path | Maximum age |
| --- | --- | --- |
| `daily-apps` | `/var/lib/homelab-backup-monitor/apps-success.json` | 50 hours |
| `weekly-guests` | `/var/lib/homelab-backup-monitor/guests-success.json` | 194 hours |
| `quarterly-restore` | `/var/lib/homelab-backup/restore-validation/last-success.json` | 2,306 hours |

`completed_utc` is the required UTC timestamp. The initial daily receipt is
`2026-09-25T17:36:28.089076+00:00`; the initial weekly receipt also records the
actual guest snapshot IDs and their shared restic snapshot. Quarterly success
requires the separate full restore validator. `pbs-maintenance` reports failures
only. At final cutover, register these three receipt jobs and remove only the
legacy `opnsense` and `docker` full-archive freshness jobs after disabling their
old timers. Keep `opnsense-config`, `host-config`, the hourly monitor and all
existing cloud archives. Receipt jobs and replacement timers are not yet active
while complete final isolated restoration remains pending. Production reboot
checks have already passed.

The latest small configuration recovery points were refreshed after the
production reboots and downloaded back from Drive on September 25 (UTC):

| Archive | Bytes | Downloaded MD5 |
| --- | --- | --- |
| `opnsense-config-2026_09_25-20_59_44.tar.gz` | 38,285 | `49f21f2d5675eea92de2ad7109f9cdfa` |
| `proxmox-host-config-2026_09_25-21_00_11.tar.zst` | 195,072 | `2da47ed2557383f2409b3158600cf004` |

Both runs exited zero. Their monitor records show success at
`2026-09-25T21:00:09.619080+00:00` and
`2026-09-25T21:00:41.532492+00:00`. Downloaded hashes and sizes matched Drive
metadata. The OPNsense bundle contains the current PBS TCP/443 WAN exception,
verified by rule fields, and its internal manifest hashes pass. The host bundle
contains kernel inventory for `7.0.14-19-pve`, current PBS service ordering after
`pve-guests.service`, valid network/fstab settings and recovery inventory, and
these native guest startup settings with `onboot: 1`: VM 100 `order=1,up=150`,
CT 101 `order=2,up=30`, and CT 300 `order=3,up=20`. Private verification staging
was removed. Five small OPNsense bundles and five host archives are retained.
These were small live exports only; no service stops, heavy backups or schedule
cutover were performed.

## Daily important application data

`app-data-backup.py` runs inside CT 300. Its `inventory` mode reads only paths,
sizes and volume metadata; `capture NEW_DIRECTORY` prepares a private capture
under `/var/lib/homelab-app-backup`. A `manifest.json` is written only after all
database exports and file copies succeed. Failed/incomplete captures must not
be uploaded as valid recovery points.

Coverage includes Compose/source files and ignored secrets/configuration in
`/opt/homelab`, Home Assistant, Vaultwarden and other app bind state,
selected Hermes profile/memory/browser volumes, notifier state and encrypted
Rezka session state. SQL databases are handled as follows:

- SQLite files are detected by their file header, exported with the SQLite
  online backup API, and checked using `PRAGMA quick_check` on the copy. Live
  WAL/SHM/journal sidecars are excluded. Plex's custom tokenizer can require
  the native Plex SQLite executable for the final integrity check; the
  manifest explicitly records that exception instead of claiming it passed.
- Both PostgreSQL containers (`media-postgres` and `freedium-db`) export each
  non-template database with their own version-matched `pg_dump -Fc -Z1`, plus
  cluster globals. `pg_restore --list` validates each archive structure. Full
  SQL restoration into an isolated matching PostgreSQL server is a separate
  acceptance test, not implied by successful archive listing.
- These database snapshots are internally consistent individually. File copies,
  external attachments and different databases do not share one transaction or
  a globally identical timestamp. No services are stopped by the helper.

Daily exclusions are raw PostgreSQL storage (replaced by logical dumps), Docker
images, generated search/cache data, JacRed's regenerable database, logs, Plex
Media/Metadata/Drivers/Codecs and its dated automatic database copies. The weekly
full guest backup retains app state that is excluded from this smaller daily
set. Runtime sockets/FIFOs are skipped. Symlinks are preserved without following
them. External `/mnt/internal` and `/mnt/usb_drive`, including the deferred wiki,
are never traversed by this helper. No live data is deleted or pruned.

Hermes browser NSS certificate databases are also excluded from the daily set:
the running browser holds those SQLite stores exclusively and their online
backup cannot finish without interrupting it. Weekly full guest snapshots retain
them; daily-only restoration may require browser certificate/login setup again.

`app-pbs-backup.sh` uploads a completed directory as
`host/apps-300/<timestamp>/apps.pxar`. Its static PBS client 4.2.6 was downloaded
through the signed official `pbs-client` APT repository and extracted without
installing a conflicting package on Proxmox. CT 300 uses a dedicated `apps`
backup API token stored root-only, with a pinned PBS certificate fingerprint.
Local PBS data is unencrypted in this pilot; off-host restic data is encrypted.

`backup-apps-to-pbs.sh` runs on Proxmox and holds the shared backup lock through
capture, PBS upload and the coherent CT 101 restic cloud copy. It updates the
daily freshness receipt only after successful cloud completion. It then retains
the latest two completed local staging directories; incomplete captures remain
for diagnosis and count against the free-space preflight on subsequent runs.
The daily timer is prepared for 02:40 UTC, after the 02:20 configuration bundle.
Enable it only after the first pipeline, isolated recovery tests and production
reboot checks pass. Keep new staging directories excluded from subsequent full
Docker guest archives.

PBS cloud HTTPS from CT 101 has a narrow OPNsense WAN exception before the
YouTube policy route: source `192.0.2.5`, TCP destination port 443 and the
existing `YOUTUBE_DNS_V4` destination alias. Shared Google upload endpoints had
otherwise followed the Ukraine VPN. During the first upload, that path achieved
0.96 MiB/s with roughly 80 ms TCP RTT; after the exception and reconnecting only
the affected rclone sockets, the same job achieved 7.54 MiB/s with 9–28 ms RTT.
The configured upload cap and restic process were unchanged. This exception
does not change routing for household devices.

The initial capture completed at `2026-09-25T16:15:27Z` in 6 minutes 31 seconds:
2,427,505,211 bytes of input (1.17 GB repository/app files, 0.78 GB selected
volumes, 0.47 GB PostgreSQL dumps). It contains 31 SQLite snapshots: 29 passed
the system SQLite check and two Plex databases require their native tokenizer.
Three PostgreSQL database archives passed `pg_restore --list`. This measures
the prepared input, not deduplicated PBS storage or Google Drive transfer size.

The first complete app/PBS/cloud pipeline exited successfully at
`2026-09-25T17:36:28Z`. Restic snapshot
`810ddb7684936ad75ce34d34bd36c3c68943c02a960744a9807f56c5c2d8ffe6`
contains the manifests for `vm/100/2026-09-25T16:04:00Z`,
`ct/300/2026-09-25T16:21:31Z` and
`host/apps-300/2026-09-25T16:42:23Z`. Restic processed 24,217,768,972 bytes
and added 24,079,557,330 packed bytes in 52 minutes 51 seconds. Both PBS services
restarted and the datastore maintenance flag was cleared. Daily and initial
weekly cloud-completion receipts were recorded; this is upload evidence, not an
isolated restoration result. New schedules remain disabled pending the complete
final isolated restore; production reboot checks subsequently passed. The staging directory contains only the completed
2.43 GB capture; failed pilot captures were already removed.

Restoring the daily set: retrieve `apps.pxar` from the restored PBS datastore,
check its manifest, and stop the affected application before replacing files.
Copy `rootfs/` paths to their matching locations, recreate named volumes and
restore `volumes/<name>/` with preserved ownership. Import PostgreSQL globals
and custom dumps into compatible empty databases using the manifest's database
name mapping; filenames use UTF-8 hex encoding. Start apps only after database
and configuration validation. Do not overlay a daily set onto a running server.

Mechanisms follow the [SQLite online backup API](https://www.sqlite.org/backup.html),
[PostgreSQL pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html) and
[PBS client documentation](https://pbs.proxmox.com/docs/backup-client.html).

The wrapper normally uses `umask 077`. The LXC `vzdump` invocation alone uses
`umask 022`: its tar process runs as the container's mapped root (host UID
100000) and must traverse root-owned temporary directories. Using `077` there
caused the September 6, 2026 backup to fail with `Permission denied`. The
temporary tree lives under `/var/tmp` (`--tmpdir`) so it is accessible to mapped
root. The archive directory `/var/lib/vz/dump` is mode `0700`, keeping both
in-progress and completed archives private throughout creation; the completed
LXC archive is additionally set to mode `0600` before validation/upload.

Manual runs use the same lock, validation, upload, and retention as timers:

```sh
systemctl start homelab-backup@docker.service
systemctl start homelab-backup@opnsense.service
journalctl -u homelab-backup@docker.service -u homelab-backup@opnsense.service
```

Run these jobs sequentially; a concurrent job exits with code 75. Snapshot
backups leave guests running. Successful archive validation and remote size
verification do not replace a separate restore test.

## September 25, 2026 repair and verification

The Docker archive `vzdump-lxc-300-2026_09_25-03_18_32.tar.zst` completed at
07:52:15 UTC and was uploaded to `Docker/full-lxc`. Its size is 20,869,005,237
bytes and both local and Google Drive MD5 are
`c242fa2daa66cb9a823413b890b12a83`. The log and notes sidecars are present,
retention kept two archives, and local cleanup completed. `zstd -t` and
`pvesm extractconfig` passed before upload.

The Docker systemd invocation itself was **not** a clean success: after all
backup/upload/cleanup operations finished, it exited 2 because this repair
initially overwrote the running shell script in place. Bash resumed reading
at an old byte offset and reported an unmatched quote. This was a deployment
error, not archive corruption. The current script passes `bash -n`, has been
reinstalled atomically, and the stale failed unit state has been reset. A
future complete Docker timer invocation remains the end-to-end confirmation
of the final private-dumpdir plus `/var/tmp` arrangement; mapped-UID access
checks already pass.

When deploying this script, write a separate file, validate with `bash -n`,
set mode `0750`, and rename it atomically over the destination. Never truncate
the script inode while a job is executing it.

The fresh OPNsense archive
`vzdump-qemu-100-2026_09_25-03_57_52.vma.zst` completed at 08:09:19 UTC via
`homelab-opnsense-manual-backup-20260925.service` (live snapshot, no reboot).
After the Docker upload released the wrapper lock, the existing
`upload-existing opnsense` path ran in
`homelab-opnsense-manual-upload-20260925.service`, which exited successfully
at 08:24:27 UTC. `zstd -t` and configuration extraction passed. The remote
archive in `OPNsense/full-vm` is 9,612,940,990 bytes; local and Drive MD5 both
match `44c807349de7c4b679fab1382353d14f`. Both sidecars are present, retention
kept three archives, and local staging was cleaned up. The regular scheduled
OPNsense unit was not invoked for this manual run. No restore test was run.

## Daily OPNsense configuration bundles

`homelab-backup-opnsense-config.timer` runs daily at 02:20 UTC, with up
to two minutes of jitter. It retains the latest five successful bundles under
`OPNsense/config` (manual pre-change backups also count toward this limit).
It shares the full-backup lock; exit 75 means a full backup is running and the
next daily tick retries. The instance override treats that skip as non-fatal.

The helper uses VM 100's existing QEMU guest agent, without new SSH credentials,
to capture `conf/config.xml` and these persistent DNSBL hotfix source files:

- `usr/local/opnsense/scripts/unbound-dnsbl/lib/__init__.py`
- `usr/local/opnsense/scripts/unbound-dnsbl/lib/dnsbl.py`

Each bundle includes a manifest with creation time and SHA-256 for every file.
The XML and hashes are checked before upload; transfer checksum and explicit
remote-size verification precede local removal. Staging is root-only (`0700`),
archives and archived files are `0600`. Configuration includes credentials:
these are private Drive backups, **not encrypted archives**. Never commit them.
The bundle does not include the complete filesystem, packages, logs, or databases;
weekly full VM backups remain necessary. Package upgrades can invalidate the
saved hotfix sources; match OPNsense versions and review before reapplying them.

Deployment paths:

- `backup-to-google-drive.sh` → `/usr/local/sbin/homelab-backup-to-google-drive`
- `opnsense-config-backup.py` → `/usr/local/libexec/homelab-opnsense-config-backup`
- timer → `/etc/systemd/system/homelab-backup-opnsense-config.timer`
- instance override → `/etc/systemd/system/homelab-backup@opnsense-config.service.d/override.conf`

Use atomic file replacement, `systemctl daemon-reload`, then
`systemctl enable --now homelab-backup-opnsense-config.timer`. Run a manual
backup with `systemctl start homelab-backup@opnsense-config.service`.

The first bundle `opnsense-config-2026_09_25-08_36_41.tar.gz` is 38,165 bytes.
The actual Drive copy was downloaded and extracted into a temporary isolated
root-only directory. Its XML parsed, all three file SHA-256 values matched the
manifest, and all three restored files were `0600`. The temporary directory was
removed; no live router files were restored.

For real disaster recovery, first restore `config.xml` through OPNsense's
supported configuration restore workflow. If the matching package version still
requires this hotfix, copy the two reviewed source files to their persistent
paths above and the corresponding paths under
`/var/unbound/unbound-dnsbl/lib/`, preserving root ownership and readable module
permissions. Restart Unbound using OPNsense service management, then compare
source/runtime SHA-256 values and test allowed and blocked DNS names through a
real DNSBL update. Do not overwrite package files blindly after an upgrade.

## Full VM offline restore test, September 25, 2026

The actual Drive archive `vzdump-qemu-100-2026_09_25-03_57_52.vma.zst` was
downloaded using rclone's default post-copy checksum verification. The known
Drive/local MD5 is `44c807349de7c4b679fab1382353d14f`.

Native `qmrestore` restored all 32 GiB into temporary VM 901 on `local-lvm`,
with `--start 0 --unique 1 --bwlimit 65536`. The task finished **OK at
08:57:20 UTC**. Immediately afterward, autostart was disabled and both NICs
were removed; the guest remained stopped throughout. The resulting block
device had a valid GPT with EFI, FreeBSD boot, swap, and ZFS partitions. No
ZFS pool was imported and no restored guest service or network was activated.

An initial invocation using a shortened download filename (`opnsense.vma.zst`)
was rejected by Proxmox's archive-name parser before disk creation. Preserve
the original `vzdump-qemu-<id>-<timestamp>.vma.zst` name. The empty VM entry
from that attempt was removed before the successful retry.

After verification, VM 901, its sole disk `vm-901-disk-0`, and the private
9.6 GB download/staging directory were deleted. Their absence was verified;
live VM 100 remained running. This proves download, archive decoding, disk
restoration, and configuration reconstruction. **Guest boot, mounted filesystem
integrity, and restored services remain untested.**
