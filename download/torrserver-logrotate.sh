#!/bin/sh
set -eu

# Run as the deployment user from host cron once the persistent bind is live.
# Do not rotate a staging copy while the running container still uses overlay.
download_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
log_dir="$download_dir/torrserver/log"
mounted_dir=$(docker inspect torrserver --format '{{range .Mounts}}{{if eq .Destination "/opt/ts/log"}}{{.Source}}{{end}}{{end}}')
[ "$mounted_dir" = "$log_dir" ] || exit 0
[ -f "$log_dir/torrserver.log" ] || exit 0
[ ! -L "$log_dir/torrserver.log" ] || exit 1

# TorrServer runs as root and may recreate its log on startup. Normalize only
# this file so the deployment user's host cron can copytruncate it again.
docker exec --user 0 torrserver sh -ec '
    chown "$1" /opt/ts/log/torrserver.log
    chmod u+rw /opt/ts/log/torrserver.log
' sh "$(id -u):$(id -g)"

config=$(mktemp)
trap 'rm -f "$config"' EXIT HUP INT TERM
cat > "$config" <<EOF
"$log_dir/torrserver.log" {
    size 10M
    rotate 3
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
EOF

/usr/sbin/logrotate "$@" --state "$log_dir/logrotate.status" "$config"
