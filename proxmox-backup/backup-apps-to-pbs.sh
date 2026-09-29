#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Hold the same lock through application backup and coherent cloud replication.
exec 9>/run/lock/homelab-google-drive-backup.lock
flock -w 18000 9 || exit 75

case "${1:-}" in
  '') stage=$(pct exec 300 -- /usr/local/sbin/homelab-app-data-backup prepare) ;;
  --existing) stage=$(pct exec 300 -- /usr/local/sbin/homelab-app-data-backup prepare existing) ;;
  *) echo 'Usage: backup-apps-to-pbs.sh [--existing]' >&2; exit 64 ;;
esac
if [[ -z "$stage" ]]; then
  stage="/var/lib/homelab-app-backup/capture-$(date -u '+%Y%m%dT%H%M%SZ')"
  pct exec 300 -- nice -n 15 ionice -c 3 /usr/local/sbin/homelab-app-data-backup capture "$stage"
fi
pct exec 300 -- nice -n 15 ionice -c 3 /usr/local/sbin/homelab-app-pbs-backup "$stage"
pct exec 101 -- /usr/local/sbin/pbs-pilot-cloud-backup

# Freshness follows the captured data, including retries of an older capture.
captured=$(pct exec 300 -- /usr/local/sbin/homelab-app-data-backup complete "$stage")
python3 - "$captured" <<'PYTHON'
from datetime import datetime,timezone
import json,pathlib,sys
root=pathlib.Path('/var/lib/homelab-backup-monitor')
root.mkdir(mode=0o700,parents=True,exist_ok=True)
temporary=root/'apps-success.new'
temporary.write_text(json.dumps({'completed_utc':sys.argv[1],
    'uploaded_utc':datetime.now(timezone.utc).isoformat()})+'\n')
temporary.replace(root/'apps-success.json')
PYTHON
