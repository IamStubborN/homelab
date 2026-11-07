#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

: "${ROUTER_VM_ID:?Set ROUTER_VM_ID in the private Proxmox environment}"
: "${DOCKER_CT_ID:?Set DOCKER_CT_ID in the private Proxmox environment}"
[[ "$ROUTER_VM_ID" =~ ^[1-9][0-9]*$ && "$DOCKER_CT_ID" =~ ^[1-9][0-9]*$ ]] || exit 64

readonly LOCAL_BACKUP_DIR=/var/lib/vz/dump
readonly REMOTE_ROOT='homelab-backups:Proxmox'
readonly AGE_HELPER=/usr/local/libexec/homelab-age-upload
readonly LOCK_FILE=/run/lock/homelab-google-drive-backup.lock

exec 9>"${LOCK_FILE}"
# The nightly backups run minutes apart: wait for the previous one (or the
# host update) instead of skipping, up to 30 minutes.
if ! flock -w 1800 9; then
  echo "Another homelab backup job held the lock for 30 minutes" >&2
  exit 75
fi

for command in age awk basename date find flock mv pct pvesm python3 rclone rm sort stat tar vzdump zstd; do
  command -v "${command}" >/dev/null || {
    echo "Required command is missing: ${command}" >&2
    exit 69
  }
done

upload_file() {
  "${AGE_HELPER}" upload "$1" "$2"
}

prune_remote() {
  "${AGE_HELPER}" prune "$1" "$2.age" "$3" "$(basename "$4").age"
}

cleanup_file() {
  rm -f -- "$1" "$1.age" "$1.age.meta.json"
}

upload_guest_archive() {
  local kind=$1
  local archive=$2
  local remote_directory pattern regex keep sidecar archive_name log_file

  case "${kind}" in
    opnsense)
      remote_directory="${REMOTE_ROOT}/OPNsense/full-vm"
      pattern="vzdump-qemu-${ROUTER_VM_ID}-*.vma.zst"
      regex="^vzdump-qemu-${ROUTER_VM_ID}-.*\.vma\.zst$"
      log_file="${archive%.vma.zst}.log"
      keep=5
      ;;
    docker)
      remote_directory="${REMOTE_ROOT}/Docker/full-lxc"
      pattern="vzdump-lxc-${DOCKER_CT_ID}-*.tar.zst"
      regex="^vzdump-lxc-${DOCKER_CT_ID}-.*\.tar\.zst$"
      log_file="${archive%.tar.zst}.log"
      keep=5
      ;;
    *)
      echo "Unsupported guest kind: ${kind}" >&2
      exit 64
      ;;
  esac

  [[ "${archive}" == "${LOCAL_BACKUP_DIR}/"* ]] || {
    echo "Archive must be inside ${LOCAL_BACKUP_DIR}" >&2
    exit 64
  }
  [[ -f "${archive}" ]] || {
    echo "Archive does not exist: ${archive}" >&2
    exit 66
  }
  archive_name=$(basename "${archive}")
  if [[ ! "${archive_name}" =~ ${regex} ]]; then
    echo "Archive does not match ${pattern}: ${archive}" >&2
    exit 66
  fi

  zstd -tq "${archive}"
  pvesm extractconfig "local:backup/$(basename "${archive}")" >/dev/null
  upload_file "${archive}" "${remote_directory}"

  for sidecar in "${archive}.notes" "${log_file}"; do
    [[ -f "${sidecar}" ]] && upload_file "${sidecar}" "${remote_directory}"
  done

  prune_remote "${remote_directory}" "${pattern}" "${keep}" "${archive}"
  cleanup_file "${archive}"
  cleanup_file "${archive}.notes"
  cleanup_file "${log_file}"
}

latest_archive() {
  local pattern=$1
  find "${LOCAL_BACKUP_DIR}" -maxdepth 1 -type f -name "${pattern}" \
    -printf '%T@ %p\n' | sort -nr | awk 'NR == 1 {$1=""; sub(/^ /, ""); print; exit}'
}

backup_opnsense_config() {
  local timestamp archive
  timestamp=$(date -u '+%Y_%m_%d-%H_%M_%S')
  archive="${LOCAL_BACKUP_DIR}/opnsense-config-${timestamp}.tar.gz"
  chmod 700 -- "${LOCAL_BACKUP_DIR}"
  /usr/local/libexec/homelab-opnsense-config-backup "${archive}"
  upload_file "${archive}" "${REMOTE_ROOT}/OPNsense/config"
  prune_remote "${REMOTE_ROOT}/OPNsense/config" 'opnsense-config-*.tar.gz' 5 "${archive}"
  cleanup_file "${archive}"
}

