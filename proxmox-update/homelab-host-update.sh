#!/usr/bin/env bash
# Nightly Proxmox host update inside the 04:00-05:00 Europe/Sofia window.
# Installs all package updates and reboots when a newer kernel is installed.
set -euo pipefail

BACKUP_LOCK=/run/lock/homelab-google-drive-backup.lock
DOCKER_CT=300
STATE=/var/lib/homelab-host-update

in_window() { [ "$(TZ=Europe/Sofia date +%H)" = 04 ]; }

# Backups share this lock. Holding it keeps a backup from starting mid-update;
# a backup that is already running makes us skip until the next night.
exec 9>"$BACKUP_LOCK"
if ! flock -n 9; then
  echo "Backup in progress; skipping tonight's update."
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a APT_LISTCHANGES_FRONTEND=none
DPKG_OPTS=(-o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)
APT_OPTS=(-q -o DPkg::Lock::Timeout=600 "${DPKG_OPTS[@]}")

# Package scripts must not inherit the backup lock (fd 9).
dpkg --force-confdef --force-confold --configure -a 9>&-
apt-get "${APT_OPTS[@]}" update 9>&-
plan=$(apt-get "${APT_OPTS[@]}" -s full-upgrade 9>&-)
if grep -q '^Remv ' <<<"$plan"; then
  echo "The upgrade would remove packages; skipping tonight. Review with: apt-get -s full-upgrade"
  exit 1
fi
apt-get "${APT_OPTS[@]}" -y full-upgrade 9>&-

# The newest kernel that can actually boot, not leftover module directories.
running=$(uname -r)
newest=$(find /boot -maxdepth 1 -name 'vmlinuz-*-pve' -printf '%f\n' | sed 's/^vmlinuz-//' | sort -V | tail -n 1)
if [ -z "$newest" ] || [ "$running" = "$newest" ]; then
  echo "Running kernel $running is the newest installed; no reboot needed."
  exit 0
fi

# A previous reboot into this kernel did not take (pinned or chosen kernel):
# do not reboot the router every night.
mkdir -p "$STATE"
if [ "$(cat "$STATE/reboot-target" 2>/dev/null)" = "$newest" ]; then
  echo "Already rebooted for $newest but still running $running; not rebooting again."
  exit 1
fi

# Let the Docker guest finish its own 04:30 package updates before rebooting.
for _ in $(seq 60); do
  pct exec "$DOCKER_CT" -- systemctl is-active --quiet apt-daily-upgrade.service 2>/dev/null || break
  sleep 10
done

if ! in_window; then
  echo "Kernel $newest installed, but the update window has passed; rebooting next night."
  exit 0
fi
echo "$newest" > "$STATE/reboot-target"
echo "Rebooting from kernel $running into $newest."
systemctl reboot
