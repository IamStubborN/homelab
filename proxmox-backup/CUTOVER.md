# Backup schedule cutover

Prepared on September 25, 2026 (UTC). This is an execution checklist, not
evidence that the schedule cutover has happened. Production OPNsense and Proxmox
reboot checks have passed. After the reported Plex outage, Plex and all 59
containers were confirmed healthy. The user forbids further production downtime;
no additional production stop or reboot is part of this cutover.

The targeted actual-data app restoration passed all 31 SQLite and three
PostgreSQL checks with the documented recovery-only `search_path` workaround.
The complete final cloud-to-guests-to-apps pipeline still has no acceptance
receipt. Keep replacement timers and quarterly freshness disabled until that
full run succeeds, temporary guests/storage are cleaned up, and cutover is
explicitly released. No additional cloud backup job is part of this checklist.

Fresh post-reboot small exports were uploaded and downloaded back for checksum
and content validation: OPNsense `2026_09_25-20_59_44` (38,285 bytes) and host
`2026_09_25-21_00_11` (195,072 bytes). The host inventory records the running
`7.0.14-19-pve` kernel and startup ordering VM 100 `order=1,up=150`, CT 101
`order=2,up=30`, CT 300 `order=3,up=20`. Both success records are fresh; five
small archives of each type are retained. See [README](README.md) for hashes.

## Verified live state

At 18:45 UTC on September 25:

- Daily apps, weekly PBS guests, weekly PBS maintenance and quarterly restoration
  timers were disabled and inactive, with no persistent timestamp files.
- Legacy full OPNsense and Docker timers were enabled. Their last persistent
  triggers were September 20 at 04:00 UTC and September 6 at 05:00 UTC. Their next
  occurrences are September 27 at 04:00 UTC and October 4 at 05:00 UTC.
- The host configuration timer last triggered September 20 at 03:30 UTC; its
  next occurrence is September 27 at 03:30 UTC.
- Therefore, a short reboot in the current Friday/Saturday window does not
  create a missed heavy legacy backup occurrence. Reassess if work crosses the
  Sunday schedule boundary or the host clock changes substantially.
- OPNsense configuration is next due September 26 at 02:20 UTC, with up to two
  minutes of random delay. The hourly monitor can catch up after a reboot; it
  does not start backups.
- No additional backup cron entry or native Proxmox backup job was found. The
  PBS `pilot-keep5` prune job is disabled and runs explicitly inside the wrapper.
- Proxmox uses `America/Toronto`, so plain `systemctl list-timers` displays EDT.
  Backup calendars explicitly specify UTC. This display timezone does not change
  those schedules. The hourly monitor runs at the top of every hour in either
  timezone, plus up to five minutes of random delay.

PBS guest, cloud and maintenance services must be ordered after
`pve-guests.service` before activation. Daily apps, monitoring and restoration
already have that ordering. `After=` prevents a boot-time persistent catch-up
from racing guest startup; it does not prove guest application readiness.

## Intended schedule

Sofia uses UTC+3 in summer and UTC+2 in winter. UTC schedules stay fixed.
The first-occurrence column assumes activation before September 26 at 02:20 UTC.

| Job | Timer | UTC | Sofia summer / winter | First planned occurrence after this cutover |
| --- | --- | --- | --- | --- |
| OPNsense configuration, retained | `homelab-backup-opnsense-config.timer` | Daily 02:20, +0–2 min | 05:20 / 04:20 | September 26, 05:20 Sofia |
| Daily application data + cloud | `homelab-backup-apps.timer` | Daily 02:40, +0–2 min | 05:40 / 04:40 | September 26, 05:40 Sofia |
| Host configuration, retained | `homelab-backup-host-config.timer` | Sunday 03:30 | 06:30 / 05:30 | September 27, 06:30 Sofia |
| Full OPNsense + Docker + cloud | `homelab-pbs-guests.timer` | Sunday 04:30 | 07:30 / 06:30 | September 27, 07:30 Sofia |
| PBS GC + restic maintenance | `homelab-pbs-maintenance.timer` | Sunday 09:00 | 12:00 / 11:00 | September 27, 12:00 Sofia |
| Complete isolated restoration | `homelab-restore-validation.timer` | Jan/Apr/Jul/Oct 15, 08:00, +0–10 min | 11:00 / 10:00 | October 15, 11:00 Sofia |
| Failure/freshness monitor, retained | `homelab-backup-monitor.timer` | Hourly, +0–5 min | Every hour, +0–5 min | Next hour |

Systemd's default timer accuracy can add roughly another minute of scheduling
coalescing. These are target windows, not exact-second start promises.

