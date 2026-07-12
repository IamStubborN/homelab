#!/bin/sh
set -eu

PARENT=${PARENT_CONTAINER:-gluetun-rezka}
DEPENDENT=${DEPENDENT_CONTAINER:-download-runner}
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-120}
SETTLE_DELAY=${SETTLE_DELAY:-10}
ROTATION_ATTEMPTS=${ROTATION_ATTEMPTS:-3}
STATE_DIR=${STATE_DIR:-/state}

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

rotate_parent() {
    previous_ip=$(public_ip)
    attempt=1
    while [ "$attempt" -le "$ROTATION_ATTEMPTS" ]; do
        log "rotating $PARENT before the next job (attempt $attempt/$ROTATION_ATTEMPTS)"
        docker restart "$PARENT" >/dev/null
        if wait_healthy; then
            sleep "$SETTLE_DELAY"
            current_ip=$(public_ip)
            if [ -n "$previous_ip" ] && [ -n "$current_ip" ] \
                && [ "$previous_ip" != "$current_ip" ]; then
                record_rotation "$previous_ip" "$current_ip" "$attempt"
                log "$PARENT rotated from $previous_ip to $current_ip"
                return 0
            fi
            log "$PARENT did not obtain a different public IP"
        else
            log "$PARENT did not become healthy within ${HEALTH_TIMEOUT}s"
        fi
        attempt=$((attempt + 1))
    done
    record_rotation "${previous_ip:-unknown}" "failed" "$ROTATION_ATTEMPTS"
    return 1
}

start_dependent() {
    state=$(docker inspect "$DEPENDENT" --format '{{.State.Status}}' 2>/dev/null || true)
    if [ "$state" = running ]; then
        log "$DEPENDENT is already running"
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

docker events \
    --filter type=container \
    --filter "container=$PARENT" \
    --filter "container=$DEPENDENT" \
    --filter "event=start" \
    --filter "event=die" \
    --format '{{.Actor.Attributes.name}}|{{.Action}}' | while IFS='|' read -r container action; do
    if [ "$container" = "$DEPENDENT" ] && [ "$action" = die ]; then
        log "$DEPENDENT completed its one-job process; rotating VPN"
        if rotate_parent; then
            start_dependent
        else
            log "VPN rotation failed; $DEPENDENT remains stopped and queued work is gated"
        fi
    elif [ "$container" = "$PARENT" ] && [ "$action" = start ]; then
        log "$PARENT start detected"
    fi
done

log "Docker event stream ended"
exit 1
