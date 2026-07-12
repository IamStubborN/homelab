#!/bin/sh

# qBittorrent Health Check — tuned for ProtonVPN port forwarding.
#
# Hard failures (container will be restarted by deunhealth):
#   1. WebUI not responding
#   2. connection_status=disconnected — qBittorrent's own netstack is broken
#   3. Gluetun control API doesn't return a public IP — VPN side is dead
#   4. IP leak: qBittorrent's external IP disagrees with the VPN IP
#   5. qBittorrent listen_port differs from ProtonVPN's forwarded port
#   6. Active torrents exist but qBittorrent has no network signal
#      (dht_nodes=0, peers=0, no external IP) for longer than GRACE_PERIOD
#
# Benign states (NOT failures):
#   - dht_nodes=0 with 0 active torrents — libtorrent sleeps DHT when idle

WEBUI_PORT=8400
GLUETUN_API="http://localhost:8000"
# The Gluetun control server now requires an apikey. Sourced from a Docker
# secret mounted into this container; must equal the key in the Gluetun auth
# config. A missing key is a hard failure — without it we cannot confirm the
# VPN public IP, and silently passing would defeat the leak detector.
GLUETUN_API_KEY_FILE="/run/secrets/gluetun_control_api_key"
FORWARDED_PORT_FILE="/gluetun/forwarded_port"
STATE_FILE="/config/healthcheck_stuck_since"
GRACE_PERIOD_SECONDS=300  # 5 minutes before declaring a stuck qBT unhealthy

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') - $1"; }
mark_healthy() { rm -f "$STATE_FILE" 2>/dev/null || true; }

QB_INFO=$(wget -qO- --timeout=5 "http://localhost:${WEBUI_PORT}/api/v2/transfer/info" 2>/dev/null) || true
if [ -z "$QB_INFO" ]; then
    log "FAIL: qBittorrent API not responding"
    exit 1
fi

CONNECTION_STATUS=$(echo "$QB_INFO" | sed -n 's/.*"connection_status":"\([^"]*\)".*/\1/p')
DHT_NODES=$(echo "$QB_INFO" | sed -n 's/.*"dht_nodes":\([0-9]*\).*/\1/p')
DHT_NODES=${DHT_NODES:-0}
PEERS=$(echo "$QB_INFO" | sed -n 's/.*"total_peer_connections":\([0-9]*\).*/\1/p')
PEERS=${PEERS:-0}
QB_EXTERNAL_IP=$(echo "$QB_INFO" | sed -n 's/.*"last_external_address_v4":"\([^"]*\)".*/\1/p')

if [ "$CONNECTION_STATUS" = "disconnected" ]; then
    log "FAIL: connection_status=disconnected"
    exit 1
fi

GLUETUN_API_KEY=$(tr -d '\r\n' < "$GLUETUN_API_KEY_FILE" 2>/dev/null || true)
if [ -z "$GLUETUN_API_KEY" ]; then
    log "FAIL: Gluetun control API key missing ($GLUETUN_API_KEY_FILE)"
    exit 1
fi

VPN_IP=$(wget -qO- --timeout=5 --header="X-API-Key: ${GLUETUN_API_KEY}" "${GLUETUN_API}/v1/publicip/ip" 2>/dev/null \
    | sed -n 's/.*"public_ip":"\([^"]*\)".*/\1/p')
if [ -z "$VPN_IP" ]; then
    log "FAIL: Gluetun public IP unavailable"
    exit 1
fi

if [ -n "$QB_EXTERNAL_IP" ] && [ "$QB_EXTERNAL_IP" != "$VPN_IP" ]; then
    log "FAIL: IP leak — qBT=$QB_EXTERNAL_IP VPN=$VPN_IP"
    exit 1
fi

FORWARDED_PORT=$(tr -dc '0-9' < "$FORWARDED_PORT_FILE" 2>/dev/null || true)
if [ -z "$FORWARDED_PORT" ] || [ "$FORWARDED_PORT" -lt 1 ] || [ "$FORWARDED_PORT" -gt 65535 ] 2>/dev/null; then
    log "FAIL: ProtonVPN forwarded port unavailable"
    exit 1
fi

QB_PREFS=$(wget -qO- --timeout=5 "http://localhost:${WEBUI_PORT}/api/v2/app/preferences" 2>/dev/null) || true
LISTEN_PORT=$(echo "$QB_PREFS" | sed -n 's/.*"listen_port":\([0-9]*\).*/\1/p')
if [ "$LISTEN_PORT" != "$FORWARDED_PORT" ]; then
    log "FAIL: listen_port=$LISTEN_PORT forwarded_port=$FORWARDED_PORT"
    exit 1
fi

# Count torrents that should be actively talking to the network.
# Exclude paused, queued, errored, checking, or moving states.
TORRENTS=$(wget -qO- --timeout=5 "http://localhost:${WEBUI_PORT}/api/v2/torrents/info" 2>/dev/null) || true
ACTIVE=$(echo "$TORRENTS" \
    | grep -o '"state":"[^"]*"' \
    | grep -vcE '"state":"(pausedUP|pausedDL|queuedDL|queuedUP|error|missingFiles|checkingUP|checkingDL|checkingResumeData|moving|unknown)"')

if [ "$ACTIVE" -eq 0 ]; then
    mark_healthy
    log "OK: idle (active=0) conn=$CONNECTION_STATUS port=$LISTEN_PORT VPN=$VPN_IP"
    exit 0
fi

# Active torrents exist — we can judge connectivity.
# Any positive signal (DHT, peers, or a learned external IP) means qBT is alive.
if [ "$DHT_NODES" -gt 0 ] || [ "$PEERS" -gt 0 ] || [ -n "$QB_EXTERNAL_IP" ]; then
    mark_healthy
    log "OK: active=$ACTIVE conn=$CONNECTION_STATUS port=$LISTEN_PORT DHT=$DHT_NODES peers=$PEERS VPN=$VPN_IP"
    exit 0
fi

# Active torrents but zero network signals → qBT is effectively offline.
NOW=$(date +%s)
if [ -f "$STATE_FILE" ]; then
    SINCE=$(cat "$STATE_FILE" 2>/dev/null || echo "$NOW")
    DURATION=$((NOW - SINCE))
    if [ "$DURATION" -ge "$GRACE_PERIOD_SECONDS" ]; then
        log "FAIL: active=$ACTIVE DHT=0 peers=0 no-external-IP for ${DURATION}s — restart needed"
        exit 1
    fi
    log "WARN: active=$ACTIVE stuck ${DURATION}s/${GRACE_PERIOD_SECONDS}s"
else
    echo "$NOW" > "$STATE_FILE"
    log "WARN: active=$ACTIVE DHT=0 peers=0 no-external-IP — grace period started"
fi
exit 0
