#!/bin/sh

set -eu

umask 077

INSTANCE_UUID="${INSTANCE_UUID:-6387ef44-4e9a-4c79-af35-c829c2eb0766}"
VPN_ID="${VPN_ID:-1}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-3}"
MIN_RETRY_INTERVAL_SECONDS="${MIN_RETRY_INTERVAL_SECONDS:-3600}"
CONNECT_TIMEOUT_SECONDS="${CONNECT_TIMEOUT_SECONDS:-45}"
PING_EXIT_SECONDS="${PING_EXIT_SECONDS:-120}"
ROLLING_WINDOW_SECONDS="${ROLLING_WINDOW_SECONDS:-86400}"
STABLE_SESSION_SECONDS="${STABLE_SESSION_SECONDS:-3600}"
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
OPENVPN_PID_FILE="/var/run/ovpn-instance-${INSTANCE_UUID}.pid"
WATCHER_LOG="$LOG_DIR/watcher.log"
EVENT_LOG="$LOG_DIR/events.log"
ATTEMPTS_FILE="$STATE_DIR/attempts-since-reset"
ATTEMPT_HISTORY_FILE="$STATE_DIR/attempt-history"
LEGACY_FAILURES_FILE="$STATE_DIR/failures-since-reset"
CONSECUTIVE_FILE="$STATE_DIR/consecutive-failures"
LAST_ATTEMPT_FILE="$STATE_DIR/last-attempt"
LOCKOUT_FILE="$STATE_DIR/lockout"
CONNECTED_FILE="$RUN_DIR/connected"
PASSWORD_FILE="$RUN_DIR/password"
openvpn_pid=""

case "$MAX_ATTEMPTS:$MIN_RETRY_INTERVAL_SECONDS" in
    *[!0-9:]*|:*|*:) printf 'Invalid retry policy.\n' >&2; exit 64 ;;
esac
if [ "$MAX_ATTEMPTS" -lt 1 ] || [ "$MAX_ATTEMPTS" -gt 3 ]; then
    printf 'MAX_ATTEMPTS must be between 1 and 3.\n' >&2
    exit 64
fi
if [ "$SIMULATE_AUTH_FAILURE" != "true" ] && { [ "$MIN_RETRY_INTERVAL_SECONDS" -lt 3600 ] || [ "$STABLE_SESSION_SECONDS" -lt 3600 ]; }; then
    printf 'Retry interval and stable-session threshold cannot be below 3600 outside simulation.\n' >&2
    exit 64
fi

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

stop_openvpn() {
    pid="${openvpn_pid:-}"
    if [ -z "$pid" ] && [ -r "$OPENVPN_PID_FILE" ]; then
        pid="$(cat "$OPENVPN_PID_FILE")"
    fi
    case "$pid" in
        ''|*[!0-9]*) rm -f "$OPENVPN_PID_FILE"; return ;;
    esac
    if kill -0 "$pid" 2>/dev/null; then
        kill -TERM "$pid" 2>/dev/null || true
        wait_count=0
        while kill -0 "$pid" 2>/dev/null && [ "$wait_count" -lt 10 ]; do
            sleep 1
            wait_count=$((wait_count + 1))
        done
        if kill -0 "$pid" 2>/dev/null; then
            kill -KILL "$pid" 2>/dev/null || true
        fi
    fi
    rm -f "$OPENVPN_PID_FILE"
    openvpn_pid=""
}

cleanup_runtime() {
    stop_openvpn
    rm -f "$PASSWORD_FILE" "$CONNECTED_FILE"
}

trap cleanup_runtime EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

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
        -e '/^route-up /d' \
        -e '/^route-pre-down /d' \
        -e '/^keepalive /d' \
        -e 's/^script-security .*/script-security 2/' \
        "$CONFIG_FILE"

    {
        printf 'connect-retry-max 1\n'
        printf 'resolv-retry 0\n'
        printf 'single-session\n'
        printf 'auth-retry none\n'
        printf 'pull-filter ignore "redirect-gateway"\n'
        printf 'pull-filter ignore "redirect-private"\n'
        printf 'ping 10\n'
        printf 'ping-exit %s\n' "$PING_EXIT_SECONDS"
        printf 'tls-exit\n'
        printf 'remap-usr1 SIGTERM\n'
        printf 'route-up %s\n' "$EVENT_HOOK"
        printf 'route-pre-down %s\n' "$EVENT_HOOK"
    } >> "$CONFIG_FILE"
}

