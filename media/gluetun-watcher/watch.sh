#!/bin/sh
# gluetun-watcher: restarts dependent containers when gluetun is
# restarted or recreated (network namespace changes in both cases).

PARENT="${PARENT_CONTAINER:-gluetun}"
DEPENDENTS="${DEPENDENT_CONTAINERS:-qbittorrent prowlarr}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
SETTLE_DELAY="${SETTLE_DELAY:-10}"
QBITTORRENT_CONTAINER="${QBITTORRENT_CONTAINER:-qbittorrent}"
QBITTORRENT_WEBUI_PORT="${QBITTORRENT_WEBUI_PORT:-8400}"

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') [gluetun-watcher] $1"
}

if ! docker compose version >/dev/null 2>&1; then
    log "FATAL: docker compose not available"
    exit 1
fi

get_compose_cmd() {
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

    COMPOSE_CMD="docker compose -p $PROJECT --project-directory $WORKDIR"
    OLD_IFS="$IFS"; IFS=","
    for f in $CONFIG; do
        COMPOSE_CMD="$COMPOSE_CMD -f $f"
    done
    IFS="$OLD_IFS"
    return 0
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

get_forwarded_port() {
    docker exec "$PARENT" sh -c 'cat /gluetun/forwarded_port /tmp/gluetun/forwarded_port 2>/dev/null | head -n1' 2>/dev/null \
        | tr -dc '0-9'
}

sync_qbittorrent_port() {
    port="$(get_forwarded_port)"
    if [ -z "$port" ] || [ "$port" -lt 1 ] || [ "$port" -gt 65535 ] 2>/dev/null; then
        log "WARNING: cannot read valid forwarded port from $PARENT"
        return 1
    fi

    state=$(docker inspect "$QBITTORRENT_CONTAINER" --format '{{.State.Status}}' 2>/dev/null || echo "")
    if [ "$state" != "running" ]; then
        log "$QBITTORRENT_CONTAINER: not running ($state), cannot sync forwarded port"
        return 1
    fi

    log "$QBITTORRENT_CONTAINER: syncing listen_port=$port"
    if docker exec "$QBITTORRENT_CONTAINER" sh -c "wget -qO- --timeout=5 --post-data 'json={\"listen_port\":$port}' http://127.0.0.1:${QBITTORRENT_WEBUI_PORT}/api/v2/app/setPreferences >/dev/null"; then
        log "$QBITTORRENT_CONTAINER: listen_port synced to $port"
    else
        log "ERROR: failed to sync $QBITTORRENT_CONTAINER listen_port"
        return 1
    fi
}

restart_dependents() {
    for ctr in $DEPENDENTS; do
        state=$(docker inspect "$ctr" --format '{{.State.Status}}' 2>/dev/null || echo "")
        if [ "$state" != "running" ]; then
            log "$ctr: not running ($state), skip"
            continue
        fi

        log "$ctr: restarting (gluetun namespace changed)..."
        docker restart "$ctr" 2>&1 | while IFS= read -r line; do
            log "  $line"
        done
        log "$ctr: done"
    done
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
        if [ "$ctr_started" \< "$parent_started" ]; then
            log "$ctr: started before $PARENT (stale namespace)"
            stale=1
        else
            log "$ctr: started after $PARENT (OK)"
        fi
    done

    if [ "$stale" -eq 1 ]; then
        log "Stale dependents detected, restarting..."
        restart_dependents
        sleep 5
        sync_qbittorrent_port || true
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
sync_qbittorrent_port || true

log "Watching docker events for $PARENT..."
docker events \
    --filter "container=$PARENT" \
    --filter "event=start" \
    --format '{{.Time}}' | while IFS= read -r ts; do

    log "$PARENT start event detected"
    log "Waiting for $PARENT healthy (${HEALTH_TIMEOUT}s)..."

    if wait_healthy; then
        log "$PARENT is healthy, restarting dependents..."
        sleep "$SETTLE_DELAY"
        restart_dependents
        sleep 5
        sync_qbittorrent_port || true
    else
        log "WARNING: $PARENT not healthy after ${HEALTH_TIMEOUT}s, skipping"
    fi
done

log "Event stream ended, exiting"
