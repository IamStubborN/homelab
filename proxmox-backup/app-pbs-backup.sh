#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

stage=${1:?Usage: app-pbs-backup.sh CAPTURE_DIRECTORY}
case "$stage" in
  /var/lib/homelab-app-backup/current|/var/lib/homelab-app-backup/capture-*) ;;
  *) echo 'Unexpected application capture path' >&2; exit 64 ;;
esac
python3 - "$stage" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]).resolve()
assert p.parent==pathlib.Path('/var/lib/homelab-app-backup')
manifest=json.loads((p/'manifest.json').read_text())
assert manifest['completed_utc'] and manifest['postgres'] and manifest['sqlite']
assert manifest['external_disks_included'] is False
PY
PBS_REPOSITORY=${PBS_REPOSITORY:-$(cat /etc/homelab-backup/pbs-pilot/apps-repository)}
export PBS_REPOSITORY
export PBS_PASSWORD_FILE=/etc/homelab-backup/pbs-pilot/apps-token
PBS_FINGERPRINT=$(sed 's/.*=//' /etc/homelab-backup/pbs-pilot/fingerprint)
export PBS_FINGERPRINT
exec /usr/local/bin/proxmox-backup-client-pilot backup "apps.pxar:$stage" \
  --backup-type host --backup-id apps-300 --crypt-mode none
