# PBS / Drive pilot

This is an evaluation deployment, not yet a replacement for verified vzdump
archives. PBS is installed from official Debian/Proxmox APT repositories inside
an unprivileged Debian 13 LXC. LXC is a resource-conscious local choice, not an
official PBS appliance installation method. PBS documentation's 2 GiB/2-core
evaluation minimum applies; its production recommendation starts at 4 GiB RAM.

Approved placement: CT 101, 12 GiB root, 128 GiB managed ext4 datastore mount
on `local-lvm` at `/mnt/datastore` with `backup=0`, 2 GiB RAM, 512 MiB swap,
CPU-time limit 2, explicit physical CPU set 0–2, CPU and I/O weight 50. No ZFS,
community installer, or PBS packages on the production hypervisor. The datastore
shares the host SSD and cannot survive its loss; the verified Drive copy is the
intended off-host recovery path. Keep old backups until that path is proven.

Installation reference:
https://pbs.proxmox.com/docs/installation.html#install-proxmox-backup-server-on-debian

Cloud snapshots must capture a quiescent datastore: reject new PBS activity,
wait for existing tasks, stop PBS services, take the restic snapshot, and always
restart services. Five guest points per backup group and five restic datastore
snapshots are separate retention policies. Never claim those are interchangeable.
Credentials remain in root-only files outside this repository. Recovery requires
the restic password independently of the failed host/Drive archive.

## Deployed pilot details

- PBS endpoint: `https://192.0.2.5:8007`, MAC `BC:24:11:88:FE:88`.
  The address is outside the LAN DHCP pool and was checked against inventory
  and ARP before use. A CT restart confirmed only the static address remains.
- Debian template: `debian-13-standard_13.6-1_amd64.tar.zst`, downloaded and
  checksum-verified by `pveam`. Debian 13's systemd 257 required `nesting=1`
  for its mount units in this unprivileged container.
- PBS datastore: `homelab`, directory `/mnt/datastore/homelab`.
- PVE storage ID: `pbs-pilot`; native token `pve@pbs!pve` has datastore-scoped
  administration rights. Daily application token `apps@pbs!daily` has backup
  rights; ownership controls access to its own groups.
- Restic repository: `rclone:gdrive:Homelab Backups/Backups/PBS`, tag
  `pbs-datastore`. It contains only `/mnt/datastore/homelab` and
  `/etc/proxmox-backup`; recovery-test staging outside `homelab` is excluded.
- Root-only secrets on PVE and CT 101: `/etc/homelab-backup/pbs-pilot/`
  (`pve-token`, `apps-token`, `restic-password`). PVE also has `fingerprint`.
  The existing rclone OAuth configuration was copied privately into CT 101.
  The recovery-kit owner must preserve the restic password independently.

`cloud-backup.sh` is installed as `/usr/local/sbin/pbs-pilot-cloud-backup` inside
CT 101. It runs the disabled scheduled prune job `pilot-keep5` explicitly,
blocks new datastore access, waits for active tasks, stops both PBS services,
and backs up a coherent tree. An exit trap restarts services and clears
maintenance mode even when restic fails. The upload limit is 16,000 KiB/s.
Local PBS data is not client-encrypted; the off-host restic repository is
encrypted. It is not sufficient to keep the restic password inside that same
repository.

Cloud commands explicitly use `RESTIC_CACHE_DIR=/var/cache/restic-pbs-cloud`
(root-owned, mode 0700). `pct exec` does not reliably provide `HOME` or
`XDG_CACHE_HOME`; without this setting restic can run without its metadata
cache. This persistent cache is outside the backed-up trees and separate from
the recovery-test cache. It is disposable and is not required for restoration.

PVE wrappers are `/usr/local/sbin/homelab-pbs-guests` and
`/usr/local/sbin/homelab-pbs-cloud`. They share
`/run/lock/homelab-google-drive-backup.lock` with legacy/application jobs.
A caller already holding that lock must invoke the CT script directly rather
than nesting the locking wrapper. Guest jobs are sequential, with 32 MiB/s
bandwidth limits and low CPU/I/O priority. Subsequent Docker guest jobs exclude
`/var/lib/homelab-app-backup`, whose prepared daily exports are backed up
separately. The first pilot started before that exclusion was added and may
contain a staging copy.

