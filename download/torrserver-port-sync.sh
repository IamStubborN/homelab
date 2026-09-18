#!/bin/sh
set -eu

TORRSERVER_URL="${TORRSERVER_URL:-http://gluetun-torrserver:8090}"
FORWARDED_PORT_FILE="${FORWARDED_PORT_FILE:-/gluetun/forwarded_port}"
SYNC_STATE_FILE="${SYNC_STATE_FILE:-/tmp/synced_port}"
POLL_INTERVAL="${POLL_INTERVAL:-5}"

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') [torrserver-port-sync] $1"
}

read_forwarded_port() {
    tr -dc '0-9' < "$FORWARDED_PORT_FILE" 2>/dev/null || true
}

read_listen_port() {
    wget -qO- --timeout=5 --header='Content-Type: application/json' \
        --post-data='{"action":"get"}' \
        "${TORRSERVER_URL}/settings" 2>/dev/null \
        | sed -n 's/.*"PeersListenPort":\([0-9]*\).*/\1/p'
}

sync_once() {
    forwarded_port=$(read_forwarded_port)
    if [ -z "$forwarded_port" ] || [ "$forwarded_port" -lt 1 ] || [ "$forwarded_port" -gt 65535 ] 2>/dev/null; then
        log "waiting for a valid forwarded port"
        return 1
    fi

    listen_port=$(read_listen_port)
    if [ -z "$listen_port" ]; then
        log "waiting for TorrServer API"
        return 1
    fi

    if [ "$listen_port" != "$forwarded_port" ]; then
        log "updating PeersListenPort from $listen_port to $forwarded_port"
        sets=$(wget -qO- --timeout=5 --header='Content-Type: application/json' \
            --post-data='{"action":"get"}' \
            "${TORRSERVER_URL}/settings" 2>/dev/null || true)
        if [ -z "$sets" ]; then
            log "failed to read settings before port update"
            return 1
        fi
        sets=$(printf '%s' "$sets" | sed "s/\"PeersListenPort\":[0-9]*/\"PeersListenPort\":${forwarded_port}/")
        printf '{"action":"set","sets":%s}' "$sets" > /tmp/ts-set.json
        wget -qO- --timeout=10 --header='Content-Type: application/json' \
            --post-file=/tmp/ts-set.json \
            "${TORRSERVER_URL}/settings" >/dev/null
        listen_port=$(read_listen_port)
        if [ "$listen_port" != "$forwarded_port" ]; then
            log "failed to verify PeersListenPort=$forwarded_port (actual=$listen_port)"
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
