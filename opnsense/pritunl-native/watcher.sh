#!/bin/sh

set -eu

umask 077

INSTANCE_UUID="${INSTANCE_UUID:-6387ef44-4e9a-4c79-af35-c829c2eb0766}"
VPN_ID="${VPN_ID:-1}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-3}"
MIN_RETRY_INTERVAL_SECONDS="${MIN_RETRY_INTERVAL_SECONDS:-3600}"
CONNECT_TIMEOUT_SECONDS="${CONNECT_TIMEOUT_SECONDS:-45}"
PING_EXIT_SECONDS="${PING_EXIT_SECONDS:-120}"
SIMULATE_AUTH_FAILURE="${SIMULATE_AUTH_FAILURE:-false}"
VALIDATE_ONLY="${VALIDATE_ONLY:-false}"

BASE_DIR="${BASE_DIR:-/conf/pritunl-native}"
SECRET_DIR="${SECRET_DIR:-$BASE_DIR/secrets}"
STATE_DIR="${STATE_DIR:-$BASE_DIR/state}"
RUN_DIR="${RUN_DIR:-/var/run/pritunl-native}"
LOG_DIR="${LOG_DIR:-/var/log/pritunl-native}"
USERNAME_FILE="${USERNAME_FILE:-$SECRET_DIR/username}"
PIN_FILE="${PIN_FILE:-$SECRET_DIR/pin}"
TOTP_SEED_FILE="${TOTP_SEED_FILE:-$SECRET_DIR/totp-seed}"
RENDERER="${RENDERER:-/usr/local/opnsense/scripts/pritunl-native/render-instance.php}"
EVENT_HOOK="${EVENT_HOOK:-/usr/local/opnsense/scripts/pritunl-native/openvpn-event-hook}"
OPENVPN_BIN="${OPENVPN_BIN:-/usr/local/sbin/openvpn}"
OATHTOOL_BIN="${OATHTOOL_BIN:-/usr/local/bin/oathtool}"
ROUTE_TABLE_HELPER="${ROUTE_TABLE_HELPER:-/usr/local/opnsense/scripts/pritunl-native/route-table.sh}"
export STATE_DIR

CONFIG_FILE="/var/etc/openvpn/instance-${INSTANCE_UUID}.conf"
UP_FILE="/var/etc/openvpn/instance-${INSTANCE_UUID}.up"
WATCHER_LOG="$LOG_DIR/watcher.log"
OPENVPN_LOG="$LOG_DIR/openvpn.log"
EVENT_LOG="$LOG_DIR/events.log"
FAILURES_FILE="$STATE_DIR/failures-since-reset"
CONSECUTIVE_FILE="$STATE_DIR/consecutive-failures"
LAST_ATTEMPT_FILE="$STATE_DIR/last-attempt"
LOCKOUT_FILE="$STATE_DIR/lockout"
CONNECTED_FILE="$RUN_DIR/connected"
PASSWORD_FILE="$RUN_DIR/password"

mkdir -p "$SECRET_DIR" "$STATE_DIR" "$RUN_DIR" "$LOG_DIR"
chmod 0700 "$BASE_DIR" "$SECRET_DIR" "$STATE_DIR" "$RUN_DIR"
chmod 0750 "$LOG_DIR"
touch "$WATCHER_LOG" "$EVENT_LOG"
chmod 0640 "$WATCHER_LOG" "$EVENT_LOG" 2>/dev/null || true

log() {
    line="$(date -u +%FT%TZ) $*"
    printf '%s\n' "$line" | tee -a "$WATCHER_LOG"
}

event() {
    printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$EVENT_LOG"
}

read_number() {
    file="$1"
    if [ -r "$file" ]; then
        value="$(sed -n '1p' "$file")"
        case "$value" in
            ''|*[!0-9]*) printf '0\n' ;;
            *) printf '%s\n' "$value" ;;
        esac
    else
        printf '0\n'
    fi
}

write_number() {
    printf '%s\n' "$2" > "$1"
    chmod 0600 "$1"
}

cleanup_runtime() {
    rm -f "$PASSWORD_FILE" "$CONNECTED_FILE"
}

trap cleanup_runtime EXIT INT TERM

"$ROUTE_TABLE_HELPER" restore

if [ -e "$LOCKOUT_FILE" ]; then
    log "lockout-active; run vpnctl reset before starting"
    exit 78
fi

for required in "$USERNAME_FILE" "$PIN_FILE" "$TOTP_SEED_FILE"; do
    if [ ! -r "$required" ]; then
        log "missing-secret file=$required"
        exit 66
    fi
done

generate_password() {
    seed="$(tr -d '[:space:]-' < "$TOTP_SEED_FILE")"
    case "$seed" in
        ''|*[!A-Za-z2-7=]*) log "invalid-totp-seed"; return 1 ;;
    esac
    otp="$($OATHTOOL_BIN --totp -b "@$TOTP_SEED_FILE")" || return 1
    pin="$(tr -d '\r\n' < "$PIN_FILE")"
    printf '%s%s\n' "$pin" "$otp" > "$PASSWORD_FILE"
    chmod 0600 "$PASSWORD_FILE"
}