The weekly PBS guest timer is installed but deliberately disabled while the
cloud recovery test is outstanding. Its eventual proposed window is Sunday
04:30 UTC; the job includes cloud copying before releasing the shared lock.
Legacy schedules remain unchanged during the pilot. Normal cloud snapshots
forget all but five restic points; remote pack pruning and native PBS garbage
collection require a separately coordinated maintenance window.

`homelab-pbs-maintenance.timer` is also installed and disabled pending pilot
acceptance. Its proposed window is Sunday 09:00 UTC. The maintenance wrapper
holds the same host lock, runs native prune and garbage collection, creates a
fresh coherent cloud snapshot, and runs bounded restic pack pruning. Worker
commands must exit successfully and print `TASK OK`; an empty active-task list
alone is not treated as successful maintenance. Cloud success is recorded only
after PBS services restart and maintenance mode clears. Weekly guest and
maintenance units report failures through the shared backup monitor.

## Initial native backup evidence

On 2026-09-25, VM 100 completed as `vm/100/2026-09-25T16:04:00Z`
at 16:21:29 UTC. Its 32 GiB logical disk scan took 17 minutes 29 seconds;
19.91 GiB was zero data. CT 300 then started as
`ct/300/2026-09-25T16:21:31Z` and finished successfully at 16:42:19 UTC.
The Docker root archive contains 44.803 GiB logically: 39.795 GiB transferred,
19.875 GiB compressed, 5.008 GiB reused. Its job took 20 minutes 48 seconds.
The temporary LVM backup snapshot was removed normally and the native guest
unit exited successfully. The datastore filesystem then used 23 GiB with
96 GiB available, before the separate application-data upload.

These native results alone do not prove the cloud recovery path; the
independently owned recovery test must pass before the pilot replaces legacy
scheduling. The initial native guest unit intentionally handed its lock to the
queued application backup; that pipeline performs the first coherent cloud
copy containing both guests and the application exports.

The first coherent cloud copy completed at 17:36:28 UTC on 2026-09-25 as
restic snapshot `810ddb76`, containing both guest points above and
`host/apps-300/2026-09-25T16:42:23Z`. It processed 24,217,768,972 bytes in
14,838 files and added 24,079,557,330 packed bytes. PBS services and datastore
access returned healthy. Isolated cloud restoration remains the acceptance
gate; this successful upload alone does not enable the new schedules.

## Cutover checklist

Do not enable these timers until the cloud restore test passes **and** the
operator's planned production reboot sequence is complete.

1. Confirm the cloud snapshot contains both guest groups and the daily app
   exports; retain the successful isolated restore evidence and independent
   recovery keys. Confirm test guests, temporary storage and restore staging
   have been removed by the recovery-test owner.
2. Check PBS services, datastore access, PVE storage status and CT 101's
   effective CPU set (`0-2`) after production reboot. Confirm no backup or
   restoration job holds the shared backup lock.
3. Confirm monitor job `weekly-guests` uses a 194-hour freshness threshold
   and `/var/lib/homelab-backup-monitor/guests-success.json`.
   The receipt is root-only JSON with `completed_utc` in UTC; `groups` and
   `method` describe proof. The permanent wrapper atomically writes it only
   after both guests and the coherent cloud copy succeed. The initial pilot
   receipt must instead be seeded from the first cloud's verified group IDs.
   `pbs-maintenance` uses failure-only monitoring; both units have monitor
   `ExecStopPost` hooks. A busy shared lock returns 75 without refreshing a
   receipt; freshness checks remain responsible for prolonged skips.
4. Coordinate legacy timer retirement with the main backup owner; retain
   existing archives. Enable `homelab-pbs-guests.timer` (Sunday 04:30 UTC) and
   `homelab-pbs-maintenance.timer` (Sunday 09:00 UTC) only after the explicit
   acceptance signal. Their persistent timers may catch up immediately.
5. Read back enabled state and next trigger times. Recheck the first scheduled
   runs through their unit results and receipts, not merely timer activation.

`systemd-analyze verify` accepted the deployed guest/maintenance units and
timers on 2026-09-25. Before cutover, the live monitor intentionally has no
weekly-guest freshness rule while the initial cloud proof is pending; the
application/monitor owner adds it with the first valid receipt.
