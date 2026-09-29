#!/usr/bin/env bash
# Proxmox host; full logical recovery points, deduplicated by PBS.
set -Eeuo pipefail
umask 077
exec 9>/run/lock/homelab-google-drive-backup.lock
flock -n 9 || exit 75
vzdump 100 --storage pbs-pilot --mode snapshot --bwlimit 32768 \
  --performance max-workers=1 --remove 0 --notes-template 'OPNsense PBS pilot'
(
  umask 022
  vzdump 300 --storage pbs-pilot --mode snapshot --bwlimit 32768 \
    --tmpdir /var/tmp --exclude-path /var/lib/homelab-app-backup --remove 0 --notes-template 'Docker PBS pilot; external mounts excluded'
)
# Keep the shared lock across cloud copying; do not call the locking wrapper.
pct exec 101 -- /usr/local/sbin/pbs-pilot-cloud-backup
python3 - <<'RECEIPT'
import datetime, json, os
from pathlib import Path
root = Path('/var/lib/homelab-backup-monitor')
root.mkdir(mode=0o700, parents=True, exist_ok=True)
receipt = root / 'guests-success.json'
temporary = root / '.guests-success.json.tmp'
temporary.write_text(json.dumps({
    'completed_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'groups': ['vm/100', 'ct/300'],
    'method': 'Native PBS guest backups followed by coherent encrypted cloud copy',
}) + '\n')
temporary.chmod(0o600)
os.replace(temporary, receipt)
RECEIPT