if [ "$VALIDATE_ONLY" = "true" ]; then
    render_config
    grep -q '^remote atl-core-ovpn\.atlas-iac\.net 14290$' "$CONFIG_FILE"
    grep -q '^<tls-auth>$' "$CONFIG_FILE"
    grep -q '^key-direction 1$' "$CONFIG_FILE"
    grep -q '^connect-retry-max 1$' "$CONFIG_FILE"
    grep -q '^single-session$' "$CONFIG_FILE"
    grep -q '^auth-retry none$' "$CONFIG_FILE"
    grep -q '^pull-filter ignore "redirect-gateway"$' "$CONFIG_FILE"
    grep -q '^script-security 2$' "$CONFIG_FILE"
    grep -q '^management .*\.sock unix$' "$CONFIG_FILE"
    grep -q '^writepid ' "$CONFIG_FILE"
    grep -q '^daemon ' "$CONFIG_FILE"
    grep -q '^route-up ' "$CONFIG_FILE"
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

prune_attempt_history() {
    now="$(date +%s)"
    cutoff=$((now - ROLLING_WINDOW_SECONDS))
    tmp="$STATE_DIR/attempt-history.tmp"
    if [ -r "$ATTEMPT_HISTORY_FILE" ]; then
        awk -v cutoff="$cutoff" '$1 ~ /^[0-9]+$/ && $1 > cutoff { print $1 }' "$ATTEMPT_HISTORY_FILE" > "$tmp"
    else
        : > "$tmp"
    fi
    chmod 0600 "$tmp"
    mv -f "$tmp" "$ATTEMPT_HISTORY_FILE"
}

rolling_attempts() {
    prune_attempt_history
    wc -l < "$ATTEMPT_HISTORY_FILE" | tr -d ' '
}

migrate_legacy_attempt() {
    [ -s "$ATTEMPT_HISTORY_FILE" ] && return
    legacy="$(read_number "$LEGACY_FAILURES_FILE")"
    last="$(read_number "$LAST_ATTEMPT_FILE")"
    if [ "$legacy" -gt 0 ] && [ "$last" -gt 0 ]; then
        printf '%s\n' "$last" > "$ATTEMPT_HISTORY_FILE"
        chmod 0600 "$ATTEMPT_HISTORY_FILE"
        event "legacy-attempt-migrated timestamp=$last"
    fi
}

enter_lockout() {
    rolling="$(rolling_attempts)"
    consecutive="$(read_number "$CONSECUTIVE_FILE")"
    printf '%s\n' "$(date -u +%FT%TZ)" > "$LOCKOUT_FILE"
    chmod 0600 "$LOCKOUT_FILE"
    event "lockout rolling=$rolling consecutive=$consecutive"
    log "lockout-entered rolling=$rolling consecutive=$consecutive"
    exit 78
}

reserve_attempt() {
    rolling="$(rolling_attempts)"
    consecutive="$(read_number "$CONSECUTIVE_FILE")"
    if [ "$rolling" -ge "$MAX_ATTEMPTS" ] || [ "$consecutive" -ge "$MAX_ATTEMPTS" ]; then
        enter_lockout
    fi
    now="$(date +%s)"
    printf '%s\n' "$now" >> "$ATTEMPT_HISTORY_FILE"
    chmod 0600 "$ATTEMPT_HISTORY_FILE"
    rolling=$((rolling + 1))
    write_number "$ATTEMPTS_FILE" "$rolling"
    # Keep the previous counter synchronized so a rollback cannot restore a
    # lower retry budget.
    write_number "$LEGACY_FAILURES_FILE" "$rolling"
    if [ "$rolling" -ge "$MAX_ATTEMPTS" ]; then
        printf '%s\n' "$(date -u +%FT%TZ)" > "$LOCKOUT_FILE"
        chmod 0600 "$LOCKOUT_FILE"
        event "rolling-budget-exhausted attempts=$rolling window_seconds=$ROLLING_WINDOW_SECONDS"
    fi
    printf '%s\n' "$rolling"
}

