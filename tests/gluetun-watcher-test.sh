#!/bin/sh
set -eu

ROOT=$(unset CDPATH; cd -- "$(dirname -- "$0")/.." && pwd)
WATCHER="$ROOT/download/gluetun-watcher/watch.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

PARENT_ID='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
OTHER_ID='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
PARENT_SHORT='aaaaaaaaaaaa'
PARENT_NS='/var/run/docker/netns/aaaa'
STALE_NS='/var/run/docker/netns/stale'
FRESH_NS='/var/run/docker/netns/aaaa'

cat >"$TMP/docker" <<EOF
#!/bin/sh
set -eu

printf '%s\n' "\$*" >>"\$DOCKER_CALLS"

case "\$1" in
    compose)
        # After a force-recreate, dependents share the parent netns.
        if printf '%s\n' "\$*" | grep -Fq 'force-recreate'; then
            printf 'matched\n' >"\$NETNS_STATE"
        fi
        exit 0
        ;;
    inspect)
        target=\$2
        # Bare inspect used for existence checks.
        if [ "\$#" -eq 2 ]; then
            case "\$target" in
                gluetun|"$PARENT_ID"|qbittorrent) exit 0 ;;
                *) exit 1 ;;
            esac
        fi
        case "\$*" in
            *'{{.Id}}'*)
                if [ "\$target" = "gluetun" ] || [ "\$target" = "$PARENT_ID" ]; then
                    printf '%s\n' "$PARENT_ID"
                elif [ "\$target" = "gluetun-rezka" ]; then
                    printf '%s\n' "$OTHER_ID"
                else
                    exit 1
                fi
                ;;
            *'{{.Name}}'*)
                if [ "\$target" = "$PARENT_ID" ] || [ "\$target" = "gluetun" ]; then
                    printf '%s\n' '/gluetun'
                else
                    printf '%s\n' "/\$target"
                fi
                ;;
            *com.docker.compose.project.config_files*)
                printf '%s\n' '/srv/homelab/compose.yml,/srv/homelab/compose.override.yml'
                ;;
            *com.docker.compose.project.working_dir*)
                printf '%s\n' '/srv/homelab'
                ;;
            *com.docker.compose.project*)
                printf '%s\n' 'homelab'
                ;;
            *State.Health.Status*)
                printf '%s\n' 'healthy'
                ;;
            *HostConfig.NetworkMode*)
                if [ "\$target" = "gluetun" ] || [ "\$target" = "$PARENT_ID" ]; then
                    printf '%s\n' 'bridge'
                elif [ -f "\$NETNS_STATE" ] && [ "\$(cat "\$NETNS_STATE")" = "matched" ]; then
                    printf '%s\n' "container:$PARENT_ID"
                else
                    printf '%s\n' "\$DEPENDENT_NETMODE"
                fi
                ;;
            *NetworkSettings.SandboxKey*)
                if [ "\$target" = "gluetun" ] || [ "\$target" = "$PARENT_ID" ]; then
                    printf '%s\n' "\$PARENT_SANDBOX"
                elif [ -f "\$NETNS_STATE" ] && [ "\$(cat "\$NETNS_STATE")" = "matched" ]; then
                    printf '%s\n' "\$PARENT_SANDBOX"
                else
                    printf '%s\n' "\$DEPENDENT_SANDBOX"
                fi
                ;;
            *State.StartedAt*)
                if [ "\$target" = "gluetun" ] || [ "\$target" = "$PARENT_ID" ]; then
                    printf '%s\n' "\$PARENT_STARTED"
                else
                    printf '%s\n' "\$DEPENDENT_STARTED"
                fi
                ;;
            *State.Status*)
                printf '%s\n' "\$DEPENDENT_STATE"
                ;;
        esac
        ;;
    events)
        printf '%s\n' "\$*" | grep -Fq "container=$PARENT_ID" || {
            echo "events filter missing exact parent id" >&2
            exit 1
        }
        printf '%s\n' "\$*" | grep -Eq 'container=gluetun([^0-9a-fA-F]|$)' && {
            echo "events filter still uses parent name prefix" >&2
            exit 1
        }
        if [ -n "\${DOCKER_EVENTS:-}" ]; then
            printf '%s\n' "\$DOCKER_EVENTS"
        fi
        ;;
    restart)
        printf '%s\n' "\$2"
        ;;
