#!/usr/bin/env bash

set -Eeuo pipefail

umask 077

RUN_DIR="${RUN_DIR:-/run/pritunl-vpn}"
STATE_DIR="${STATE_DIR:-/state}"
VPN_CONFIG="${VPN_CONFIG:-/vpn/client.ovpn}"
VPN_AUTH_FILE="${VPN_AUTH_FILE:-${RUN_DIR}/auth.txt}"
VPN_USERNAME_FILE="${VPN_USERNAME_FILE:-/run/secrets/vpn_username}"
VPN_PIN_FILE="${VPN_PIN_FILE:-/run/secrets/vpn_pin}"
TOTP_SEED_FILE="${TOTP_SEED_FILE:-/run/secrets/totp_seed}"
OPENVPN_BIN="${OPENVPN_BIN:-openvpn}"
DNSMASQ_BIN="${DNSMASQ_BIN:-dnsmasq}"
OPENVPN_EVENT_HOOK="${OPENVPN_EVENT_HOOK:-/usr/local/bin/pritunl-openvpn-hook}"
VPN_TUNNEL_INTERFACE="${VPN_TUNNEL_INTERFACE:-tun0}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-3}"
MIN_RETRY_INTERVAL_SECONDS="${MIN_RETRY_INTERVAL_SECONDS:-3600}"
OPENVPN_CONNECT_TIMEOUT_SECONDS="${OPENVPN_CONNECT_TIMEOUT_SECONDS:-30}"
OPENVPN_PING_EXIT_SECONDS="${OPENVPN_PING_EXIT_SECONDS:-120}"
SIMULATE_AUTH_FAILURE="${SIMULATE_AUTH_FAILURE:-false}"
SIMULATE_SERVER_DISCONNECT="${SIMULATE_SERVER_DISCONNECT:-false}"
DNSMASQ_VPN_SERVER="${DNSMASQ_VPN_SERVER:-192.168.217.1}"
DNSMASQ_PRIVATE_DOMAINS="${DNSMASQ_PRIVATE_DOMAINS:-platform-bo.com cluster.local atlas-iac.com}"
DNSMASQ_BOOTSTRAP_SERVERS="${DNSMASQ_BOOTSTRAP_SERVERS:-192.168.0.1 1.1.1.1}"
DNSMASQ_LISTEN_ADDRESS="${DNSMASQ_LISTEN_ADDRESS:-127.0.0.1}"

LOG_DIR="${LOG_DIR:-/logs}"
WATCHER_LOG_FILE="${LOG_DIR}/watcher.log"
OPENVPN_LOG_FILE="${LOG_DIR}/openvpn.log"
CURRENT_OPENVPN_LOG_FILE="${LOG_DIR}/openvpn-current.log"
EVENT_LOG_FILE="${LOG_DIR}/events.log"
RENDERED_CONFIG="${RUN_DIR}/client.ovpn"
LOCKOUT_FILE="${STATE_DIR}/lockout"
DNSMASQ_CONFIG="${RUN_DIR}/dnsmasq.conf"
DNSMASQ_LOG_FILE="${LOG_DIR}/dnsmasq.log"
LEGACY_FAILURE_COUNT_FILE="${STATE_DIR}/failure-count"
FAILURES_SINCE_RESET_FILE="${STATE_DIR}/failures-since-reset"
CONSECUTIVE_FAILURES_FILE="${STATE_DIR}/consecutive-failures"
ATTEMPT_SEQUENCE_FILE="${STATE_DIR}/attempt-sequence"
IN_FLIGHT_ATTEMPT_FILE="${STATE_DIR}/in-flight-attempt"
LAST_ATTEMPT_FILE="${STATE_DIR}/last-attempt"
IMMEDIATE_RETRY_FILE="${STATE_DIR}/immediate-retry"
OPENVPN_STATUS_FILE="${STATE_DIR}/openvpn-status.log"
OPENVPN_UP_FILE="${RUN_DIR}/openvpn-up"
OPENVPN_CONNECTED_FILE="${RUN_DIR}/openvpn-connected"
FIREWALL_READY_FILE="${RUN_DIR}/firewall-ready"
ACTIVE_FIREWALL_CHAIN_FILE="${RUN_DIR}/active-firewall-chain"
REMOTE_ENDPOINT_IP_FILE="${RUN_DIR}/remote-endpoint-ip"
IPTABLES_BIN="${IPTABLES_BIN:-iptables}"
UPLINK_INTERFACE="${UPLINK_INTERFACE:-}"
STATE_FILE_MODE="${STATE_FILE_MODE:-0644}"
LOG_FILE_MODE="${LOG_FILE_MODE:-0644}"
DNSMASQ_PID=""
NEXT_ATTEMPT_IMMEDIATE=false
LAST_ATTEMPT_CONNECTED=0

