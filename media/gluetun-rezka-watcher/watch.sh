#!/bin/sh
set -eu

PARENT=${PARENT_CONTAINER:-gluetun-rezka}
DEPENDENT=${DEPENDENT_CONTAINER:-download-runner}
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-120}
SETTLE_DELAY=${SETTLE_DELAY:-10}
ROTATION_ATTEMPTS=${ROTATION_ATTEMPTS:-3}
LIFECYCLE_WRITE_ATTEMPTS=${LIFECYCLE_WRITE_ATTEMPTS:-3}
LIFECYCLE_RETRY_DELAY=${LIFECYCLE_RETRY_DELAY:-2}
LIFECYCLE_HTTP_TIMEOUT=${LIFECYCLE_HTTP_TIMEOUT:-10}
STATE_DIR=${STATE_DIR:-/state}
: "${MEDIA_LIFECYCLE_TOKEN:?MEDIA_LIFECYCLE_TOKEN is required}"

log() {
    printf '%s [gluetun-rezka-watcher] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1"
}

started_at() {
    docker inspect "$1" --format '{{.State.StartedAt}}' 2>/dev/null || true
}

wait_healthy() {
    elapsed=0
    while [ "$elapsed" -lt "$HEALTH_TIMEOUT" ]; do
        status=$(docker inspect "$PARENT" --format '{{.State.Health.Status}}' 2>/dev/null || true)
        if [ "$status" = healthy ]; then
            return 0
        fi
        sleep 5
        elapsed=$((elapsed + 5))
    done
    return 1
}

restart_dependent() {
    state=$(docker inspect "$DEPENDENT" --format '{{.State.Status}}' 2>/dev/null || true)
    if [ "$state" != running ]; then
        log "$DEPENDENT is not running; no restart needed"
        return
    fi

    log "restarting $DEPENDENT after $PARENT namespace replacement"
    docker restart "$DEPENDENT" >/dev/null
}

public_ip() {
    ip=$(docker exec "$PARENT" cat /tmp/gluetun/ip 2>/dev/null | tr -d '\r\n' || true)
    if [ -n "$ip" ]; then
        printf '%s' "$ip"
        return
    fi

    for endpoint in http://ipinfo.io/ip http://ifconfig.me/ip; do
        ip=$(docker exec "$PARENT" wget -qO- --timeout=15 "$endpoint" 2>/dev/null \
            | tr -d '\r\n' || true)
        if [ -n "$ip" ]; then
            printf '%s' "$ip"
            return
        fi
    done
}

record_rotation() {
    timestamp=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
    printf '%s\t%s\t%s\t%s\n' "$timestamp" "$1" "$2" "$3" \
        >>"$STATE_DIR/rotations.tsv"
}

json_ip() {
    case ${1:-} in
        '' | *[!0-9A-Fa-f:.]*) printf 'null' ;;
        *) printf '"%s"' "$1" ;;
    esac
}

put_lifecycle() {
    state=$1
    reason=$2
    previous_ip=$3
    current_ip=$4
    body=$(printf '{"state":"%s","reason":%s,"previous_ip":%s,"current_ip":%s}' \
        "$state" "$reason" "$(json_ip "$previous_ip")" "$(json_ip "$current_ip")")
    response_file="$STATE_DIR/lifecycle-response.$$"
    attempt=1

    while [ "$attempt" -le "$LIFECYCLE_WRITE_ATTEMPTS" ]; do
        if wget -q -T "$LIFECYCLE_HTTP_TIMEOUT" -O "$response_file" \
            --header "Authorization: Bearer $MEDIA_LIFECYCLE_TOKEN" \
            --header 'Content-Type: application/json' \
            --post-data "$body" \
            http://media-service:8080/v1/runner/lifecycle; then
            rm -f "$response_file"
            return 0
        fi

        log "failed to record lifecycle state $state (attempt $attempt/$LIFECYCLE_WRITE_ATTEMPTS)"
        attempt=$((attempt + 1))
        if [ "$attempt" -le "$LIFECYCLE_WRITE_ATTEMPTS" ]; then
            sleep "$LIFECYCLE_RETRY_DELAY"
        fi
    done

    rm -f "$response_file"
    return 1
}

