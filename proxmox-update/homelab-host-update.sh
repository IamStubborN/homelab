#!/usr/bin/env bash
# Nightly Proxmox host update inside the 04:00-05:00 Europe/Sofia window.
# Installs package updates nightly. A new kernel is installed, and the host
# rebooted into it, only once that kernel has been known for KERNEL_AGE_DAYS.
# DRY_RUN=1 prints the decisions without installing, holding or rebooting.
set -euo pipefail

BACKUP_LOCK=/run/lock/homelab-google-drive-backup.lock
DOCKER_CT=300
STATE=/var/lib/homelab-host-update
KERNEL_AGE_DAYS=7
EFI_MIN_FREE_KB=$((200 * 1024))
DRY_RUN=${DRY_RUN:-}

in_window() { [ "$(TZ=Europe/Sofia date +%H)" = 04 ]; }

# When a kernel version became known: first seen as an upgrade candidate or,
# for a kernel installed before that, when its package was installed.
known_since() {
  local seen="$STATE/kernel-seen/$1" list="/var/lib/dpkg/info/proxmox-kernel-$1-signed.list"
  if [ -e "$seen" ]; then stat -c %Y "$seen"
  elif [ -e "$list" ]; then stat -c %Y "$list"
  else date +%s
  fi
}
# Allow 12 hours of slack: a kernel first seen in the afternoon is due on the
# seventh night, not the eighth.
aged() { [ $(( $(date +%s) - $(known_since "$1") )) -ge $((KERNEL_AGE_DAYS * 86400 - 43200)) ]; }

# Backups share this lock. Holding it keeps a backup from starting mid-update;
# a backup that is already running makes us skip until the next night.
exec 9>"$BACKUP_LOCK"
if ! flock -n 9; then
  echo "Backup in progress; skipping tonight's update."
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a APT_LISTCHANGES_FRONTEND=none
DPKG_OPTS=(-o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)
APT_OPTS=(-q -o DPkg::Lock::Timeout=600 "${DPKG_OPTS[@]}")
mkdir -p "$STATE/kernel-seen"

# Release holds left by a run that was killed before its exit trap ran.
if [ -z "$DRY_RUN" ] && [ -s "$STATE/held" ]; then
  xargs apt-mark unhold <"$STATE/held" >/dev/null || true
  rm -f "$STATE/held"
fi

# Package scripts must not inherit the backup lock (fd 9).
[ -n "$DRY_RUN" ] || dpkg --force-confdef --force-confold --configure -a 9>&-
apt-get "${APT_OPTS[@]}" update 9>&-
plan=$(apt-get "${APT_OPTS[@]}" -s full-upgrade 9>&-)
if grep -q '^Remv ' <<<"$plan"; then
  echo "The upgrade would remove packages; skipping tonight. Review with: apt-get -s full-upgrade"
  exit 1
fi

# Record new kernel versions. While any is younger than KERNEL_AGE_DAYS, hold
# the installed kernel meta packages so they do not pull it in. Holds set by
# hand are left alone.
young=()
while read -r version; do
  [ -e "$STATE/kernel-seen/$version" ] || touch "$STATE/kernel-seen/$version"
  aged "$version" || young+=("$version")
done < <(grep -oE '^Inst proxmox-kernel-[0-9][^ ]*-pve' <<<"$plan" | sed 's/^Inst proxmox-kernel-//' || true)
held=()
if [ "${#young[@]}" -gt 0 ]; then
  mapfile -t held < <(grep -oE '^Inst (proxmox-kernel-[0-9]|proxmox-default-kernel|pve-kernel-[0-9])[^ ]* \[' <<<"$plan" \
    | sed 's/^Inst //; s/ \[$//' | grep -vxF -f <(apt-mark showhold) || true)
  if [ "${#held[@]}" -eq 0 ]; then
    echo "Kernel ${young[*]} is younger than ${KERNEL_AGE_DAYS} days, but no meta package to hold; skipping tonight."
    exit 1
  fi
  echo "Kernel ${young[*]} is younger than ${KERNEL_AGE_DAYS} days; holding: ${held[*]}"
fi
if [ -n "$DRY_RUN" ]; then
  echo "DRY_RUN: plan before holds: $(grep -oE '^Inst [^ ]+' <<<"$plan" | sed 's/^Inst //' | tr '\n' ' ')"
