#!/usr/bin/env bash
# Nightly Lampac runtime update through update-runtime.py: when upstream
# `latest` has a new digest, wait until Lampa is idle, stage and check a
# candidate, apply it, and roll back if Lampa does not become healthy.
# Reports to Telegram through the disk-watchdog's bot and chat.
# DRY_RUN=1 only reports whether an update is due.
set -euo pipefail

ROOT=${LAMPA_ROOT:-/home/iamstubborn/homelab}
STATE=${LAMPAC_UPDATE_STATE:-/var/lib/lampac-update}
AUTO=$STATE/auto                 # this script's own state
UPSTREAM=ghcr.io/lampac-nextgen/lampac
# Last moment to start an apply: a failed one waits up to 10 minutes for HTTP,
# and its rollback must still finish before systemd's 75-minute limit.
DEADLINE=$(( $(date +%s) + 45 * 60 ))
IDLE_MINUTES=5
IDLE_MIB_PER_MINUTE=3
KEEP_GENERATIONS=3
DRY_RUN=${DRY_RUN:-}

tool() { python3 "$ROOT/lampa/update-runtime.py" "$@" --root "$ROOT" --state-dir "$STATE"; }

notify() {
  echo "$1"
  [ -z "$DRY_RUN" ] || return 0
  local token chat
  if ! token=$(docker exec disk-watchdog cat /run/secrets/telegram_bot_token 2>/dev/null) \
     || ! chat=$(docker exec disk-watchdog printenv TELEGRAM_CHAT_ID 2>/dev/null); then
    echo "Telegram not delivered: disk-watchdog unavailable"
    return 0
  fi
  TELEGRAM_TOKEN=$token python3 - "$chat" "$1" <<'EOF' || echo "Telegram delivery failed"
import json, os, sys, urllib.request
token = os.environ["TELEGRAM_TOKEN"].strip()
body = json.dumps({"chat_id": sys.argv[1], "text": sys.argv[2]}).encode()
request = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage", body,
                                 {"Content-Type": "application/json"})
try:
    urllib.request.urlopen(request, timeout=15).read()
except Exception:
    sys.exit(1)  # the URL holds the token: never print the exception
EOF
}

pending() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], ""))' "$STATE/pending.json" "$1"; }

# Upstream digests that failed here are not retried until upstream moves on.
mark_failed() { echo "$latest" > "$AUTO/failed-upstream"; }
RETRY="Повторить следующей ночью: rm $AUTO/failed-upstream"

# Bytes Lampa sent on every interface but lo (Docker does not keep the
# interface order across recreates); empty when they cannot be read.
lampa_tx() { docker exec lampa awk -F'[: ]+' 'NR>2 && $2!="lo"{s+=$11} END{print s+0}' /proc/net/dev 2>/dev/null || true; }

# Lampa is idle when it sent less than IDLE_MIB_PER_MINUTE in each of the last
# IDLE_MINUTES minutes. Browser (GST) and proxied online playback flow through
# it; a paused player sends nothing and is not detected. A failed read or a
# counter that went back counts as busy.
wait_for_idle() {
  local idle=0 prev cur
  prev=$(lampa_tx)
  while [ "$idle" -lt "$IDLE_MINUTES" ]; do
    [ "$(date +%s)" -lt "$DEADLINE" ] || return 1
    sleep 60
    cur=$(lampa_tx)
    if [ -n "$prev" ] && [ -n "$cur" ] && [ "$cur" -ge "$prev" ] &&
       [ $(( (cur - prev) / 1048576 )) -lt "$IDLE_MIB_PER_MINUTE" ]; then
      idle=$((idle + 1))
    else
      idle=0
    fi
    prev=$cur
  done
}

healthy() {
  local status
  for _ in $(seq 60); do
    status=$(docker inspect -f '{{.State.Health.Status}}' lampa 2>/dev/null || true)
    [ "$status" = healthy ] && return 0
    sleep 5
  done
  return 1
}

# Keep image tags and state for pending.json's candidate and previous image
# (after a failure: the failed candidate, kept for diagnosis, and the running
# image); drop older candidate/rollback tags and generations. Runs after every
# outcome except a failed rollback. Failures only log.
cleanup() {
  local keep_current keep_previous tag id generation
  keep_current=$(pending candidate)
  keep_previous=$(pending previous)
  while read -r tag id; do
    [ "$id" = "$keep_current" ] || [ "$id" = "$keep_previous" ] \
      || docker image rm "$tag" >/dev/null || echo "Could not remove $tag"
  done < <(docker images --no-trunc --format '{{.Repository}}:{{.Tag}} {{.ID}}' homelab/lampac-intel \
             | grep -E ':(candidate|rollback)-[0-9]{8}T[0-9]{6}Z-[0-9a-f]+ ' || true)
  while read -r generation; do
    [ "$generation" = "$(pending generation)" ] || rm -r -- "${STATE:?}/$generation" || echo "Could not remove $generation"
  done < <(find "$STATE" -mindepth 1 -maxdepth 1 -type d -name '20*' -printf '%f\n' | sort -r | tail -n +$((KEEP_GENERATIONS + 1)))
}

mkdir -p "$AUTO"

if [ ! -s "$STATE/pending.json" ]; then
  notify "Lampac: нет $STATE/pending.json, автообновление невозможно."
  exit 1
fi
# staged/checked: an earlier night stopped before applying; start over.
phase=$(pending phase)
case "$phase" in
  applied|rolled-back|staged|checked) ;;
  *) notify "Lampac: предыдущее обновление не завершено (phase=$phase), нужна ручная проверка."; exit 1 ;;
esac

