#!/bin/sh
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/bin"
cat > "$TMP/bin/wget" <<'EOF'
#!/bin/sh
args="$*"
case "$args" in
  *'/api/v2/app/preferences'*)
    port=40947
    test ! -f "$WGET_STATE" || port=$(cat "$WGET_STATE")
    printf '{"listen_port":%s}\n' "$port"
    ;;
  *'/api/v2/app/setPreferences'*)
    printf '%s\n' "$args" > "$WGET_MARKER"
    printf '%s\n' 62938 > "$WGET_STATE"
    ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$TMP/bin/wget"
printf '%s\n' 62938 > "$TMP/forwarded_port"

PATH="$TMP/bin:$PATH" \
WGET_MARKER="$TMP/request" \
WGET_STATE="$TMP/qbit-port" \
FORWARDED_PORT_FILE="$TMP/forwarded_port" \
SYNC_STATE_FILE="$TMP/synced_port" \
QBITTORRENT_URL=http://qbittorrent:8400 \
  "$ROOT/media/qbittorrent/scripts/port-sync.sh" --once

grep -q 'listen_port.*62938' "$TMP/request"
test "$(cat "$TMP/synced_port")" = 62938
