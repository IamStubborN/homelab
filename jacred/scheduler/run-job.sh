#!/usr/bin/env bash
# Run one JacRed HTTP job (crontab or manual).
# Usage: run-job.sh <name> <url> <max_time>
# JacRed returns status tokens, counts or per-category reports. Long jobs may start work in the
# background and return immediately; curl still has an overall --max-time.
# Overlap protection: flock on LOCK_DIR/<job>.lock.
set -euo pipefail

JOB_NAME="${1:?usage: run-job.sh <name> <url> <max_time>}"
JOB_URL="${2:?usage: run-job.sh <name> <url> <max_time>}"
MAX_TIME="${3:?usage: run-job.sh <name> <url> <max_time>}"
LOCK_DIR="${LOCK_DIR:-/tmp/jacred-cron-locks}"
CONNECT_TIMEOUT="${CURL_CONNECT_TIMEOUT:-10}"
# This directory uses the existing persistent log mount. Never back off saves
# or maintenance; these counters only govern new crawler HTTP submissions.
BACKOFF_DIR="${JACRED_BACKOFF_DIR:-/var/log/jacred/.scheduler-backoff}"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

if ! [[ "$MAX_TIME" =~ ^[1-9][0-9]*$ ]]; then
  log "ERROR: max_time must be a positive integer, got: ${MAX_TIME}"
  exit 1
fi

# Backup timers use UTC, unlike the local-time crawler crontab. Reserve the
# daily config/app-backup hour and the longer Sunday guest-backup window.
# This gates new submissions only: JacRed has no supported live crawl pause.
case "$JOB_NAME" in
  *-parse|*-ParseAllTask|*-ParseLatest|*-ParseShows|*-UpdateTasksParse|parseall-resume)
    read -r utc_day utc_hour < <(date -u '+%u %H')
    utc_hour=$((10#$utc_hour))
    if (( utc_hour == 2 || (utc_day == 7 && utc_hour >= 3 && utc_hour < 9) )); then
      log "SKIP ${JOB_NAME}: reserved UTC backup window; existing crawl/backoff unchanged"
      exit 0
    fi
    ;;
esac

mkdir -p "$LOCK_DIR"
LOCK_FILE="${LOCK_DIR}/${JOB_NAME}.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "SKIP ${JOB_NAME}: previous run still active"
  exit 0
fi

backoff_file=""
failures=0
next_attempt=0
case "$JOB_NAME" in
  *-parse|*-ParseAllTask|*-ParseLatest|*-ParseShows)
    mkdir -p "$BACKOFF_DIR"
    backoff_file="${BACKOFF_DIR}/${JOB_NAME}"
    if [[ -f "$backoff_file" ]]; then
      read -r failures next_attempt < "$backoff_file" || true
      if ! [[ "$failures" =~ ^[0-3]$ && "$next_attempt" =~ ^[0-9]{1,12}$ ]]; then
        failures=0
        next_attempt=0
      fi
    fi
    if (( $(date +%s) < next_attempt )); then
      log "SKIP ${JOB_NAME}: failure backoff until epoch ${next_attempt}"
      exit 0
    fi
    ;;
esac

record_failure() {
  [[ -n "$backoff_file" ]] || return 0
  failures=$(( failures < 3 ? failures + 1 : 3 ))
  local delay=$(( 21600 << (failures - 1) ))
  next_attempt=$(( $(date +%s) + delay ))
  local state_tmp
  state_tmp="$(mktemp "${backoff_file}.XXXXXX")"
  printf '%s %s\n' "$failures" "$next_attempt" > "$state_tmp"
  mv -f "$state_tmp" "$backoff_file"
  log "BACKOFF ${JOB_NAME}: failures=${failures} delay=${delay}s next=${next_attempt}"
}

log "START ${JOB_NAME} url=${JOB_URL} max_time=${MAX_TIME}s"
start_ts="$(date +%s)"

# Body on stdout; HTTP code via -w. Overall --max-time prevents infinite hangs.
tmp="$(mktemp)"
trap 'rm -f "$tmp" "${tmp}.code" "${tmp}.err"' EXIT

http_code="000"
curl_rc=0
if curl -sS --connect-timeout "$CONNECT_TIMEOUT" --max-time "$MAX_TIME" \
  -o "$tmp" -w '%{http_code}' "$JOB_URL" >"${tmp}.code" 2>"${tmp}.err"; then
  http_code="$(tr -d '\n' <"${tmp}.code")"
  body="$(tr -d '\r' <"$tmp")"
else
  curl_rc=$?
  err="$(tr '\n' ' ' <"${tmp}.err" 2>/dev/null || true)"
  http_code="$(tr -d '\n' <"${tmp}.code" 2>/dev/null || echo 000)"
  # curl exit 28 = operation timeout
  if [[ "$curl_rc" -eq 28 ]]; then
    body="TIMEOUT after ${MAX_TIME}s${err:+: ${err}}"
  else
    body="curl-error${err:+: ${err}}"
  fi
fi

body="${body//$'\n'/ }"
body="${body#"${body%%[![:space:]]*}"}"
body="${body%"${body##*[![:space:]]}"}"

elapsed="$(( $(date +%s) - start_ts ))"

if (( curl_rc != 0 )); then
  if (( curl_rc == 28 )); then
    log "TIMEOUT ${JOB_NAME}: ${body} (http=${http_code} ${elapsed}s)"
  else
    log "FAILED ${JOB_NAME}: transport error (curl=${curl_rc} http=${http_code} ${elapsed}s)"
  fi
  record_failure
  exit 1
fi

# An accepted asynchronous job is not proof of crawler completion. Failures
# inside that job remain the application's responsibility; do not cancel it.
reply="${body,,}"
if [[ ! "$http_code" =~ ^2[0-9][0-9]$ || "$reply" =~ ^(error|fail|failed|failure|login[[:space:]]+(error|failed))([[:space:]:]|$) || "$reply" == "config missing" || "$reply" == "takelogin == null" ]]; then
  log "FAILED ${JOB_NAME}: HTTP/application error (http=${http_code} ${elapsed}s)"
  record_failure
  exit 1
fi

# Recognize explicit acknowledgements, not merely HTTP 2xx. Rutor/Megapeer
# use category - page / bool; Rutracker uses category - page - bool.
# False can mean an empty listing, blocked HTML or a failed upstream fetch.
# Require every reported result to be True before clearing earlier failures.
positive=false
case "$reply" in
  ok|scheduled) positive=true ;;
  work|work_login|disabled|syncapi|idle)
    log "SKIP ${JOB_NAME}: ${reply}; backoff unchanged (http=${http_code} ${elapsed}s)"
    exit 0
    ;;
