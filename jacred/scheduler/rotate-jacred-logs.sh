#!/usr/bin/env bash
# Rotate JacRed's file logs without stopping the application.
set -euo pipefail

LOG_DIR="${JACRED_LOG_DIR:-/var/log/jacred}"
MAX_BYTES="${JACRED_LOG_MAX_BYTES:-52428800}"
KEEP="${JACRED_LOG_KEEP:-5}"

rotate_copytruncate() {
  local file="$1"
  local index

  [[ -f "$file" ]] || return 0
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

rotate_copytruncate "$LOG_DIR/tracks.log"