record_failed_outcome() {
    attempt="$1"
    consecutive=$(( $(read_number "$CONSECUTIVE_FILE") + 1 ))
    write_number "$CONSECUTIVE_FILE" "$consecutive"
    event "attempt-failed attempt=$attempt consecutive=$consecutive"
    log "attempt-failed attempt=$attempt consecutive=$consecutive max=$MAX_ATTEMPTS"
    if [ "$consecutive" -ge "$MAX_ATTEMPTS" ] || [ -e "$LOCKOUT_FILE" ]; then
        enter_lockout
    fi
}

migrate_legacy_attempt

while :; do
    wait_for_retry_window
    attempt_started="$(date +%s)"
    write_number "$LAST_ATTEMPT_FILE" "$attempt_started"
    attempt_number="$(reserve_attempt)"
    event "attempt-start number=$attempt_number max=$MAX_ATTEMPTS"
    log "attempt-start number=$attempt_number max=$MAX_ATTEMPTS"
    rm -f "$CONNECTED_FILE"

    if [ "$SIMULATE_AUTH_FAILURE" = "true" ]; then
        sleep 1
        record_failed_outcome "$attempt_number"
        continue
    fi

    prepare_interface
    render_config
    export PRITUNL_RUN_DIR="$RUN_DIR" PRITUNL_EVENT_LOG="$EVENT_LOG"
    if ! "$OPENVPN_BIN" --config "$CONFIG_FILE"; then
        record_failed_outcome "$attempt_number"
        continue
    fi

    elapsed=0
    while [ ! -r "$OPENVPN_PID_FILE" ] && [ "$elapsed" -lt 10 ]; do
        sleep 1
        elapsed=$((elapsed + 1))
    done
    if [ ! -r "$OPENVPN_PID_FILE" ]; then
        event "native-start-failed reason=missing-pidfile attempt=$attempt_number"
        record_failed_outcome "$attempt_number"
        continue
    fi
    openvpn_pid="$(cat "$OPENVPN_PID_FILE")"
    case "$openvpn_pid" in
        ''|*[!0-9]*)
            event "native-start-failed reason=invalid-pidfile attempt=$attempt_number"
            stop_openvpn
            record_failed_outcome "$attempt_number"
            continue
            ;;
    esac

    elapsed=0
    while kill -0 "$openvpn_pid" 2>/dev/null && [ ! -e "$CONNECTED_FILE" ] && [ "$elapsed" -lt "$CONNECT_TIMEOUT_SECONDS" ]; do
        sleep 1
        elapsed=$((elapsed + 1))
    done

    if [ ! -e "$CONNECTED_FILE" ]; then
        stop_openvpn
        record_failed_outcome "$attempt_number"
        continue
    fi

    event "connection-established attempt=$attempt_number native-status=available"
    log "connection-established attempt=$attempt_number"
    connected_at="$(date +%s)"
    stable_reset_done=false
    while kill -0 "$openvpn_pid" 2>/dev/null; do
        now="$(date +%s)"
        if [ "$stable_reset_done" = "false" ] && [ $((now - connected_at)) -ge "$STABLE_SESSION_SECONDS" ]; then
            write_number "$CONSECUTIVE_FILE" 0
            stable_reset_done=true
            event "stable-session consecutive-reset=1 seconds=$((now - connected_at))"
            log "stable-session; consecutive failure counter reset"
        fi
        sleep 1
    done
    rm -f "$OPENVPN_PID_FILE"
    openvpn_pid=""
    rm -f "$CONNECTED_FILE"
    if [ "$stable_reset_done" = "false" ]; then
        record_failed_outcome "$attempt_number"
    fi
    if [ -e "$LOCKOUT_FILE" ]; then
        event "connection-lost rolling-budget-exhausted=1"
        log "connection-lost; rolling attempt budget exhausted"
        enter_lockout
    fi
    event "connection-lost immediate-retry=1 next-attempt=$((attempt_number + 1))"
    log "connection-lost; retrying immediately with attempt $((attempt_number + 1)) of $MAX_ATTEMPTS"
    write_number "$LAST_ATTEMPT_FILE" 0
done
