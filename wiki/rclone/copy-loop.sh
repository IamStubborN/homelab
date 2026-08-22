#!/bin/sh
set -eu
DEST="${RCLONE_DEST:-drive:HealthWiki/}"
# One-way vault → Drive. Never bisync. Never rsync.
# First rollout: copy (no deletes). After a user-accepted dry-run of
# `rclone sync`, T9 / the operator may switch the subcommand to sync.
while true; do
  rclone copy /data "$DEST" \
    --exclude-from /etc/rclone/exclude.txt \
    --fast-list \
    --transfers 2 \
    --checkers 4 \
    --drive-chunk-size 8M \
    --log-level INFO \
    || echo "health-drive: rclone copy failed; retrying after 86400s" >&2
  sleep 86400
done
