#!/usr/bin/env bash
# After a reboot by homelab-host-update, confirm the host came up on the new
# kernel with the router (VM 100), the Docker guest (CT 300) and the internet.
set -euo pipefail

STATE=/var/lib/homelab-host-update
target=$(cat "$STATE/reboot-target" 2>/dev/null || true)
running=$(uname -r)
[ -n "$target" ] || exit 0
if [ -f "$STATE/checked-$target" ]; then
  exit 0
fi
if [ "$running" != "$target" ]; then
  echo "Rebooted for kernel $target but booted $running."
  exit 1
fi

for _ in $(seq 90); do
  if qm status 100 | grep -q 'status: running' &&
     pct status 300 | grep -q 'status: running' &&
     ping -c 1 -W 3 1.1.1.1 >/dev/null 2>&1; then
    touch "$STATE/checked-$target"
    echo "Kernel $running is up with OPNsense, the Docker guest and the internet."
    exit 0
  fi
  sleep 10
done
echo "After 15 minutes on kernel $running, OPNsense, the Docker guest or the internet is still down."
exit 1
