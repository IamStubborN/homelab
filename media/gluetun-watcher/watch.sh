#!/bin/sh
# gluetun-watcher: restarts dependent containers when gluetun is
# restarted or recreated (network namespace changes in both cases).

PARENT="${PARENT_CONTAINER:-gluetun}"
DEPENDENTS="${DEPENDENT_CONTAINERS:-qbittorrent prowlarr}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
SETTLE_DELAY="${SETTLE_DELAY:-10}"

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') [gluetun-watcher] $1"
}

if ! docker compose version >/dev/null 2>&1; then
    log "FATAL: docker compose not available"
    exit 1
fi

get_compose_metadata() {
    PROJECT=$(docker inspect "$PARENT" \
        --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null)
    CONFIG=$(docker inspect "$PARENT" \
        --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' 2>/dev/null)
    WORKDIR=$(docker inspect "$PARENT" \
        --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null)

    if [ -z "$PROJECT" ] || [ -z "$CONFIG" ] || [ -z "$WORKDIR" ]; then
        log "ERROR: cannot read compose labels from $PARENT"
        return 1
    fi

    return 0
}

recreate_dependent() {
    service=$1

    set -- docker compose -p "$PROJECT" --project-directory "$WORKDIR"
    old_ifs=$IFS
    IFS=,
    for config_file in $CONFIG; do
        set -- "$@" -f "$config_file"
    done
    IFS=$old_ifs
    set -- "$@" up -d --force-recreate --no-deps "$service"

    log "$service: recreating with Compose (gluetun namespace changed)..."
    if output=$("$@" 2>&1); then
        if [ -n "$output" ]; then
            printf '%s\n' "$output" | while IFS= read -r line; do
                log "  $line"
            done
        fi
        log "$service: done"
        return 0
    fi

    if [ -n "$output" ]; then
        printf '%s\n' "$output" | while IFS= read -r line; do
            log "  $line"
        done
    fi
    log "ERROR: failed to recreate $service"
    return 1
}

wait_healthy() {
    elapsed=0
    while [ "$elapsed" -lt "$HEALTH_TIMEOUT" ]; do
        status=$(docker inspect "$PARENT" \
            --format '{{.State.Health.Status}}' 2>/dev/null || echo "unknown")
        if [ "$status" = "healthy" ]; then
            return 0
        fi
        sleep 5
        elapsed=$((elapsed + 5))
    done
    return 1
}

restart_dependents() {
    if ! get_compose_metadata; then
        log "ERROR: cannot recover dependents without Compose metadata"
        return 1
    fi

    failed=0
    for service in $DEPENDENTS; do
        if ! recreate_dependent "$service"; then
            failed=1
        fi
    done
    return "$failed"
}

# Check if dependents started before gluetun (stale namespace)
check_startup_order() {
    parent_started=$(docker inspect "$PARENT" \
        --format '{{.State.StartedAt}}' 2>/dev/null || echo "")
    if [ -z "$parent_started" ]; then
        log "Cannot get $PARENT start time, skip initial check"
        return
    fi

    stale=0
    for ctr in $DEPENDENTS; do
        ctr_started=$(docker inspect "$ctr" \
            --format '{{.State.StartedAt}}' 2>/dev/null || echo "")
        if [ -z "$ctr_started" ]; then
            continue
        fi
        # If dependent started before parent — stale namespace
        older=$(printf '%s\n%s\n' "$ctr_started" "$parent_started" | sort | head -n1)
        if [ "$ctr_started" != "$parent_started" ] && [ "$older" = "$ctr_started" ]; then
            log "$ctr: started before $PARENT (stale namespace)"
            stale=1
        else
            log "$ctr: started after $PARENT (OK)"
        fi
    done

    if [ "$stale" -eq 1 ]; then
        log "Stale dependents detected, restarting..."
        restart_dependents
    else
        log "All dependents OK"
    fi
}

# ---- main ----
log "Starting (parent=$PARENT, dependents=[$DEPENDENTS])"
log "Health timeout=${HEALTH_TIMEOUT}s, settle delay=${SETTLE_DELAY}s"

sleep "$SETTLE_DELAY"

log "Initial startup order check..."
check_startup_order

log "Watching docker events for $PARENT..."
docker events \
    --filter "container=$PARENT" \
    --filter "event=start" \
    --format '{{.Action}}' | while IFS= read -r action; do

    # Docker may return exec_start health-check events for an event=start filter.
    [ "$action" = "start" ] || continue

    log "$PARENT start event detected"
    log "Waiting for $PARENT healthy (${HEALTH_TIMEOUT}s)..."

    if wait_healthy; then
        log "$PARENT is healthy, restarting dependents..."
        sleep "$SETTLE_DELAY"
        restart_dependents
    else
        log "WARNING: $PARENT not healthy after ${HEALTH_TIMEOUT}s, skipping"
    fi
done

log "Event stream ended, exiting"
