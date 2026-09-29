#!/usr/bin/env bash
# Run only inside the new Debian 13 PBS pilot container.
set -Eeuo pipefail
export DEBIAN_FRONTEND=noninteractive
. /etc/os-release
[[ "$VERSION_CODENAME" == trixie ]]
test -s /usr/share/keyrings/proxmox-archive-keyring.gpg
cat > /etc/apt/sources.list.d/pbs.sources <<'REPO'
Types: deb
URIs: http://download.proxmox.com/debian/pbs
Suites: trixie
Components: pbs-no-subscription
Signed-By: /usr/share/keyrings/proxmox-archive-keyring.gpg
REPO
apt-get update
apt-get install -y --no-install-recommends proxmox-backup-server restic rclone ca-certificates jq