export OPENVPN_UP_FILE OPENVPN_CONNECTED_FILE

mkdir -p "$RUN_DIR" "$STATE_DIR" "$LOG_DIR"
chmod 0700 "$RUN_DIR"
chmod 0755 "$STATE_DIR" "$LOG_DIR"

cleanup_dnsmasq() {
    if [[ -n "${DNSMASQ_PID:-}" ]] && kill -0 "$DNSMASQ_PID" 2>/dev/null; then
        kill -TERM "$DNSMASQ_PID" 2>/dev/null || true
        wait "$DNSMASQ_PID" 2>/dev/null || true
    fi
    rm -f \
        "$VPN_AUTH_FILE" \
        "$RENDERED_CONFIG" \
        "$OPENVPN_UP_FILE" \
        "$OPENVPN_CONNECTED_FILE" \
        "$FIREWALL_READY_FILE"
}

trap cleanup_dnsmasq EXIT

log() {
    local line
    line="$(printf '%s %s' "$(date -u +%FT%TZ)" "$*")"
    printf '%s\n' "$line" | tee -a "$WATCHER_LOG_FILE"
    chmod "$LOG_FILE_MODE" "$WATCHER_LOG_FILE"
}

event() {
    printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$EVENT_LOG_FILE"
    chmod "$LOG_FILE_MODE" "$EVENT_LOG_FILE"
}

die() {
    log "FATAL: $*"
    event "fatal $*"
    exit 2
}

read_secret() {
    local file="$1"
    [[ -r "$file" ]] || die "secret file is missing: $file"
    tr -d '\r\n' < "$file"
}

generate_otp() {
    local seed_file otp

    seed_file="$(mktemp "${RUN_DIR}/totp-seed.XXXXXX")"
    chmod 0600 "$seed_file"
    read_secret "$TOTP_SEED_FILE" | tr -d '[:space:]-' > "$seed_file"
    if ! grep -Eq '^[A-Za-z2-7]+=*$' "$seed_file"; then
        rm -f "$seed_file"
        die "TOTP seed is not a valid Base32 value"
    fi

    if ! otp="$(oathtool --totp -b "@${seed_file}")"; then
        rm -f "$seed_file"
        die "oathtool could not generate a TOTP value"
    fi
    rm -f "$seed_file"
    printf '%s\n' "$otp"
}

validate_profile() {
    local remote_count

    remote_count="$(awk '$1 == "remote" && NF >= 2 { count++ } END { print count + 0 }' "$VPN_CONFIG")"
    if [[ "$remote_count" != "1" ]]; then
        die "OpenVPN profile must contain exactly one remote for the retry safety contract; found ${remote_count}"
    fi
}

