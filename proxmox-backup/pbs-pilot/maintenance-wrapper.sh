#!/usr/bin/env bash
set -Eeuo pipefail
exec 9>/run/lock/homelab-google-drive-backup.lock
flock -n 9 || exit 75
exec pct exec 101 -- env PBS_PILOT_MAINTENANCE=1 /usr/local/sbin/pbs-pilot-cloud-backup