# After a rollback Lampa runs from the saved service model, not the root
# Compose files; update-runtime.py refuses to stage until it is reconciled.
config_files=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' lampa 2>/dev/null || true)
if [[ "$config_files" == *"$STATE"* ]]; then
  if [ ! -e "$AUTO/reconcile-notified" ]; then
    notify "Lampac: после отката Lampa запущена из сохранённой модели. Автообновление ждёт ручной сверки Compose (UPDATE.md, Failure recovery)."
    [ -n "$DRY_RUN" ] || touch "$AUTO/reconcile-notified"
  fi
  exit 1
fi
rm -f "$AUTO/reconcile-notified"

if ! docker pull -q "$UPSTREAM:latest" >/dev/null 2>&1 \
   || ! latest=$(docker image inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$UPSTREAM:latest" | grep -m1 "^$UPSTREAM@"); then
  notify "Lampac: не удалось получить upstream-образ, обновление пропущено."
  exit 1
fi
# A rolled-back digest is not deployed: failed-upstream alone keeps it from
# being retried, so removing that file retries it.
if [ "$latest" = "$(pending upstream)" ] && [ "$phase" = applied ]; then
  echo "Lampac upstream unchanged ($latest, $phase)."
  exit 0
fi
if [ "$latest" = "$(cat "$AUTO/failed-upstream" 2>/dev/null)" ]; then
  echo "Lampac upstream $latest failed here before; waiting for a newer one."
  exit 0
fi
echo "New Lampac upstream: $latest (running $(pending upstream))."

# stage refuses while the Lampa container does not match the root Compose
# model (config-hash, Compose files, project directory). That is an unapplied
# local edit, not a bad upstream: report it once per mismatch and retry every
# night without marking the upstream failed.
compose_files=(-f compose.yml)
expected_files=$ROOT/compose.yml
if [ -e "$ROOT/compose.override.yml" ]; then
  compose_files+=(-f compose.override.yml)
  expected_files+=",$ROOT/compose.override.yml"
fi
model_hash=$(cd "$ROOT" && docker compose -p homelab "${compose_files[@]}" config --hash lampa 2>/dev/null \
               | sed -nE 's/^lampa[[:blank:]]+([0-9a-f]{64})$/\1/p') || model_hash=
deployed=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.config-hash"}} {{index .Config.Labels "com.docker.compose.project.config_files"}} {{index .Config.Labels "com.docker.compose.project.working_dir"}}' lampa 2>/dev/null) || deployed=
if [ -z "$model_hash" ]; then
  drift=invalid
  message="Lampac: Compose-модель Lampa не собирается (или нет config --hash), обновление ждёт. Проверь: cd $ROOT && sudo docker compose config --quiet"
elif [ "$deployed" != "$model_hash $expected_files $ROOT" ]; then
  drift="$model_hash $deployed"
  message="Lampac: правки Compose для Lampa не применены к контейнеру, обновление ждёт. В простое: cd $ROOT && sudo docker compose config --quiet && sudo docker compose up -d --no-deps --no-build --pull never --force-recreate lampa"
else
  drift=
fi
if [ -n "$drift" ]; then
  if [ "$(cat "$AUTO/drift-notified" 2>/dev/null)" != "$drift" ]; then
    notify "$message"
    [ -n "$DRY_RUN" ] || echo "$drift" > "$AUTO/drift-notified"
  fi
  exit 1
fi
rm -f "$AUTO/drift-notified"

if [ -n "$DRY_RUN" ]; then
  echo "DRY_RUN: would wait for idle, stage, check and apply."
  exit 0
fi

# Building and checking load the CPU too, so wait for idle before them, and
# again right before the restart.
if ! wait_for_idle; then
  skipped=$(( $(cat "$AUTO/busy-nights" 2>/dev/null || echo 0) + 1 ))
  echo "$skipped" > "$AUTO/busy-nights"
  echo "Lampa was not idle before the deadline; trying again next night."
  [ "$skipped" -ne 3 ] || notify "Lampac: третью ночь подряд Lampa занята с 03:00 до 04:00, обновление не установлено."
  exit 0
fi
rm -f "$AUTO/busy-nights"
# Building and checking take a while; do not let them run into Watchtower (04:00).
if [ $(( DEADLINE - $(date +%s) )) -lt 1800 ]; then
  echo "Too close to the deadline to build; trying again next night."
  exit 0
fi

if ! tool stage; then
  mark_failed
  notify "Lampac: stage новой версии не удался (сборка или несовпадение с развёрнутым Compose), работает текущая. Логи в $STATE (последняя папка). $RETRY"
  cleanup
  exit 1
fi
if ! tool check; then
  mark_failed
  notify "Lampac: новая версия не прошла проверку, работает текущая. Логи: $STATE/$(pending generation). $RETRY"
  cleanup
  exit 1
fi
if ! wait_for_idle; then
  echo "Lampa became busy or the deadline passed; trying again next night."
  exit 0
fi

if tool apply --maintenance-window && healthy; then
  rm -f "$AUTO/failed-upstream"
  notify "Lampac обновлён до новой версии upstream."
  cleanup
  exit 0
fi
mark_failed
phase=$(pending phase)
case "$phase" in
  stopping|backed-up|applied|restoring) ;;
  *)
    notify "Lampac: установка отказалась начинаться (phase=$phase), работает текущая версия. Логи: $STATE/$(pending generation). $RETRY"
    cleanup
    exit 1
    ;;
esac
if tool rollback --maintenance-window && healthy; then
  notify "Lampac: новая версия не запустилась, откатил на прежнюю. Автообновление ждёт ручной сверки Compose (UPDATE.md, Failure recovery). Логи: $STATE/$(pending generation)"
  cleanup
else
  notify "Lampac: обновление и откат не удались, Lampa может не работать. Нужна ручная проверка."
fi
exit 1
