#!/bin/sh

set -eu

STATE_DIR="${STATE_DIR:-/conf/pritunl-native/state}"
VPN_INTERFACE="${VPN_INTERFACE:-ovpnc1}"
PF_TABLE="${PF_TABLE:-PRITUNL_CORPORATE_ROUTES}"
ROUTES_FILE="$STATE_DIR/corporate-routes.txt"

mkdir -p "$STATE_DIR"
chmod 0700 "$STATE_DIR"

load_table() {
    [ -s "$ROUTES_FILE" ] || return 0
    /sbin/pfctl -t "$PF_TABLE" -T replace -f "$ROUTES_FILE" >/dev/null
}

refresh_routes() {
    tmp="$STATE_DIR/corporate-routes.tmp"
    /usr/bin/netstat -rn -f inet |
        /usr/bin/awk -v vpn_if="$VPN_INTERFACE" '
            $1 != "Destination" && $1 != "default" && $NF == vpn_if {
                if ($1 ~ /^[0-9]+(\.[0-9]+){3}(\/[0-9]+)?$/) print $1
            }
        ' |
        /usr/bin/sort -u > "$tmp"

    count="$(/usr/bin/wc -l < "$tmp" | /usr/bin/tr -d ' ')"
    if [ "$count" -eq 0 ]; then
        rm -f "$tmp"
        printf 'No IPv4 routes found on %s.\n' "$VPN_INTERFACE" >&2
        exit 1
    fi

    chmod 0600 "$tmp"
    mv -f "$tmp" "$ROUTES_FILE"
    load_table
    printf 'routes=%s table=%s\n' "$count" "$PF_TABLE"
}

case "${1:-restore}" in
    refresh) refresh_routes ;;
    restore) load_table ;;
    *) printf 'Usage: route-table.sh {refresh|restore}\n' >&2; exit 64 ;;
esac