rotate_parent() {
    if [ -z "${ROTATION_PREVIOUS_IP:-}" ]; then
        ROTATION_PREVIOUS_IP=$(public_ip)
    fi
    ROTATION_CURRENT_IP=
    attempt=1
    while [ "$attempt" -le "$ROTATION_ATTEMPTS" ]; do
        log "rotating $PARENT before the next job (attempt $attempt/$ROTATION_ATTEMPTS)"
        docker restart "$PARENT" >/dev/null
        if wait_healthy; then
            sleep "$SETTLE_DELAY"
            ROTATION_CURRENT_IP=$(public_ip)
            if [ -n "$ROTATION_PREVIOUS_IP" ] && [ -n "$ROTATION_CURRENT_IP" ] \
                && [ "$ROTATION_PREVIOUS_IP" != "$ROTATION_CURRENT_IP" ]; then
                record_rotation "$ROTATION_PREVIOUS_IP" "$ROTATION_CURRENT_IP" "$attempt"
                log "$PARENT rotated from $ROTATION_PREVIOUS_IP to $ROTATION_CURRENT_IP"
                return 0
            fi
            log "$PARENT did not obtain a different public IP"
        else
            log "$PARENT did not become healthy within ${HEALTH_TIMEOUT}s"
        fi
        attempt=$((attempt + 1))
    done
    record_rotation "${ROTATION_PREVIOUS_IP:-unknown}" "failed" "$ROTATION_ATTEMPTS"
    return 1
}

start_dependent() {
    state=$(docker inspect "$DEPENDENT" --format '{{.State.Status}}' 2>/dev/null || true)
    if [ "$state" = running ]; then
        log "$DEPENDENT is already running; checking its network namespace"
        check_stale_namespace
        return
    fi
    log "starting $DEPENDENT after successful VPN rotation"
    docker start "$DEPENDENT" >/dev/null
}

check_stale_namespace() {
    parent_started=$(started_at "$PARENT")
    dependent_started=$(started_at "$DEPENDENT")
    oldest_started=$(printf '%s\n%s\n' "$parent_started" "$dependent_started" | sort | head -n 1)
    if [ -n "$parent_started" ] && [ -n "$dependent_started" ] \
        && [ "$dependent_started" != "$parent_started" ] \
        && [ "$oldest_started" = "$dependent_started" ]; then
        restart_dependent
    fi
}

mkdir -p "$STATE_DIR"
touch "$STATE_DIR/rotations.tsv"

log "watching $PARENT and $DEPENDENT; only this dedicated pair may be controlled"
sleep "$SETTLE_DELAY"
check_stale_namespace

dependent_state=$(docker inspect "$DEPENDENT" --format '{{.State.Status}}' 2>/dev/null || true)
if [ "$dependent_state" = running ] && wait_healthy; then
    current_ip=$(public_ip)
    if ! put_lifecycle ready null "$current_ip" "$current_ip"; then
        log "cannot initialize ready lifecycle state; stopping $DEPENDENT fail-closed"
        docker stop "$DEPENDENT" >/dev/null || true
        exit 1
    fi
elif [ "$dependent_state" != running ]; then
    ROTATION_PREVIOUS_IP=$(public_ip)
    if ! put_lifecycle rotating null "$ROTATION_PREVIOUS_IP" ''; then
        log "cannot initialize rotating lifecycle state; $DEPENDENT remains stopped"
        exit 1
    elif rotate_parent && put_lifecycle ready null "$ROTATION_PREVIOUS_IP" "$ROTATION_CURRENT_IP"; then
        start_dependent
    else
        put_lifecycle blocked '"vpn_rotation_failed"' "$ROTATION_PREVIOUS_IP" "$ROTATION_CURRENT_IP" || true
        log "startup VPN reconciliation failed; $DEPENDENT remains stopped"
    fi
fi

docker events \
    --filter type=container \
    --filter "container=$PARENT" \
    --filter "container=$DEPENDENT" \
    --filter "event=start" \
    --filter "event=die" \
    --format '{{.Actor.Attributes.name}}|{{.Action}}' | while IFS='|' read -r container action; do
    if [ "$container" = "$DEPENDENT" ] && [ "$action" = die ]; then
        log "$DEPENDENT completed its one-job process; rotating VPN"
        ROTATION_PREVIOUS_IP=$(public_ip)
        if ! put_lifecycle rotating null "$ROTATION_PREVIOUS_IP" ''; then
            log "cannot record rotating lifecycle state; $DEPENDENT remains stopped"
        elif rotate_parent; then
            if put_lifecycle ready null "$ROTATION_PREVIOUS_IP" "$ROTATION_CURRENT_IP"; then
                start_dependent
            else
                log "cannot record ready lifecycle state; $DEPENDENT remains stopped"
            fi
        else
            if ! put_lifecycle blocked '"vpn_rotation_failed"' \
                "$ROTATION_PREVIOUS_IP" "$ROTATION_CURRENT_IP"; then
                log "cannot record blocked lifecycle state"
            fi
            log "VPN rotation failed; $DEPENDENT remains stopped and queued work is gated"
        fi
    elif [ "$container" = "$PARENT" ] && [ "$action" = start ]; then
        log "$PARENT start detected"
        check_stale_namespace
    fi
done

log "Docker event stream ended"
exit 1
