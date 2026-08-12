#!/bin/sh

# Gluetun Health Check — VPN-only.
#
# Verifies that the tunnel itself is up. qBittorrent's health is qBittorrent's
# problem and lives in its own healthcheck — coupling them here caused a
# cascade (qBT stuck => Gluetun fails => both restart => qBT stuck again).

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $1"
}

if ! ip link show tun0 >/dev/null 2>&1; then
    log "FAIL: tun0 interface not found"
    exit 1
fi

if ! ip link show tun0 | grep -q "UP"; then
    log "FAIL: tun0 interface is DOWN"
    exit 1
fi

VPN_IP=$(wget -qO- --timeout=5 https://api.ipify.org 2>/dev/null || echo "")
if ! echo "$VPN_IP" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
    log "FAIL: cannot reach external IP service (got: '$VPN_IP')"
    exit 1
fi

log "OK: tun0 UP, VPN IP=$VPN_IP"
exit 0
