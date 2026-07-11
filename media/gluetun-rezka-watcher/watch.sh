#!/bin/sh
set -eu

PARENT=${PARENT_CONTAINER:-gluetun-rezka}
DEPENDENT=${DEPENDENT_CONTAINER:-download-runner}
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-120}
SETTLE_DELAY=${SETTLE_DELAY:-10}

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

log "watching $PARENT; only $DEPENDENT may be restarted"
sleep "$SETTLE_DELAY"
check_stale_namespace

docker events \
    --filter "container=$PARENT" \
    --filter "event=start" \
    --format '{{.Time}}' | while IFS= read -r _; do
    log "$PARENT start detected; waiting for health"
    if wait_healthy; then
        sleep "$SETTLE_DELAY"
        restart_dependent
    else
        log "$PARENT did not become healthy within ${HEALTH_TIMEOUT}s"
    fi
done

log "Docker event stream ended"
exit 1
