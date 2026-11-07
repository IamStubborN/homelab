#!/usr/bin/env bash
# After a reboot by homelab-host-update, confirm the host came up on the new
# kernel with the configured router VM, Docker container and internet probe.
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

: "${ROUTER_VM_ID:?Set ROUTER_VM_ID in the private Proxmox environment}"
: "${DOCKER_CT_ID:?Set DOCKER_CT_ID in the private Proxmox environment}"
[[ "$ROUTER_VM_ID" =~ ^[1-9][0-9]*$ && "$DOCKER_CT_ID" =~ ^[1-9][0-9]*$ ]] || exit 64

for _ in $(seq 90); do
  if qm status "$ROUTER_VM_ID" | grep -q 'status: running' &&
     pct status "$DOCKER_CT_ID" | grep -q 'status: running' &&
     ping -c 1 -W 3 1.1.1.1 >/dev/null 2>&1; then
    touch "$STATE/checked-$target"
    echo "Kernel $running is up with OPNsense, the Docker guest and the internet."
    exit 0
  fi
  sleep 10
done
echo "After 15 minutes on kernel $running, OPNsense, the Docker guest or the internet is still down."
exit 1