esac
case "$JOB_NAME" in
  rutor-parse|megapeer-parse|rutracker-parse)
    if [[ "$reply" =~ ^[0-9]+[[:space:]]+-[[:space:]]+[0-9]+[[:space:]]+[/\-][[:space:]]+true([[:space:]]+[0-9]+[[:space:]]+-[[:space:]]+[0-9]+[[:space:]]+[/\-][[:space:]]+true)*$ ]]; then
      positive=true
    fi
    ;;
  mazepa-parse)
    [[ "$reply" =~ ^ok[[:space:]]+[0-9]+$ ]] && positive=true
    ;;
  bitru-parse)
    [[ "$reply" =~ ^saved[[:space:]]+[1-9][0-9]*$ ]] && positive=true
    ;;
  knaben-parse)
    if [[ "$reply" =~ ^fetched=([0-9]+)[[:space:]]+\+[0-9]+[[:space:]]+~[0-9]+[[:space:]]+=[0-9]+[[:space:]]+failed=([0-9]+)$ ]]; then
      fetched="${BASH_REMATCH[1]}"
      failed="${BASH_REMATCH[2]}"
      if [[ "$failed" =~ [1-9] ]]; then
        # Missing magnets or failed per-item downloads do not prove job failure.
        log "UNKNOWN ${JOB_NAME}: reported item failures; backoff unchanged (http=${http_code} ${elapsed}s)"
        exit 2
      fi
      # Zero fetched also covers an invalid API response in this endpoint.
      [[ "$fetched" =~ [1-9] ]] && positive=true
    fi
    ;;
  ultradox-ParseLatest)
    # Only listingOk pages are included in this endpoint's report.
    [[ "$reply" =~ ^[a-z-]+[[:space:]]+-[[:space:]]+[0-9]+([[:space:]]+[a-z-]+[[:space:]]+-[[:space:]]+[0-9]+)*$ ]] && positive=true
    ;;
esac
if [[ "$positive" != true ]]; then
  log "UNKNOWN ${JOB_NAME}: no explicit success; backoff unchanged (http=${http_code} ${elapsed}s)"
  exit 2
fi
if [[ -n "$backoff_file" && -f "$backoff_file" ]]; then
  rm -f -- "$backoff_file"
fi
log "SUCCESS ${JOB_NAME}: acknowledged response; backoff cleared (http=${http_code} ${elapsed}s)"
exit 0