backup_opnsense() {
  local archive
  vzdump "$ROUTER_VM_ID" --storage local --mode snapshot --compress zstd --remove 0 \
    --notes-template "Router VM ${ROUTER_VM_ID} full backup"
  archive=$(latest_archive "vzdump-qemu-${ROUTER_VM_ID}-*.vma.zst")
  [[ -n "${archive}" ]] || exit 66
  upload_guest_archive opnsense "${archive}"
}

backup_docker() {
  local archive
  # Keep archives private throughout creation, including failed partial files.
  chmod 700 -- "${LOCAL_BACKUP_DIR}"
  # Mapped LXC root must traverse its temporary config tree outside dumpdir.
  (
    umask 022
    vzdump "$DOCKER_CT_ID" --storage local --mode snapshot --compress zstd --remove 0 --tmpdir /var/tmp \
      --exclude-path /var/lib/homelab-app-backup \
      --notes-template "Docker container ${DOCKER_CT_ID} full rootfs backup; external bind mounts excluded"
  )
  archive=$(latest_archive "vzdump-lxc-${DOCKER_CT_ID}-*.tar.zst")
  [[ -n "${archive}" ]] || exit 66
  chmod 600 -- "${archive}"
  upload_guest_archive docker "${archive}"
}

backup_host_config() {
  local timestamp archive
  timestamp=$(date -u '+%Y_%m_%d-%H_%M_%S')
  archive="${LOCAL_BACKUP_DIR}/proxmox-host-config-${timestamp}.tar.zst"

  chmod 700 -- "${LOCAL_BACKUP_DIR}"
  /usr/local/libexec/homelab-host-config-backup "${archive}"

  zstd -tq "${archive}"
  upload_file "${archive}" "${REMOTE_ROOT}/host-config"
  prune_remote "${REMOTE_ROOT}/host-config" 'proxmox-host-config-*.tar.zst' 5 "${archive}"
  cleanup_file "${archive}"
}

upload_app_capture() {
  local stage name stamp archive partial
  stage=$1
  name=${stage##*/}
  [[ "${name}" =~ ^capture-[0-9]{8}T[0-9]{6}Z$ ]] || {
    echo "Unexpected application capture name" >&2
    exit 66
  }
  stamp=${name#capture-}
  archive="${LOCAL_BACKUP_DIR}/apps-${stamp:0:4}_${stamp:4:2}_${stamp:6:2}-${stamp:9:2}_${stamp:11:2}_${stamp:13:2}.tar.zst"
  partial="${archive}.partial"
  chmod 700 -- "${LOCAL_BACKUP_DIR}"
  if [[ ! -f "${archive}" ]]; then
    trap 'rm -f -- "${partial}"' EXIT
    pct exec "$DOCKER_CT_ID" -- tar --numeric-owner -C "${stage}" -cf - . | zstd -T1 -3 -q -o "${partial}"
    zstd -tq "${partial}"
    mv -- "${partial}" "${archive}"
    trap - EXIT
  fi
  zstd -tq "${archive}"
  upload_file "${archive}" "${REMOTE_ROOT}/Docker/apps"
  prune_remote "${REMOTE_ROOT}/Docker/apps" 'apps-*.tar.zst' 7 "${archive}"
  pct exec "$DOCKER_CT_ID" -- /usr/local/sbin/homelab-app-data-backup complete "${stage}" >/dev/null
  cleanup_file "${archive}"
}

backup_apps() {
  local stage capture_day
  stage=$(pct exec "$DOCKER_CT_ID" -- /usr/local/sbin/homelab-app-data-backup prepare)
  if [[ -n "${stage}" ]]; then
    capture_day=${stage##*/}
    capture_day=${capture_day#capture-}
    capture_day=${capture_day:0:8}
    upload_app_capture "${stage}"
    # Catch up immediately after an outage instead of treating yesterday's
    # retried upload as today's application backup.
    [[ "${capture_day}" < "$(date -u '+%Y%m%d')" ]] || return 0
  fi
  stage="/var/lib/homelab-app-backup/capture-$(date -u '+%Y%m%dT%H%M%SZ')"
  pct exec "$DOCKER_CT_ID" -- nice -n 15 ionice -c 3 /usr/local/sbin/homelab-app-data-backup capture "${stage}"
  upload_app_capture "${stage}"
}

case "${1:-}" in
  opnsense-config)
    backup_opnsense_config
    ;;
  opnsense)
    backup_opnsense
    ;;
  docker)
    backup_docker
    ;;
  host-config)
    backup_host_config
    ;;
  apps)
    backup_apps
    ;;
  upload-existing)
    [[ $# -eq 3 ]] || {
      echo "Usage: $0 upload-existing <opnsense|docker> <archive>" >&2
      exit 64
    }
    upload_guest_archive "$2" "$3"
    ;;
  *)
    echo "Usage: $0 <opnsense|opnsense-config|docker|host-config|apps|upload-existing>" >&2
    exit 64
    ;;
esac