All heavy wrappers share one lock. Daily apps wait for it for up to five hours.
Scheduled restoration (`--run`) queues for up to two hours and fails with an
alertable result if that deadline expires; only its read-only preflight uses
exit 75 when the lock is busy. Weekly guests and maintenance can skip with exit
75 if another pipeline still owns the lock. This avoids overlap but means a
delayed Sunday backup can cause that week's maintenance to be skipped. Freshness
monitoring detects missed recovery points; maintenance is intentionally
failure-only. No independent cloud timer should be added: cloud copying belongs
to each successful backup pipeline.

## Execution after final isolated acceptance is released

Production reboot checks are already complete; do not repeat them. Run the
following on Proxmox as root only after acceptance is released. First inspect
receipts, service results,
guest health and the next trigger times again. A passing upload alone is not a
passing restoration. The quarterly receipt must come from the complete validator.

```sh
systemctl show homelab-restore-validation.service -p ActiveState -p Result
systemctl list-jobs --no-pager
systemctl show homelab-backup-apps.service homelab-pbs-guests.service \
  homelab-pbs-maintenance.service homelab-restore-validation.service -p Id -p After

python3 - <<'PY'
from datetime import datetime, timezone
import json
from pathlib import Path
receipts = {
    'daily-apps': (Path('/var/lib/homelab-backup-monitor/apps-success.json'), 50),
    'weekly-guests': (Path('/var/lib/homelab-backup-monitor/guests-success.json'), 194),
    'quarterly-restore': (Path('/var/lib/homelab-backup/restore-validation/last-success.json'), 2306),
}
now = datetime.now(timezone.utc)
for name, (path, maximum_hours) in receipts.items():
    receipt = json.loads(path.read_text())
    completed = datetime.fromisoformat(receipt['completed_utc'])
    assert completed.tzinfo is not None, name
    assert 0 <= (now - completed).total_seconds() <= maximum_hours * 3600, name
    print(name, completed.isoformat())
PY
```

Then perform the schedule/configuration change under the shared lock. These
commands preserve archives and the existing small-backup schedules.

```sh
set -euo pipefail
exec 9>/run/lock/homelab-google-drive-backup.lock
flock -n 9

systemctl disable --now homelab-backup-opnsense.timer homelab-backup-docker.timer

python3 - <<'PY'
import json, os
from pathlib import Path
os.umask(0o077)
path = Path('/etc/homelab-backup/monitor.json')
config = json.loads(path.read_text())
jobs = config['jobs']
for name in ('opnsense', 'docker'):
    jobs.pop(name, None)
jobs.update({
    'daily-apps': {
        'success_file': '/var/lib/homelab-backup-monitor/apps-success.json',
        'max_age_hours': 50,
    },
    'weekly-guests': {
        'success_file': '/var/lib/homelab-backup-monitor/guests-success.json',
        'max_age_hours': 194,
    },
    'quarterly-restore': {
        'success_file': '/var/lib/homelab-backup/restore-validation/last-success.json',
        'max_age_hours': 2306,
    },
})
assert all(name in jobs for name in ('opnsense-config', 'host-config', 'pbs-maintenance'))
temporary = path.with_suffix('.new')
temporary.write_text(json.dumps(config, indent=2) + '\n')
temporary.chmod(0o600)
temporary.replace(path)
PY

systemctl enable --now homelab-backup-apps.timer homelab-pbs-guests.timer \
  homelab-pbs-maintenance.timer homelab-restore-validation.timer

flock -u 9
exec 9>&-
systemctl start homelab-backup-monitor.service
TZ=UTC systemctl list-timers --all --no-pager 'homelab*'
systemctl list-unit-files --no-pager 'homelab*timer'
systemctl show homelab-backup-monitor.service -p Result
```

Read back the next triggers, disabled legacy timers, enabled replacement timers,
six monitor jobs and healthy monitor result. Update `monitor.example.json` and
README to the applied state and synchronize source files only after this succeeds.
Do not change receipt timestamps to suppress real failures or delete legacy
archives during this cutover.

All calendar timers are persistent. At a later reboot, a genuinely missed
occurrence can trigger a catch-up. Newly enabled timers here have no old stamp;
systemd starts their calendar calculation from activation time rather than
replaying every past occurrence. This matches the installed systemd 257 behavior
in the [systemd timer implementation](https://github.com/systemd/systemd/blob/v257/src/core/timer.c).
If timestamps appear before activation, inspect them instead of assuming this
first-activation behavior still applies. Do not delete existing legacy timer
stamps to hide overdue work.
