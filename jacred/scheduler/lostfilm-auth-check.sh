#!/usr/bin/env bash
# Alert once in Telegram when LostFilm magnets stop resolving, which means the
# session cookie in JacRed's init.yaml expired, and once when they recover.
# LostFilm still lists releases without a valid cookie; only expanding them to
# magnets fails, which the parser reports as expandFailed/noMagnet. A single
# failed item is a site hiccup; most of a run failing is the cookie.
set -euo pipefail

LOG="${LOSTFILM_LOG:-/var/log/jacred/lostfilm.log}"
STATE="${LOSTFILM_AUTH_STATE:-/var/log/jacred/.scheduler-backoff/lostfilm-auth}"
TOKEN_FILE="${TELEGRAM_TOKEN_FILE:-/run/secrets/telegram_bot_token}"
CHAT="${TELEGRAM_CHAT_ID:-}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

send() {
  log "$1"
  [[ -r "$TOKEN_FILE" && -n "$CHAT" ]] || { log "no Telegram token or chat id; not sent"; return 0; }
  local body
  body=$(printf '{"chat_id":"%s","text":"%s"}' "$CHAT" "$1")
  # The URL holds the token, so curl's own errors stay silent.
  curl -fsS -o /dev/null --max-time 15 -H 'Content-Type: application/json' -d "$body" \
    "https://api.telegram.org/bot$(tr -d '\n' < "$TOKEN_FILE")/sendMessage" 2>/dev/null \
    || log "Telegram delivery failed"
}

[[ -r "$LOG" ]] || { log "no LostFilm log yet"; exit 0; }

# Collected and failed items of the most recent completed run.
read -r collected failed finished < <(awk '
  / Parse .* start$/ { collected = 0; failed = 0; finished = 0 }
  / Page [0-9]+: collected [0-9]+ items/ { for (i = 1; i <= NF; i++) if ($i == "collected") collected += $(i + 1) }
  / Page [0-9]+: added=/ { for (i = 1; i <= NF; i++) if ($i ~ /^(noMagnet|expandFailed)=/) { split($i, kv, "="); failed += kv[2] } }
  / Parse done/ { finished = 1 }
  END { print collected + 0, failed + 0, finished + 0 }' "$LOG")
(( finished )) || { log "no completed LostFilm run in the log"; exit 0; }

mkdir -p "$(dirname "$STATE")"

previous=$(cat "$STATE" 2>/dev/null || echo ok)
if (( failed > 0 && failed * 2 >= collected )); then
  if [[ "$previous" != expired ]]; then
    send "JacRed: LostFilm не отдаёт magnet-ссылки (${failed} ошибок в последнем парсинге). Похоже, cookie истёк: обнови его через jacred/set-lostfilm-cookie.sh."
    echo expired > "$STATE"
  fi
elif [[ "$previous" == expired ]]; then
  send "JacRed: LostFilm снова отдаёт magnet-ссылки."
  echo ok > "$STATE"
fi
log "lostfilm-auth-check: collected=${collected} failed=${failed} state=$(cat "$STATE" 2>/dev/null || echo ok)"