else
  if [ "${#held[@]}" -gt 0 ]; then
    printf '%s\n' "${held[@]}" >"$STATE/held"
    trap 'apt-mark unhold "${held[@]}" >/dev/null && rm -f "$STATE/held"' EXIT
    apt-mark hold "${held[@]}" >/dev/null
    # Holding changes apt's decisions: check the plan again.
    plan=$(apt-get "${APT_OPTS[@]}" -s full-upgrade 9>&-)
    for version in "${young[@]}"; do
      if grep -q "^Inst proxmox-kernel-$version" <<<"$plan"; then
        echo "Kernel $version would still be installed despite the hold; skipping tonight."
        exit 1
      fi
    done
    if grep -q '^Remv ' <<<"$plan"; then
      echo "With kernels held, the upgrade would remove packages; skipping tonight."
      exit 1
    fi
  fi
  apt-get "${APT_OPTS[@]}" -y full-upgrade 9>&-
fi

# The newest kernel that can actually boot, not leftover module directories.
running=$(uname -r)
newest=$(find /boot -maxdepth 1 -name 'vmlinuz-*-pve' -printf '%f\n' | sed 's/^vmlinuz-//' | sort -V | tail -n 1)
if [ -z "$newest" ] || [ "$running" = "$newest" ]; then
  echo "Running kernel $running is the newest installed; no reboot needed."
  exit 0
fi
if ! aged "$newest"; then
  ready=$(date -d "@$(( $(known_since "$newest") + KERNEL_AGE_DAYS * 86400 ))" +%F)
  echo "Kernel $newest is younger than ${KERNEL_AGE_DAYS} days; rebooting into it from $ready."
  exit 0
fi

# A previous reboot into this kernel did not take (pinned or chosen kernel):
# do not reboot the router every night.
if [ "$(cat "$STATE/reboot-target" 2>/dev/null)" = "$newest" ]; then
  echo "Already rebooted for $newest but still running $running; not rebooting again."
  exit 1
fi

# The new kernel must be complete and be GRUB's default entry.
problems=()
[ -z "$(dpkg --audit)" ] || problems+=("dpkg --audit reports problems")
[ -s "/boot/initrd.img-$newest" ] || problems+=("no initrd for $newest")
grep -q "with Linux $newest'" /boot/grub/grub.cfg || problems+=("grub.cfg has no entry for $newest")
# GRUB_DEFAULT=0 boots the first menu entry; read the kernel from its linux line.
first=$(grep -m1 -oE '^\s*linux\s+\S*/vmlinuz-[^ ]+' /boot/grub/grub.cfg | sed 's/.*vmlinuz-//' || true)
[ "$first" = "$newest" ] || problems+=("GRUB would boot $first, not $newest")
if mountpoint -q /boot/efi; then
  free_kb=$(df --output=avail -k /boot/efi | tail -n 1 | tr -d ' ')
  [ "$free_kb" -ge "$EFI_MIN_FREE_KB" ] || problems+=("EFI partition has only ${free_kb} KiB free")
fi
if [ "${#problems[@]}" -gt 0 ]; then
  printf 'Not rebooting into %s: %s\n' "$newest" "${problems[*]}"
  exit 1
fi

# Let the Docker guest finish its own 04:30 package updates before rebooting.
# A oneshot unit is "activating" while it runs; a stopped guest counts as idle.
guest_busy=1
for _ in $(seq 60); do
  state=$(pct exec "$DOCKER_CT" -- systemctl show -P ActiveState apt-daily-upgrade.service 2>/dev/null) || { guest_busy=0; break; }
  case "$state" in
    activating|active|deactivating|reloading) sleep 10 ;;
    *) guest_busy=0; break ;;
  esac
done
if [ "$guest_busy" = 1 ]; then
  echo "Docker guest is still installing updates; rebooting next night."
  exit 0
fi

if [ -n "$DRY_RUN" ]; then
  echo "DRY_RUN: would reboot from $running into $newest during 04:xx."
  exit 0
fi
if ! in_window; then
  echo "Kernel $newest installed, but the update window has passed; rebooting next night."
  exit 0
fi
echo "$newest" > "$STATE/reboot-target"
echo "Rebooting from kernel $running into $newest."
systemctl reboot
