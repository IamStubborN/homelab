#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly LOCAL_BACKUP_DIR=/var/lib/vz/dump
readonly REMOTE_ROOT='gdrive:Homelab Backups/Proxmox'
readonly LOCK_FILE=/run/lock/homelab-google-drive-backup.lock
readonly RCLONE_BIND=0.0.0.0

exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  echo "Another homelab backup job is already running" >&2
  exit 75
fi

for command in awk basename date find flock pvesm rclone rm sort stat tar vzdump zstd; do
  command -v "${command}" >/dev/null || {
    echo "Required command is missing: ${command}" >&2
    exit 69
  }
done

upload_file() {
  local source=$1
  local remote_directory=$2
  local destination
  local local_size remote_size

  destination="${remote_directory}/$(basename "${source}")"

  rclone --bind "${RCLONE_BIND}" mkdir "${remote_directory}"
  rclone --bind "${RCLONE_BIND}" copyto "${source}" "${destination}" \
    --transfers 1 \
    --checkers 2 \
    --drive-chunk-size 64M

  local_size=$(stat -c '%s' "${source}")
  remote_size=$(rclone --bind "${RCLONE_BIND}" lsl "${destination}" | awk 'NR == 1 {print $1}')
  if [[ -z "${remote_size}" || "${local_size}" != "${remote_size}" ]]; then
    echo "Remote size verification failed for $(basename "${source}")" >&2
    exit 74
  fi
}

prune_remote() {
  local remote_directory=$1
  local include_pattern=$2
  local keep=$3
  local index=0 file

  while IFS= read -r file; do
    [[ -n "${file}" ]] || continue
    index=$((index + 1))
    if (( index <= keep )); then
      continue
    fi

    rclone --bind "${RCLONE_BIND}" deletefile "${remote_directory}/${file}"
    rclone --bind "${RCLONE_BIND}" deletefile "${remote_directory}/${file}.notes" 2>/dev/null || true
    rclone --bind "${RCLONE_BIND}" deletefile "${remote_directory}/${file}.log" 2>/dev/null || true
  done < <(rclone --bind "${RCLONE_BIND}" lsf "${remote_directory}" --files-only --include "${include_pattern}" | sort -r)
}

upload_guest_archive() {
  local kind=$1
  local archive=$2
  local remote_directory pattern regex keep sidecar archive_name

  case "${kind}" in
    opnsense)
      remote_directory="${REMOTE_ROOT}/OPNsense/full-vm"
      pattern='vzdump-qemu-100-*.vma.zst'
      regex='^vzdump-qemu-100-.*\.vma\.zst$'
      keep=3
      ;;
    docker)
      remote_directory="${REMOTE_ROOT}/Docker/full-lxc"
      pattern='vzdump-lxc-300-*.tar.zst'
      regex='^vzdump-lxc-300-.*\.tar\.zst$'
      keep=2
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

  for sidecar in "${archive}.notes" "${archive}.log"; do
    [[ -f "${sidecar}" ]] && upload_file "${sidecar}" "${remote_directory}"
  done

  prune_remote "${remote_directory}" "${pattern}" "${keep}"
  rm -f -- "${archive}" "${archive}.notes" "${archive}.log"
}

latest_archive() {
  local pattern=$1
  find "${LOCAL_BACKUP_DIR}" -maxdepth 1 -type f -name "${pattern}" \
    -printf '%T@ %p\n' | sort -nr | awk 'NR == 1 {$1=""; sub(/^ /, ""); print; exit}'
}

backup_opnsense() {
  local archive
  vzdump 100 --storage local --mode snapshot --compress zstd --remove 0 \
    --notes-template 'OPNsense VM 100 full backup'
  archive=$(latest_archive 'vzdump-qemu-100-*.vma.zst')
  [[ -n "${archive}" ]] || exit 66
  upload_guest_archive opnsense "${archive}"
}

backup_docker() {
  local archive
  vzdump 300 --storage local --mode snapshot --compress zstd --remove 0 \
    --notes-template 'Docker LXC 300 full rootfs backup; external bind mounts excluded'
  archive=$(latest_archive 'vzdump-lxc-300-*.tar.zst')
  [[ -n "${archive}" ]] || exit 66
  upload_guest_archive docker "${archive}"
}

backup_host_config() {
  local timestamp archive
  timestamp=$(date -u '+%Y_%m_%d-%H_%M_%S')
  archive="${LOCAL_BACKUP_DIR}/proxmox-host-config-${timestamp}.tar.zst"

  tar --acls --numeric-owner -C / \
    -I 'zstd -T0 -3' \
    -cf "${archive}" \
    etc/pve \
    etc/network/interfaces \
    etc/hosts \
    etc/hostname \
    etc/resolv.conf \
    etc/apt \
    etc/default/grub \
    etc/kernel \
    etc/modprobe.d \
    etc/systemd/system \
    etc/systemd/journald.conf.d

  zstd -tq "${archive}"
  upload_file "${archive}" "${REMOTE_ROOT}/host-config"
  prune_remote "${REMOTE_ROOT}/host-config" 'proxmox-host-config-*.tar.zst' 3
  rm -f -- "${archive}"
}

case "${1:-}" in
  opnsense)
    backup_opnsense
    ;;
  docker)
    backup_docker
    ;;
  host-config)
    backup_host_config
    ;;
  upload-existing)
    [[ $# -eq 3 ]] || {
      echo "Usage: $0 upload-existing <opnsense|docker> <archive>" >&2
      exit 64
    }
    upload_guest_archive "$2" "$3"
    ;;
  *)
    echo "Usage: $0 <opnsense|docker|host-config|upload-existing>" >&2
    exit 64
    ;;
esac
