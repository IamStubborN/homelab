#!/bin/sh
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/state"

cat > "$TMP/bin/wget" <<'EOF'
#!/bin/sh
case "$*" in
  *'/api/v2/transfer/info'*) printf '%s\n' '{"connection_status":"connected","dht_nodes":10,"total_peer_connections":1,"last_external_address_v4":"10.2.0.1"}' ;;
  *'/v1/publicip/ip'*) printf '%s\n' '{"public_ip":"10.2.0.1"}' ;;
  *'/api/v2/app/preferences'*) printf '%s\n' '{"listen_port":40947}' ;;
  *'/api/v2/torrents/info'*) printf '%s\n' '[]' ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$TMP/bin/wget"
printf '%s\n' secret > "$TMP/api-key"
printf '%s\n' 62938 > "$TMP/forwarded_port"

PATH="$TMP/bin:$PATH" \
GLUETUN_API_KEY_FILE="$TMP/api-key" \
FORWARDED_PORT_FILE="$TMP/forwarded_port" \
HEALTH_STATE_DIR="$TMP/state" \
  "$ROOT/media/qbittorrent/scripts/healthcheck.sh"

test -s "$TMP/state/port_mismatch_since"