esac
EOF
chmod +x "$TMP/docker"

run_watcher() {
    : >"$DOCKER_CALLS"
    : >"$NETNS_STATE"
    PATH="$TMP:$PATH" \
        PARENT_CONTAINER=gluetun \
        DEPENDENT_CONTAINERS=qbittorrent \
        HEALTH_TIMEOUT=5 \
        SETTLE_DELAY=0 \
        RECREATE_DEBOUNCE=0 \
        "$WATCHER" >"$TMP/output" 2>&1
}

DOCKER_CALLS="$TMP/docker-calls"
NETNS_STATE="$TMP/netns-state"
export DOCKER_CALLS NETNS_STATE

expected='compose -p homelab --project-directory /srv/homelab -f /srv/homelab/compose.yml -f /srv/homelab/compose.override.yml up -d --force-recreate --no-deps qbittorrent'

# 1) Stale dependent at startup (old start time + stale netns) → recreate
PARENT_STARTED='2026-07-14T12:00:00Z'
DEPENDENT_STARTED='2026-07-14T11:00:00Z'
DEPENDENT_STATE='exited'
DEPENDENT_NETMODE="container:$OTHER_ID"
DEPENDENT_SANDBOX="$STALE_NS"
PARENT_SANDBOX="$PARENT_NS"
DOCKER_EVENTS=''
export PARENT_STARTED DEPENDENT_STARTED DEPENDENT_STATE DEPENDENT_NETMODE DEPENDENT_SANDBOX PARENT_SANDBOX DOCKER_EVENTS
run_watcher

if ! grep -Fqx "$expected" "$DOCKER_CALLS"; then
    echo "FAIL: exited stale dependent was not recreated with Compose" >&2
    cat "$TMP/output" >&2
    cat "$DOCKER_CALLS" >&2
    exit 1
fi

# 2) exec_start must not recreate
PARENT_STARTED='2026-07-14T11:00:00Z'
DEPENDENT_STARTED='2026-07-14T12:00:00Z'
DEPENDENT_STATE='running'
DEPENDENT_NETMODE="container:$PARENT_ID"
DEPENDENT_SANDBOX="$PARENT_NS"
PARENT_SANDBOX="$PARENT_NS"
DOCKER_EVENTS='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa exec_start'
export PARENT_STARTED DEPENDENT_STARTED DEPENDENT_STATE DEPENDENT_NETMODE DEPENDENT_SANDBOX PARENT_SANDBOX DOCKER_EVENTS
run_watcher

if grep -Fq 'force-recreate' "$DOCKER_CALLS" || grep -Fq 'restart qbittorrent' "$DOCKER_CALLS"; then
    echo "FAIL: exec_start event triggered dependent recovery" >&2
    cat "$TMP/output" >&2
    cat "$DOCKER_CALLS" >&2
    exit 1
fi

# 3) Non-parent start must not recreate
PARENT_STARTED='2026-07-14T11:00:00Z'
DEPENDENT_STARTED='2026-07-14T12:00:00Z'
DEPENDENT_STATE='running'
DEPENDENT_NETMODE="container:$PARENT_ID"
DEPENDENT_SANDBOX="$PARENT_NS"
PARENT_SANDBOX="$PARENT_NS"
DOCKER_EVENTS='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb start'
export PARENT_STARTED DEPENDENT_STARTED DEPENDENT_STATE DEPENDENT_NETMODE DEPENDENT_SANDBOX PARENT_SANDBOX DOCKER_EVENTS
run_watcher

if grep -Fq 'force-recreate' "$DOCKER_CALLS" || grep -Fq 'restart qbittorrent' "$DOCKER_CALLS"; then
    echo "FAIL: non-parent start event triggered dependent recovery" >&2
    cat "$TMP/output" >&2
    cat "$DOCKER_CALLS" >&2
    exit 1
fi

# 4) Exact parent start with stale netns → recreate
PARENT_STARTED='2026-07-14T12:00:00Z'
DEPENDENT_STARTED='2026-07-14T11:00:00Z'
DEPENDENT_STATE='running'
DEPENDENT_NETMODE="container:$OTHER_ID"
DEPENDENT_SANDBOX="$STALE_NS"
PARENT_SANDBOX="$PARENT_NS"
DOCKER_EVENTS='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa start'
export PARENT_STARTED DEPENDENT_STARTED DEPENDENT_STATE DEPENDENT_NETMODE DEPENDENT_SANDBOX PARENT_SANDBOX DOCKER_EVENTS
run_watcher

