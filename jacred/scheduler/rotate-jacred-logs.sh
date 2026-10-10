#!/usr/bin/env bash
# Rotate JacRed's file logs without stopping the application.
set -euo pipefail

LOG_DIR="${JACRED_LOG_DIR:-/var/log/jacred}"
MAX_BYTES="${JACRED_LOG_MAX_BYTES:-52428800}"
KEEP="${JACRED_LOG_KEEP:-5}"

[[ "$MAX_BYTES" =~ ^[1-9][0-9]*$ && "$KEEP" =~ ^[1-9][0-9]*$ ]] || exit 1
[[ -d "$LOG_DIR" ]] || exit 0
exec 9>"$LOG_DIR/.rotation.lock"
flock -n 9 || exit 0

rotate_copytruncate() {
  local file="$1"
  local index

  [[ -f "$file" && ! -L "$file" ]] || return 0
  [[ "$(stat -c '%s' "$file")" -gt "$MAX_BYTES" ]] || return 0

  for ((index=KEEP; index>=1; index--)); do
    if (( index == KEEP )); then
      rm -f "${file}.${index}"
    elif [[ -f "${file}.${index}" ]]; then
      mv "${file}.${index}" "${file}.$((index + 1))"
    fi
  done

  cp -p "$file" "${file}.1"
  : > "$file"
}

# Only regular top-level .log files: no databases, checkpoints or directories.
shopt -s nullglob
for file in "$LOG_DIR"/*.log; do
  rotate_copytruncate "$file"
done
