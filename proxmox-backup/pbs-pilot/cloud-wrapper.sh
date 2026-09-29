#!/usr/bin/env bash
# Proxmox entry point; serialize with legacy backups and daily app capture.
set -Eeuo pipefail
exec 9>/run/lock/homelab-google-drive-backup.lock
flock -n 9 || exit 75
exec pct exec 101 -- /usr/local/sbin/pbs-pilot-cloud-backup