if ! grep -Fqx "$expected" "$DOCKER_CALLS"; then
    echo "FAIL: exact parent start event did not recreate dependent" >&2
    cat "$TMP/output" >&2
    cat "$DOCKER_CALLS" >&2
    exit 1
fi

# 5) Parent start but dependent already on current netns → skip recreate
PARENT_STARTED='2026-07-14T11:00:00Z'
DEPENDENT_STARTED='2026-07-14T12:00:00Z'
DEPENDENT_STATE='running'
DEPENDENT_NETMODE="container:$PARENT_ID"
DEPENDENT_SANDBOX="$PARENT_NS"
PARENT_SANDBOX="$PARENT_NS"
DOCKER_EVENTS='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa start'
export PARENT_STARTED DEPENDENT_STARTED DEPENDENT_STATE DEPENDENT_NETMODE DEPENDENT_SANDBOX PARENT_SANDBOX DOCKER_EVENTS
run_watcher

if grep -Fq 'force-recreate' "$DOCKER_CALLS" || grep -Fq 'restart qbittorrent' "$DOCKER_CALLS"; then
    echo "FAIL: healthy matching netns still forced recreate" >&2
    cat "$TMP/output" >&2
    cat "$DOCKER_CALLS" >&2
    exit 1
fi
if ! grep -Fq 'skip recreate' "$TMP/output" && ! grep -Fq 'already on current' "$TMP/output"; then
    echo "FAIL: expected skip-recreate log for matching netns" >&2
    cat "$TMP/output" >&2
    exit 1
fi

# 6) Rapid duplicate start events: first recreates, second skips (netns matched after recreate)
PARENT_STARTED='2026-07-14T12:00:00Z'
DEPENDENT_STARTED='2026-07-14T11:00:00Z'
DEPENDENT_STATE='running'
DEPENDENT_NETMODE="container:$OTHER_ID"
DEPENDENT_SANDBOX="$STALE_NS"
PARENT_SANDBOX="$PARENT_NS"
DOCKER_EVENTS=$(printf '%s\n%s\n' \
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa start' \
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa start')
export PARENT_STARTED DEPENDENT_STARTED DEPENDENT_STATE DEPENDENT_NETMODE DEPENDENT_SANDBOX PARENT_SANDBOX DOCKER_EVENTS
run_watcher

recreate_count=$(grep -Fc 'force-recreate' "$DOCKER_CALLS" || true)
if [ "$recreate_count" -ne 1 ]; then
    echo "FAIL: expected exactly one recreate for debounced/duplicate starts, got $recreate_count" >&2
    cat "$TMP/output" >&2
    cat "$DOCKER_CALLS" >&2
    exit 1
fi
if ! grep -Fq 'skip recreate' "$TMP/output"; then
    echo "FAIL: second start should skip recreate after netns refresh" >&2
    cat "$TMP/output" >&2
    exit 1
fi

# 7) Short container NetworkMode id still counts as matched (no recreate)
PARENT_STARTED='2026-07-14T11:00:00Z'
DEPENDENT_STARTED='2026-07-14T12:00:00Z'
DEPENDENT_STATE='running'
DEPENDENT_NETMODE="container:$PARENT_SHORT"
DEPENDENT_SANDBOX="$PARENT_NS"
PARENT_SANDBOX="$PARENT_NS"
DOCKER_EVENTS='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa start'
export PARENT_STARTED DEPENDENT_STARTED DEPENDENT_STATE DEPENDENT_NETMODE DEPENDENT_SANDBOX PARENT_SANDBOX DOCKER_EVENTS
run_watcher

if grep -Fq 'force-recreate' "$DOCKER_CALLS"; then
    echo "FAIL: short NetworkMode id should count as current parent" >&2
    cat "$TMP/output" >&2
    cat "$DOCKER_CALLS" >&2
    exit 1
fi

echo 'PASS: gluetun watcher recovery, exact-id filter, debounce/netns skip, and event filtering'
