#!/usr/bin/env bash
# Nightly Lampac runtime update through update-runtime.py: when upstream
# `latest` has a new digest, stage and check a candidate, wait until Lampa is
# idle, apply it, and roll back if the result is not healthy. Reports to
# Telegram through the disk-watchdog's bot and chat.
set -euo pipefail

ROOT=${LAMPA_ROOT:-/home/iamstubborn/homelab}
STATE=/var/lib/lampac-update
UPSTREAM=ghcr.io/lampac-nextgen/lampac
DEADLINE_HOUR=04          # give up waiting for idle at 04:00 Europe/Sofia
IDLE_MINUTES=5
IDLE_MIB_PER_MINUTE=3
KEEP_GENERATIONS=3
DRY_RUN=${DRY_RUN:-}

tool() { python3 "$ROOT/lampa/update-runtime.py" --root "$ROOT" "$@"; }

notify() {
  echo "$1"
  [ -z "$DRY_RUN" ] || return 0
  local token chat
  token=$(docker exec disk-watchdog cat /run/secrets/telegram_bot_token 2>/dev/null) || return 0
  chat=$(docker exec disk-watchdog printenv TELEGRAM_CHAT_ID 2>/dev/null) || return 0
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

lampa_tx() { docker exec lampa awk '/eth0/{print $10}' /proc/net/dev; }

# Lampa is idle when it sent less than IDLE_MIB_PER_MINUTE in each of the last
# IDLE_MINUTES minutes. Browser (GST) and proxied online playback flow through it.
wait_for_idle() {
  local idle=0 prev cur
  prev=$(lampa_tx)
  while [ "$idle" -lt "$IDLE_MINUTES" ]; do
    [ "$(TZ=Europe/Sofia date +%H)" != "$DEADLINE_HOUR" ] || return 1
    sleep 60
    cur=$(lampa_tx)
    if [ $(( (cur - prev) / 1048576 )) -lt "$IDLE_MIB_PER_MINUTE" ]; then idle=$((idle + 1)); else idle=0; fi
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

# Keep image tags and state for the running image and its rollback baseline;
# drop older candidate/rollback tags and generations.
cleanup() {
  local keep_current keep_previous tag id
  keep_current=$(pending candidate)
  keep_previous=$(pending previous)
  while read -r tag id; do
    [ "$id" = "$keep_current" ] || [ "$id" = "$keep_previous" ] || docker image rm "$tag" >/dev/null
  done < <(docker images --no-trunc --format '{{.Repository}}:{{.Tag}} {{.ID}}' homelab/lampac-intel \
             | grep -E ':(candidate|rollback)-[0-9]{8}T[0-9]{6}Z-[0-9a-f]+ ' || true)
  find "$STATE" -mindepth 1 -maxdepth 1 -type d -name '20*' -printf '%f\n' | sort -r \
    | tail -n +$((KEEP_GENERATIONS + 1)) | while read -r generation; do
      [ "$generation" = "$(pending generation)" ] || rm -r -- "${STATE:?}/$generation"
    done
}

# staged/checked: an earlier night stopped before applying; start over.
phase=$(pending phase)
case "$phase" in
  applied|rolled-back|staged|checked) ;;
  *) notify "Lampac: предыдущее обновление не завершено (phase=$phase), нужна ручная проверка."; exit 1 ;;
esac

docker pull -q "$UPSTREAM:latest" >/dev/null
latest=$(docker image inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$UPSTREAM:latest" | grep -m1 "^$UPSTREAM@")
# After a rollback the failed digest is recorded too, so it is not retried.
if [ "$latest" = "$(pending upstream)" ] && { [ "$phase" = applied ] || [ "$phase" = rolled-back ]; }; then
  echo "Lampac upstream unchanged ($latest, $phase)."
  exit 0
fi
echo "New Lampac upstream: $latest (running $(pending upstream))."
if [ -n "$DRY_RUN" ]; then
  echo "DRY_RUN: would stage, check, wait for idle and apply."
  exit 0
fi

if ! tool stage || ! tool check; then
  notify "Lampac: новая версия не прошла сборку или проверку, работает текущая. Логи: $STATE/$(pending generation)"
  exit 1
fi
if ! wait_for_idle; then
  echo "Lampa was not idle before ${DEADLINE_HOUR}:00; trying again next night."
  exit 0
fi
if tool apply --maintenance-window && healthy; then
  cleanup
  notify "Lampac обновлён до новой версии upstream."
  exit 0
fi
if tool rollback --maintenance-window && healthy; then
  notify "Lampac: новая версия не запустилась, откатил на прежнюю. Логи: $STATE/$(pending generation)"
else
  notify "Lampac: обновление и откат не удались, Lampa может не работать. Нужна ручная проверка."
fi
exit 1
