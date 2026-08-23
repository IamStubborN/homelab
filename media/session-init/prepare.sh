#!/bin/sh
set -eu

SESSION_DIR=/var/lib/media-orchestrator/session
SESSION_FILE="$SESSION_DIR/session.bin"

: "${SESSION_UID:?SESSION_UID is required}"
: "${SESSION_GID:?SESSION_GID is required}"

# The volume mount creates SESSION_DIR before this container starts. Only fix
# the directory and the known session snapshot; do not recursively rewrite
# ownership of unrelated files in the volume.
chown "$SESSION_UID:$SESSION_GID" "$SESSION_DIR"
if [ -f "$SESSION_FILE" ]; then
    chown "$SESSION_UID:$SESSION_GID" "$SESSION_FILE"
fi
