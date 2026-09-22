#!/bin/sh
# Следит за заполнением диска и пишет в Telegram, когда он забит выше порога.
#
# Зачем: 2026-09-22 диск забился под ноль core-дампами упавшего FlareSolverr, и
# заметили это только по 404 всех сервисов за Traefik. Сам Docker при этом не
# жалуется, а healthcheck'и молча падают.
set -u

THRESHOLD="${ALERT_AT_PERCENT:-85}"        # занято, %, начиная с которого тревога
INTERVAL="${CHECK_INTERVAL_SECONDS:-600}"  # как часто проверять
REMIND="${REMIND_EVERY_SECONDS:-21600}"    # не повторять тревогу чаще, чем раз в 6 ч
PATH_TO_CHECK="${WATCH_PATH:-/}"
NAME="${WATCH_NAME:-homelab}"
CHAT="${TELEGRAM_CHAT_ID:-}"
TOKEN_FILE="${TELEGRAM_TOKEN_FILE:-/run/secrets/telegram_bot_token}"

log() { printf '%s %s\n' "$(date -Iseconds)" "$*"; }

TOKEN=""
[ -r "$TOKEN_FILE" ] && TOKEN="$(tr -d '\n' < "$TOKEN_FILE")"

send() {
  text="$1"
  log "$text"
  if [ -z "$TOKEN" ] || [ -z "$CHAT" ]; then
    log "нет токена или chat_id — сообщение остаётся только в логе"
    return 0
  fi
  body=$(printf '{"chat_id":"%s","text":"%s"}' "$CHAT" "$text")
  if wget -q -T 15 -O /dev/null --header='Content-Type: application/json' \
       --post-data="$body" "https://api.telegram.org/bot${TOKEN}/sendMessage"; then
    log "отправлено в telegram"
  else
    log "не удалось отправить в telegram"
  fi
}

used_pct() { df -P "$PATH_TO_CHECK" 2>/dev/null | awk 'NR==2{gsub("%","",$5); print $5}'; }
free_h()   { df -h "$PATH_TO_CHECK" 2>/dev/null | awk 'NR==2{print $4}'; }

last_alert=0
alarm=0
log "старт: $NAME, путь $PATH_TO_CHECK, порог ${THRESHOLD}%, проверка каждые ${INTERVAL}s"

while :; do
  used="$(used_pct)"
  now="$(date +%s)"
  if [ -n "$used" ] && [ "$used" -ge "$THRESHOLD" ]; then
    if [ "$alarm" = "0" ] || [ $((now - last_alert)) -ge "$REMIND" ]; then
      send "Диск $NAME: занято ${used}%, свободно $(free_h). Порог ${THRESHOLD}%. Смотри core-дампы и логи контейнеров."
      last_alert="$now"
    fi
    alarm=1
  else
    if [ "$alarm" = "1" ]; then
      send "Диск $NAME снова в норме: занято ${used}%, свободно $(free_h)."
    fi
    alarm=0
  fi
  sleep "$INTERVAL"
done
