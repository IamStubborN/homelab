#!/bin/sh
# gluetun-watcher: restarts dependent containers when gluetun is
# restarted or recreated (network namespace changes in both cases).

PARENT="${PARENT_CONTAINER:-gluetun}"
DEPENDENTS="${DEPENDENT_CONTAINERS:-qbittorrent}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
SETTLE_DELAY="${SETTLE_DELAY:-10}"
# Coalesce rapid parent start events before deciding to recreate.
RECREATE_DEBOUNCE="${RECREATE_DEBOUNCE:-20}"

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') [gluetun-watcher] $1"
}

if ! docker compose version >/dev/null 2>&1; then
    log "FATAL: docker compose not available"
    exit 1
fi

# Container IDs change on Compose recreate. Subscribe by event type and match
# exact actor names locally; name filters prefix-match unrelated containers.
refresh_parent_identity() {
    current_id=$(docker inspect "$PARENT" --format '{{.Id}}' 2>/dev/null) || return 1
    printf '%s\n' "$current_id" | grep -Eq '^[0-9a-fA-F]{64}$' || return 1
    current_name=$(docker inspect "$current_id" --format '{{.Name}}' 2>/dev/null | sed 's#^/##')
    [ "$current_name" = "$PARENT" ] || return 1
    PARENT_ID=$current_id
    PARENT_ID_SHORT=$(printf '%.12s' "$PARENT_ID")
}

if ! refresh_parent_identity; then
    log "FATAL: cannot resolve exact parent identity for $PARENT"
    exit 1
fi

get_compose_metadata() {
    PROJECT=$(docker inspect "$PARENT_ID" \
        --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null)
    CONFIG=$(docker inspect "$PARENT_ID" \
        --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' 2>/dev/null)
    WORKDIR=$(docker inspect "$PARENT_ID" \
        --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null)

    if [ -z "$PROJECT" ] || [ -z "$CONFIG" ] || [ -z "$WORKDIR" ]; then
        log "ERROR: cannot read compose labels from $PARENT"
        return 1
    fi

    return 0
}

parent_sandbox_key() {
    docker inspect "$PARENT_ID" \
        --format '{{.NetworkSettings.SandboxKey}}' 2>/dev/null || echo ""
}

# True when a dependent still needs force-recreate onto the current parent
# network namespace (stale NetworkMode, mismatched SandboxKey, or started
# before the parent).
dependent_needs_refresh() {
    ctr=$1
    mode=$(docker inspect "$ctr" \
        --format '{{.HostConfig.NetworkMode}}' 2>/dev/null || echo "")
    case "$mode" in
        "container:$PARENT_ID"|"container:$PARENT_ID_SHORT") ;;
        *)
            log "$ctr: NetworkMode '$mode' is not container:$PARENT_ID_SHORT"
            return 0
            ;;
    esac

    parent_ns=$(parent_sandbox_key)
    dep_ns=$(docker inspect "$ctr" \
        --format '{{.NetworkSettings.SandboxKey}}' 2>/dev/null || echo "")
    if [ -n "$parent_ns" ] && [ -n "$dep_ns" ]; then
        if [ "$parent_ns" != "$dep_ns" ]; then
            log "$ctr: SandboxKey differs from $PARENT (stale netns)"
            return 0
        fi
        # NetworkMode and SandboxKey both agree — current netns. Do not also
        # require StartedAt ordering; a just-recreated dependent may still
        # report an older stamp in edge races, and matching netns is enough.
        return 1
    fi

    # Fallback when SandboxKey is unavailable: start-order heuristic.
    parent_started=$(docker inspect "$PARENT_ID" \
        --format '{{.State.StartedAt}}' 2>/dev/null || echo "")
    ctr_started=$(docker inspect "$ctr" \
        --format '{{.State.StartedAt}}' 2>/dev/null || echo "")
    if [ -n "$parent_started" ] && [ -n "$ctr_started" ]; then
        older=$(printf '%s\n%s\n' "$ctr_started" "$parent_started" | sort | head -n1)
        if [ "$ctr_started" != "$parent_started" ] && [ "$older" = "$ctr_started" ]; then
            log "$ctr: started before $PARENT (stale namespace)"
            return 0
        fi
    fi

    return 1
}

dependents_need_refresh() {
    need=1
    for ctr in $DEPENDENTS; do
        if ! docker inspect "$ctr" >/dev/null 2>&1; then
            log "$ctr: missing; needs recreate"
            return 0
        fi
        if dependent_needs_refresh "$ctr"; then
            need=0
        else
            log "$ctr: already on current $PARENT netns"
        fi
    done
    return "$need"
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
        status=$(docker inspect "$PARENT_ID" \
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
    if ! dependents_need_refresh; then
        log "All dependents OK"
        return
    fi
    log "Stale dependents detected, restarting..."
    restart_dependents
}

refresh_dependents_if_needed() {
    log "$PARENT start event detected"
    if [ "$RECREATE_DEBOUNCE" -gt 0 ] 2>/dev/null; then
        log "Debouncing ${RECREATE_DEBOUNCE}s to coalesce rapid start events..."
        sleep "$RECREATE_DEBOUNCE"
    fi

    if ! refresh_parent_identity; then
        log "WARNING: cannot resolve current $PARENT identity; skipping recovery"
        return 1
    fi
    log "Waiting for $PARENT healthy (${HEALTH_TIMEOUT}s)..."
    if ! wait_healthy; then
        log "WARNING: $PARENT not healthy after ${HEALTH_TIMEOUT}s, skipping"
        return
    fi

    sleep "$SETTLE_DELAY"

    if ! dependents_need_refresh; then
        log "Dependents already share current $PARENT netns; skip recreate"
        return
    fi

    log "$PARENT is healthy, restarting dependents..."
    restart_dependents
}

# ---- main ----
log "Starting (parent=$PARENT id=$PARENT_ID_SHORT, dependents=[$DEPENDENTS])"
log "Health timeout=${HEALTH_TIMEOUT}s, settle delay=${SETTLE_DELAY}s, recreate debounce=${RECREATE_DEBOUNCE}s"

sleep "$SETTLE_DELAY"

log "Initial startup order check..."
check_startup_order

log "Watching docker start events for exact parent name $PARENT..."
docker events \
    --filter type=container \
    --filter "event=start" \
    --format '{{.Actor.ID}}|{{.Actor.Attributes.name}}|{{.Action}}' | while IFS='|' read -r _ container action; do
    # Docker may return exec_start health-check events for an event=start filter.
    [ "$action" = "start" ] || continue
    [ "$container" = "$PARENT" ] || continue

    refresh_dependents_if_needed
done

log "Event stream ended, exiting"