prepare_interface() {
    if ! /sbin/ifconfig "ovpnc${VPN_ID}" >/dev/null 2>&1; then
        /sbin/ifconfig "tun${VPN_ID}" create
        /sbin/ifconfig "tun${VPN_ID}" name "ovpnc${VPN_ID}"
        /sbin/ifconfig "ovpnc${VPN_ID}" group openvpn
    fi
    /sbin/ifconfig "ovpnc${VPN_ID}" down >/dev/null 2>&1 || true
}

render_config() {
    generate_password
    /usr/local/bin/php "$RENDERER" "$INSTANCE_UUID" "$PASSWORD_FILE"
    rm -f "$PASSWORD_FILE"
    chmod 0600 "$CONFIG_FILE" "$UP_FILE"

    /usr/bin/sed -i '' \
        -e '/^daemon /d' \
        -e '/^management /d' \
        -e '/^writepid /d' \
        -e '/^up /d' \
        -e '/^down /d' \
        -e '/^keepalive /d' \
        "$CONFIG_FILE"

    {
        printf 'connect-retry-max 1\n'
        printf 'resolv-retry 0\n'
        printf 'single-session\n'
        printf 'auth-retry nointeract\n'
        printf 'ping 10\n'
        printf 'ping-exit %s\n' "$PING_EXIT_SECONDS"
        printf 'tls-exit\n'
        printf 'remap-usr1 SIGTERM\n'
        printf 'up %s\n' "$EVENT_HOOK"
        printf 'down %s\n' "$EVENT_HOOK"
    } >> "$CONFIG_FILE"
}

if [ "$VALIDATE_ONLY" = "true" ]; then
    render_config
    grep -q '^remote atl-core-ovpn\.atlas-iac\.net 14290$' "$CONFIG_FILE"
    grep -q '^<tls-auth>$' "$CONFIG_FILE"
    grep -q '^key-direction 1$' "$CONFIG_FILE"
    grep -q '^connect-retry-max 1$' "$CONFIG_FILE"
    grep -q '^single-session$' "$CONFIG_FILE"
    rm -f "$CONFIG_FILE" "$UP_FILE"
    log "validation-only-pass"
    exit 0
fi

wait_for_retry_window() {
    last="$(read_number "$LAST_ATTEMPT_FILE")"
    now="$(date +%s)"
    next=$((last + MIN_RETRY_INTERVAL_SECONDS))
    if [ "$last" -gt 0 ] && [ "$now" -lt "$next" ]; then
        delay=$((next - now))
        log "retry-wait seconds=$delay"
        sleep "$delay"
    fi
}

record_failure() {
    total=$(( $(read_number "$FAILURES_FILE") + 1 ))
    consecutive=$(( $(read_number "$CONSECUTIVE_FILE") + 1 ))
    write_number "$FAILURES_FILE" "$total"
    write_number "$CONSECUTIVE_FILE" "$consecutive"
    event "attempt-failed total=$total consecutive=$consecutive"
    log "attempt-failed total=$total max=$MAX_ATTEMPTS"
    if [ "$total" -ge "$MAX_ATTEMPTS" ]; then
        printf '%s\n' "$(date -u +%FT%TZ)" > "$LOCKOUT_FILE"
        chmod 0600 "$LOCKOUT_FILE"
        event "lockout total=$total"
        log "lockout-entered"
        exit 78
    fi
}

while :; do
    wait_for_retry_window
    attempt_started="$(date +%s)"
    write_number "$LAST_ATTEMPT_FILE" "$attempt_started"
    attempt_number=$(( $(read_number "$FAILURES_FILE") + 1 ))
    event "attempt-start number=$attempt_number max=$MAX_ATTEMPTS"
    log "attempt-start number=$attempt_number max=$MAX_ATTEMPTS"
    rm -f "$CONNECTED_FILE"

    if [ "$SIMULATE_AUTH_FAILURE" = "true" ]; then
        sleep 1
        record_failure
        continue
    fi

    prepare_interface
    render_config
    export PRITUNL_RUN_DIR="$RUN_DIR" PRITUNL_EVENT_LOG="$EVENT_LOG"
    "$OPENVPN_BIN" --config "$CONFIG_FILE" --log-append "$OPENVPN_LOG" &
    openvpn_pid=$!

    elapsed=0
    while kill -0 "$openvpn_pid" 2>/dev/null && [ ! -e "$CONNECTED_FILE" ] && [ "$elapsed" -lt "$CONNECT_TIMEOUT_SECONDS" ]; do
        sleep 1
        elapsed=$((elapsed + 1))
    done

    if [ ! -e "$CONNECTED_FILE" ]; then
        kill -TERM "$openvpn_pid" 2>/dev/null || true
        wait "$openvpn_pid" 2>/dev/null || true
        record_failure
        continue
    fi

    write_number "$CONSECUTIVE_FILE" 0
    "$ROUTE_TABLE_HELPER" refresh >> "$WATCHER_LOG"
    event "connection-established"
    log "connection-established"
    wait "$openvpn_pid" 2>/dev/null || true
    rm -f "$CONNECTED_FILE"
    event "connection-lost immediate-retry=1"
    log "connection-lost; retrying immediately"
    write_number "$LAST_ATTEMPT_FILE" 0
done
