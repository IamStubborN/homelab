#!/usr/bin/env bash
# Run inside CT 101; caller holds the shared Proxmox backup lock.
set -Eeuo pipefail
umask 077
export RESTIC_REPOSITORY='rclone:gdrive:Homelab Backups/Backups/PBS'
export RESTIC_PASSWORD_FILE=/etc/homelab-backup/pbs-pilot/restic-password
export RESTIC_CACHE_DIR=/var/cache/restic-pbs-cloud
install -d -m 700 -o root -g root "$RESTIC_CACHE_DIR"
export GOMAXPROCS=2
exec 9>/run/lock/pbs-pilot-cloud.lock
flock -n 9 || exit 75
maintenance_changed=0
cleanup() {
  local status=$?
  trap - EXIT
  if (( maintenance_changed )); then
    systemctl start proxmox-backup.service proxmox-backup-proxy.service || status=1
    proxmox-backup-manager datastore update homelab --delete maintenance-mode || status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
wait_for_tasks() {
  local attempts=0
  until proxmox-backup-manager task list --output-format json | jq -e 'length == 0' >/dev/null; do
    (( attempts += 1 ))
    if (( attempts >= 600 )); then
      echo 'PBS tasks did not quiesce within 30 minutes' >&2
      return 1
    fi
    sleep 3
  done
}
run_task_checked() {
  local output
  # PBS manager follows these worker tasks synchronously and prints TASK OK.
  output=$("$@") || { printf '%s\n' "$output" >&2; return 1; }
  printf '%s\n' "$output"
  grep -qx 'TASK OK' <<< "$output" || {
    echo 'PBS maintenance task did not confirm successful completion' >&2
    return 1
  }
}
# A disabled scheduled job is invoked explicitly under the same backup lock.
run_task_checked proxmox-backup-manager prune-job run pilot-keep5
wait_for_tasks
if [[ "${PBS_PILOT_MAINTENANCE:-0}" == 1 ]]; then
  run_task_checked proxmox-backup-manager garbage-collection start homelab
  wait_for_tasks
fi
proxmox-backup-manager datastore update homelab --maintenance-mode offline
maintenance_changed=1
wait_for_tasks
systemctl stop proxmox-backup-proxy.service proxmox-backup.service
sync
restic backup --tag pbs-datastore --limit-upload 16000 \
  /mnt/datastore/homelab /etc/proxmox-backup
restic forget --tag pbs-datastore --group-by host,paths --keep-last 5
# Reclaim remote packs only in the separately scheduled maintenance run.
if [[ "${PBS_PILOT_MAINTENANCE:-0}" == 1 ]]; then
  restic prune --max-unused 5% --max-repack-size 2G --limit-upload 16000
fi
systemctl start proxmox-backup.service proxmox-backup-proxy.service
proxmox-backup-manager datastore update homelab --delete maintenance-mode
maintenance_changed=0
install -d -m 700 /var/lib/homelab-backup
date -u +%FT%TZ > /var/lib/homelab-backup/pbs-cloud-last-success