append_bootstrap_host_records() {
    local host dns_server address found

    : > "$REMOTE_ENDPOINT_IP_FILE"
    chmod "$STATE_FILE_MODE" "$REMOTE_ENDPOINT_IP_FILE"

    while read -r host; do
        [[ -n "$host" ]] || continue
        if [[ "$host" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
            printf '%s\n' "$host" > "$REMOTE_ENDPOINT_IP_FILE"
            continue
        fi
        if [[ "$host" == *:* ]]; then
            continue
        fi

        found=0
        for dns_server in $DNSMASQ_BOOTSTRAP_SERVERS; do
            while read -r address; do
                [[ "$address" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || continue
                printf 'host-record=%s,%s\n' "$host" "$address" >> "$DNSMASQ_CONFIG"
                printf '%s\n' "$address" > "$REMOTE_ENDPOINT_IP_FILE"
                found=1
                break
            done < <(dig "@$dns_server" +short +time=2 +tries=1 "$host" A 2>/dev/null || true)
            (( found == 1 )) && break
        done

        (( found == 1 )) || die "could not resolve OpenVPN remote hostname through bootstrap DNS: $host"
    done < <(awk '$1 == "remote" && NF >= 2 { print $2 }' "$VPN_CONFIG" | sort -u)
}

detect_uplink_interface() {
    if [[ -z "$UPLINK_INTERFACE" ]]; then
        UPLINK_INTERFACE="$(ip -4 route show default | awk 'NR == 1 { print $5; exit }')"
    fi
    [[ -n "$UPLINK_INTERFACE" ]] || die "could not determine the pre-VPN uplink interface"
}

configure_fail_closed_firewall() {
    local active_chain new_chain destination endpoint route_count=0 tmp

    detect_uplink_interface
    active_chain=""
    if [[ -s "$ACTIVE_FIREWALL_CHAIN_FILE" ]]; then
        active_chain="$(sed -n '1p' "$ACTIVE_FIREWALL_CHAIN_FILE")"
    fi
    if [[ "$active_chain" == "PRITUNL_VPN_FC_A" ]]; then
        new_chain="PRITUNL_VPN_FC_B"
    else
        new_chain="PRITUNL_VPN_FC_A"
    fi

    if "$IPTABLES_BIN" -L "$new_chain" -n >/dev/null 2>&1; then
        "$IPTABLES_BIN" -F "$new_chain" || return 1
    else
        "$IPTABLES_BIN" -N "$new_chain" || return 1
    fi

    "$IPTABLES_BIN" -A "$new_chain" -o lo -j RETURN || return 1
    "$IPTABLES_BIN" -A "$new_chain" -o "$VPN_TUNNEL_INTERFACE" -j RETURN || return 1

    while read -r endpoint; do
        [[ "$endpoint" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || continue
        "$IPTABLES_BIN" -A "$new_chain" -o "$UPLINK_INTERFACE" -d "$endpoint" -j RETURN || return 1
    done < "$REMOTE_ENDPOINT_IP_FILE"

    for endpoint in $DNSMASQ_BOOTSTRAP_SERVERS; do
        [[ "$endpoint" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || continue
        "$IPTABLES_BIN" -A "$new_chain" -o "$UPLINK_INTERFACE" -d "$endpoint" -p udp --dport 53 -j RETURN || return 1
        "$IPTABLES_BIN" -A "$new_chain" -o "$UPLINK_INTERFACE" -d "$endpoint" -p tcp --dport 53 -j RETURN || return 1
    done

    while read -r destination; do
        [[ -n "$destination" ]] || continue
        [[ "$destination" == "default" ]] && destination="0.0.0.0/0"
        [[ "$destination" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}(/[0-9]{1,2})?$ ]] || continue
        "$IPTABLES_BIN" -A "$new_chain" -d "$destination" ! -o "$VPN_TUNNEL_INTERFACE" -j REJECT --reject-with icmp-net-unreachable || return 1
        route_count=$((route_count + 1))
    done < <(ip -4 route show dev "$VPN_TUNNEL_INTERFACE" | awk '{ print $1 }' | sort -u)

    # Non-corporate traffic keeps the existing split-routing default path.
    "$IPTABLES_BIN" -A "$new_chain" -j RETURN || return 1

    if ! "$IPTABLES_BIN" -C OUTPUT -j "$new_chain" 2>/dev/null; then
        "$IPTABLES_BIN" -I OUTPUT 1 -j "$new_chain" || return 1
    fi

    tmp="${ACTIVE_FIREWALL_CHAIN_FILE}.tmp"
    printf '%s\n' "$new_chain" > "$tmp"
    chmod "$STATE_FILE_MODE" "$tmp"
    mv -f "$tmp" "$ACTIVE_FIREWALL_CHAIN_FILE"

    if [[ -n "$active_chain" && "$active_chain" != "$new_chain" ]]; then
        while "$IPTABLES_BIN" -C OUTPUT -j "$active_chain" 2>/dev/null; do
            "$IPTABLES_BIN" -D OUTPUT -j "$active_chain" || return 1
        done
        "$IPTABLES_BIN" -F "$active_chain" 2>/dev/null || true
        "$IPTABLES_BIN" -X "$active_chain" 2>/dev/null || true
    fi

    : > "$FIREWALL_READY_FILE"
    chmod "$STATE_FILE_MODE" "$FIREWALL_READY_FILE"
    event "fail-closed-firewall-ready chain=$new_chain protected-routes=$route_count uplink=$UPLINK_INTERFACE"
}

start_dnsmasq() {
    local domain bootstrap

    [[ -r "$VPN_CONFIG" ]] || die "OpenVPN profile is missing: $VPN_CONFIG"
    validate_profile
    : > "$DNSMASQ_CONFIG"
    {
        printf '%s\n' 'no-resolv'
        printf '%s\n' 'no-hosts'
        printf 'listen-address=%s\n' "$DNSMASQ_LISTEN_ADDRESS"
        printf '%s\n' 'bind-interfaces'
        printf '%s\n' 'port=53'
        printf '%s\n' 'cache-size=256'
        for domain in $DNSMASQ_PRIVATE_DOMAINS; do
            printf 'server=/%s/%s\n' "$domain" "$DNSMASQ_VPN_SERVER"
        done
        for bootstrap in $DNSMASQ_BOOTSTRAP_SERVERS; do
            printf 'server=%s\n' "$bootstrap"
        done
    } >> "$DNSMASQ_CONFIG"
    append_bootstrap_host_records
    chmod 0600 "$DNSMASQ_CONFIG"

    "$DNSMASQ_BIN" \
        --keep-in-foreground \
        --conf-file="$DNSMASQ_CONFIG" \
        >> "$DNSMASQ_LOG_FILE" 2>&1 &
    DNSMASQ_PID=$!
    chmod "$LOG_FILE_MODE" "$DNSMASQ_LOG_FILE"

    for _ in {1..20}; do
        if ! kill -0 "$DNSMASQ_PID" 2>/dev/null; then
            sed -n '1,80p' "$DNSMASQ_LOG_FILE" >&2 || true
            die "dnsmasq exited during startup"
        fi
        if dig @127.0.0.1 +time=1 +tries=1 example.com A +short >/dev/null 2>&1; then
            log "dnsmasq split DNS is ready for: $DNSMASQ_PRIVATE_DOMAINS"
            event "dnsmasq-ready private-domains=$DNSMASQ_PRIVATE_DOMAINS"
            return 0
        fi
        sleep 0.2
    done

    sed -n '1,80p' "$DNSMASQ_LOG_FILE" >&2 || true
    die "dnsmasq did not become ready"
}

write_auth_file() {
    local username pin otp tmp
    username="$(read_secret "$VPN_USERNAME_FILE")"
    pin="$(read_secret "$VPN_PIN_FILE")"
    [[ -n "$username" ]] || die "VPN username is empty"
    [[ -n "$pin" ]] || die "VPN PIN is empty"

    otp="$(generate_otp)"
    [[ "$otp" =~ ^[0-9]{6}$ ]] || die "oathtool returned an unexpected OTP"

    tmp="$(mktemp "${RUN_DIR}/auth.XXXXXX")"
    printf '%s\n%s\n' "$username" "${pin}${otp}" > "$tmp"
    chmod 0600 "$tmp"
    mv -f "$tmp" "$VPN_AUTH_FILE"
    log "generated a fresh TOTP credential"
}

render_config() {
    [[ -r "$VPN_CONFIG" ]] || die "OpenVPN profile is missing: $VPN_CONFIG"

    awk -v auth_file="$VPN_AUTH_FILE" '
        BEGIN {
            in_auth_block = 0
            replaced = 0
            print "pull-filter ignore \"dhcp-option DNS\""
        }
        /^[[:space:]]*<auth-user-pass>[[:space:]]*$/ {
            print "auth-user-pass " auth_file
            in_auth_block = 1
            replaced = 1
            next
        }
        in_auth_block && /^[[:space:]]*<\/auth-user-pass>[[:space:]]*$/ {
            in_auth_block = 0
            next
        }
        in_auth_block { next }
        /^[[:space:]]*ignore-unknown-option[[:space:]]+block-outside-dns([[:space:]]|$)/ { next }
        /^[[:space:]]*block-outside-dns([[:space:]]|$)/ { next }
        /^[[:space:]]*auth-user-pass([[:space:]]|$)/ {
            print "auth-user-pass " auth_file
            replaced = 1
            next
        }
        { print }
        END {
            if (!replaced) print "auth-user-pass " auth_file
        }
    ' "$VPN_CONFIG" > "$RENDERED_CONFIG"

    chmod 0600 "$RENDERED_CONFIG"
}

read_counter() {
    local file="$1"
    local label="$2"
    local count=0

    if [[ -s "$file" ]]; then
        read -r count < "$file"
    fi
    [[ "$count" =~ ^[0-9]+$ ]] || die "${label} state is invalid"
    printf '%s\n' "$count"
}

read_failures_since_reset() {
    if [[ -s "$FAILURES_SINCE_RESET_FILE" ]]; then
        read_counter "$FAILURES_SINCE_RESET_FILE" "failures-since-reset"
    elif [[ -s "$LEGACY_FAILURE_COUNT_FILE" ]]; then
        read_counter "$LEGACY_FAILURE_COUNT_FILE" "legacy failure-count"
    else
        printf '%s\n' 0
    fi
}

read_consecutive_failures() {
    read_counter "$CONSECUTIVE_FAILURES_FILE" "consecutive-failures"
}

write_counter() {
    local file="$1" count="$2" tmp

    tmp="${file}.tmp"

    printf '%s\n' "$count" > "$tmp"
    chmod "$STATE_FILE_MODE" "$tmp"
    mv -f "$tmp" "$file"
}

record_attempt() {
    local now="$1"
    local total consecutive sequence

    total="$(read_failures_since_reset)"
    consecutive="$(read_consecutive_failures)"
    sequence="$(read_counter "$ATTEMPT_SEQUENCE_FILE" "attempt-sequence")"
    sequence=$((sequence + 1))
    write_counter "$ATTEMPT_SEQUENCE_FILE" "$sequence"
    printf '%s\n' "$now" > "$LAST_ATTEMPT_FILE"
    chmod "$STATE_FILE_MODE" "$LAST_ATTEMPT_FILE"
    printf '%s %s\n' "$now" "$sequence" > "$IN_FLIGHT_ATTEMPT_FILE"
    chmod "$STATE_FILE_MODE" "$IN_FLIGHT_ATTEMPT_FILE"
    event "attempt-start sequence=$sequence failures-since-reset=$total consecutive-failures=$consecutive max-failures=$MAX_ATTEMPTS"
    log "starting connection attempt sequence=${sequence}; failures since manual reset=${total}/${MAX_ATTEMPTS}"
}

mark_connection_success() {
    write_counter "$CONSECUTIVE_FAILURES_FILE" 0
    rm -f "$IMMEDIATE_RETRY_FILE"
    rm -f "$IN_FLIGHT_ATTEMPT_FILE"
    event "connection-established consecutive-failures-reset failures-since-reset=$(read_failures_since_reset)"
}

record_failed_attempt() {
    local reason="$1"
    local total consecutive

    total="$(read_failures_since_reset)"
    consecutive="$(read_consecutive_failures)"
    total=$((total + 1))
    consecutive=$((consecutive + 1))
    write_counter "$FAILURES_SINCE_RESET_FILE" "$total"
    write_counter "$CONSECUTIVE_FAILURES_FILE" "$consecutive"
    rm -f "$IN_FLIGHT_ATTEMPT_FILE"
    event "failed-attempt-recorded failures-since-reset=$total consecutive-failures=$consecutive reason=$reason"
    log "failed connection attempt recorded: failures since manual reset=${total}/${MAX_ATTEMPTS}; reason=${reason}"
}

schedule_immediate_retry() {
    : > "$IMMEDIATE_RETRY_FILE"
    chmod "$STATE_FILE_MODE" "$IMMEDIATE_RETRY_FILE"
    NEXT_ATTEMPT_IMMEDIATE=true
    event "disconnect-detected immediate-retry-scheduled"
}

enter_lockout() {
    local count="$1"

    printf '%s\n' "$(date -u +%FT%TZ) lockout after ${count} failed attempts since manual reset; manual reset is required" > "$LOCKOUT_FILE"
    chmod "$STATE_FILE_MODE" "$LOCKOUT_FILE"
    log "LOCKOUT: maximum failed attempts reached; manual reset is required"
    event "lockout failure-count=$count"
    exit 78
}

wait_for_attempt_slot() {
    local now last wait_seconds count

    if [[ "$NEXT_ATTEMPT_IMMEDIATE" == true ]] || [[ -f "$IMMEDIATE_RETRY_FILE" ]]; then
        rm -f "$IMMEDIATE_RETRY_FILE"
        NEXT_ATTEMPT_IMMEDIATE=false
        log "starting immediate retry after disconnect"
        return 0
    fi

    count="$(read_failures_since_reset)"
    if (( count >= MAX_ATTEMPTS )); then
        enter_lockout "$count"
    fi

    if (( count == 0 )) || [[ ! -s "$LAST_ATTEMPT_FILE" ]]; then
        return 0
    fi

    while true; do
        now="$(date +%s)"
        last="$(cat "$LAST_ATTEMPT_FILE")"
        [[ "$last" =~ ^[0-9]+$ ]] || die "last-attempt state is invalid"
        wait_seconds=$(( MIN_RETRY_INTERVAL_SECONDS - (now - last) ))
        if (( wait_seconds <= 0 )); then
            return 0
        fi

        log "waiting ${wait_seconds}s before the next connection attempt"
        sleep "$wait_seconds"
    done
}

simulate_auth_failure() {
    printf '%s\n' "AUTH_FAILED simulated" >> "$CURRENT_OPENVPN_LOG_FILE"
    sleep 1
    return 1
}

simulate_server_disconnect() {
    if [[ ! -e "${STATE_DIR}/simulated-disconnect" ]]; then
        : > "${STATE_DIR}/simulated-disconnect"
        chmod "$STATE_FILE_MODE" "${STATE_DIR}/simulated-disconnect"
        printf '%s\n' 'Initialization Sequence Completed' >> "$CURRENT_OPENVPN_LOG_FILE"
        mark_connection_success
        LAST_ATTEMPT_CONNECTED=1
        log "simulated OpenVPN connection established"
        event "openvpn-disconnected rc=1 reason=remote-disconnect simulation=true"
        schedule_immediate_retry
        sleep 1
        return 1
    fi

    simulate_auth_failure || true
    return 1
}

archive_openvpn_attempt_log() {
    if [[ -s "$CURRENT_OPENVPN_LOG_FILE" ]]; then
        cat "$CURRENT_OPENVPN_LOG_FILE" >> "$OPENVPN_LOG_FILE"
        chmod "$LOG_FILE_MODE" "$OPENVPN_LOG_FILE"
    fi
}

classify_openvpn_result() {
    if grep -Eiq 'AUTH_FAILED|AUTH: Received control message: AUTH_FAILED' "$CURRENT_OPENVPN_LOG_FILE"; then
        printf '%s\n' 'auth-failed'
    elif grep -Eiq 'VERIFY ERROR|certificate verify failed|unable to get local issuer' "$CURRENT_OPENVPN_LOG_FILE"; then
        printf '%s\n' 'certificate-verification'
    elif grep -Eiq 'Cannot resolve host|RESOLVE: Cannot resolve|temporary failure in name resolution' "$CURRENT_OPENVPN_LOG_FILE"; then
        printf '%s\n' 'dns-resolution'
    elif grep -Eiq 'TUN/TAP|Cannot open TUN|Cannot allocate TUN|Permission denied' "$CURRENT_OPENVPN_LOG_FILE"; then
        printf '%s\n' 'tun-or-permissions'
    elif grep -Eiq 'Network is unreachable|Connection timed out|Connection reset|write UDP|read UDP' "$CURRENT_OPENVPN_LOG_FILE"; then
        printf '%s\n' 'network-error'
    elif grep -Eiq 'TLS key negotiation failed|TLS handshake failed|Server poll timeout|tls-error' "$CURRENT_OPENVPN_LOG_FILE"; then
        printf '%s\n' 'tls-or-server-timeout'
    elif grep -Eiq 'Inactivity timeout|ping-exit|remote-exit|SIGUSR1|SIGTERM' "$CURRENT_OPENVPN_LOG_FILE"; then
        printf '%s\n' 'remote-disconnect'
    else
        printf '%s\n' 'process-exit'
    fi
}

run_openvpn_attempt() {
    local pid rc connected=0 reason

    LAST_ATTEMPT_CONNECTED=0
    rm -f "$OPENVPN_UP_FILE" "$OPENVPN_CONNECTED_FILE" "$FIREWALL_READY_FILE"
    archive_openvpn_attempt_log
    : > "$CURRENT_OPENVPN_LOG_FILE"
    chmod "$LOG_FILE_MODE" "$CURRENT_OPENVPN_LOG_FILE"
    printf '%s\n' "--- OpenVPN attempt started $(date -u +%FT%TZ) ---" >> "$OPENVPN_LOG_FILE"
    chmod "$LOG_FILE_MODE" "$OPENVPN_LOG_FILE"

    if [[ "$SIMULATE_AUTH_FAILURE" == "true" ]]; then
        simulate_auth_failure || true
        archive_openvpn_attempt_log
        return 1
    fi

    if [[ "$SIMULATE_SERVER_DISCONNECT" == "true" ]]; then
        simulate_server_disconnect || true
        archive_openvpn_attempt_log
        return 1
    fi

    "$OPENVPN_BIN" \
        --config "$RENDERED_CONFIG" \
        --auth-retry none \
        --connect-retry-max 1 \
        --resolv-retry 0 \
        --single-session \
        --connect-timeout "$OPENVPN_CONNECT_TIMEOUT_SECONDS" \
        --tls-exit \
        --remap-usr1 SIGTERM \
        --ping-exit "$OPENVPN_PING_EXIT_SECONDS" \
        --script-security 2 \
        --up "$OPENVPN_EVENT_HOOK up $OPENVPN_UP_FILE $OPENVPN_CONNECTED_FILE $FIREWALL_READY_FILE" \
        --down "$OPENVPN_EVENT_HOOK down $OPENVPN_UP_FILE $OPENVPN_CONNECTED_FILE $FIREWALL_READY_FILE" \
        --status "$OPENVPN_STATUS_FILE" 5 \
        --log-append "$CURRENT_OPENVPN_LOG_FILE" &
    pid=$!

    for _ in {1..20}; do
        if [[ -e "$OPENVPN_STATUS_FILE" ]]; then
            chmod "$LOG_FILE_MODE" "$OPENVPN_STATUS_FILE"
            break
        fi
        sleep 0.1
    done

    while kill -0 "$pid" 2>/dev/null; do
        if (( connected == 0 )) && [[ -e "$OPENVPN_CONNECTED_FILE" ]]; then
            if ! configure_fail_closed_firewall; then
                log "OpenVPN connected but fail-closed firewall could not be configured; stopping this attempt"
                event "fail-closed-firewall-error"
                kill -TERM "$pid" 2>/dev/null || true
                break
            fi
            connected=1
            mark_connection_success
            log "OpenVPN connection established (up hook)"
        fi

        if grep -q 'AUTH_FAILED' "$CURRENT_OPENVPN_LOG_FILE" 2>/dev/null; then
            log "OpenVPN reported AUTH_FAILED; stopping this attempt"
            event "openvpn-auth-failed"
            kill -TERM "$pid" 2>/dev/null || true
            break
        fi

        sleep 1
    done

    set +e
    wait "$pid"
    rc=$?
    set -e
    rm -f "$OPENVPN_UP_FILE" "$FIREWALL_READY_FILE"
    archive_openvpn_attempt_log
    reason="$(classify_openvpn_result)"

    if (( connected == 0 )) && [[ -e "$OPENVPN_CONNECTED_FILE" ]]; then
        connected=1
        mark_connection_success
    fi

    if (( connected == 1 )); then
        LAST_ATTEMPT_CONNECTED=1
        log "OpenVPN disconnected; scheduling an immediate retry"
        event "openvpn-disconnected rc=$rc reason=$reason"
        schedule_immediate_retry
    else
        log "OpenVPN attempt failed before connection"
        event "openvpn-attempt-failed rc=$rc reason=$reason"
    fi

    return "$rc"
}

main() {
    local failures

    if [[ -f "$LOCKOUT_FILE" ]]; then
        log "LOCKOUT is active; run the manual reset command before starting"
        exit 78
    fi

    if [[ -f "$IN_FLIGHT_ATTEMPT_FILE" ]]; then
        log "recovering an interrupted connection attempt as a failed attempt"
        record_failed_attempt "interrupted-attempt"
        failures="$(read_failures_since_reset)"
        if (( failures >= MAX_ATTEMPTS )); then
            enter_lockout "$failures"
        fi
    fi

    start_dnsmasq
    detect_uplink_interface

    if [[ "$SIMULATE_AUTH_FAILURE" != "true" && "$SIMULATE_SERVER_DISCONNECT" != "true" ]]; then
        render_config
    fi

    while true; do
        wait_for_attempt_slot
        record_attempt "$(date +%s)"

        if [[ "$SIMULATE_AUTH_FAILURE" != "true" && "$SIMULATE_SERVER_DISCONNECT" != "true" ]]; then
            write_auth_file
        fi

        run_openvpn_attempt || true
        if (( LAST_ATTEMPT_CONNECTED == 0 )); then
            record_failed_attempt "$(classify_openvpn_result)"
            if (( $(read_failures_since_reset) >= MAX_ATTEMPTS )); then
                enter_lockout "$(read_failures_since_reset)"
            fi
        fi
    done
}

main "$@"
