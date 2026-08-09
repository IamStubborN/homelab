#!/bin/sh
set -eu

QBITTORRENT_URL="${QBITTORRENT_URL:-http://gluetun:8400}"
FORWARDED_PORT_FILE="${FORWARDED_PORT_FILE:-/gluetun/forwarded_port}"
SYNC_STATE_FILE="${SYNC_STATE_FILE:-/tmp/synced_port}"
POLL_INTERVAL="${POLL_INTERVAL:-5}"

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') [qbit-port-sync] $1"
}

read_forwarded_port() {
    tr -dc '0-9' < "$FORWARDED_PORT_FILE" 2>/dev/null || true
}

read_listen_port() {
    wget -qO- --timeout=5 "${QBITTORRENT_URL}/api/v2/app/preferences" 2>/dev/null \
        | sed -n 's/.*"listen_port":\([0-9]*\).*/\1/p'
}

sync_once() {
    forwarded_port=$(read_forwarded_port)
    if [ -z "$forwarded_port" ] || [ "$forwarded_port" -lt 1 ] || [ "$forwarded_port" -gt 65535 ] 2>/dev/null; then
        log "waiting for a valid forwarded port"
        return 1
    fi

    listen_port=$(read_listen_port)
    if [ -z "$listen_port" ]; then
        log "waiting for qBittorrent API"
        return 1
    fi

    if [ "$listen_port" != "$forwarded_port" ]; then
        log "updating listen_port from $listen_port to $forwarded_port"
        wget -qO- --timeout=5 --post-data "json={\"listen_port\":${forwarded_port}}" \
            "${QBITTORRENT_URL}/api/v2/app/setPreferences" >/dev/null
        listen_port=$(read_listen_port)
        if [ "$listen_port" != "$forwarded_port" ]; then
            log "failed to verify listen_port=$forwarded_port (actual=$listen_port)"
            return 1
        fi
    fi

    printf '%s\n' "$forwarded_port" > "$SYNC_STATE_FILE"
    return 0
}

if [ "${1:-}" = "--once" ]; then
    sync_once
    exit
fi

log "starting (poll=${POLL_INTERVAL}s)"
while true; do
    sync_once || true
    sleep "$POLL_INTERVAL"
done
