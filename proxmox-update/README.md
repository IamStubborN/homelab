# Proxmox host updates

`homelab-host-update.timer` runs at 06:50 `Europe/Sofia`, the last job of the
nightly 04:00–08:00 window described in `watchtower/README.md`: after the
backups, Watchtower (05:45), the Docker guest's package updates (06:10) and
OPNsense's firmware update (06:30), so its possible reboot comes last.

The script takes the shared backup lock, finishes any interrupted `dpkg` run,
and runs `apt-get full-upgrade` with the default answers for configuration
prompts. It skips the night and fails the unit when the upgrade would remove a
package; review those with `apt-get -s full-upgrade`.

New kernels wait 7 days: broken Proxmox kernels are usually replaced within a
few days. The script records when it first sees a kernel version as an upgrade
(`/var/lib/homelab-host-update/kernel-seen/`; kernels installed before this use
their dpkg install time). Until the version is 7 days old, the installed kernel
meta packages (`proxmox-kernel-7.0` and similar) are held with `apt-mark` for
that night's upgrade, so everything else still updates. The night skips, and
the unit fails, if the held plan would still install the young kernel or remove
packages. Holds you set by hand are left alone. If Proxmox publishes kernels
less than 7 days apart, each new version restarts the wait.

After the upgrade it purges the kernels Proxmox marks as removable (all but
the running and newest ones, see `/etc/apt/apt.conf.d/76pveconf`), and only
those; other autoremovable packages stay.

It reboots only when the newest `/boot/vmlinuz-*-pve` kernel is newer than the
running one and 7 days old, and only after these checks pass:

- `dpkg --audit` is clean, the kernel has an initrd, and GRUB's first entry
  boots it;
- the EFI partition has at least 200 MiB free;
- the Docker guest's `apt-daily-upgrade.service` is not running (otherwise it
  reboots the next night);
- it is still before 07:45, so the reboot and boot check end before the
  monthly 08:00 backup.

The reboot is scheduled a minute ahead (`shutdown -r +1`), so the unit
finishes and records success first; `shutdown -c` cancels it.

It reboots once per kernel: if the host comes back on another kernel, the unit
fails instead of rebooting every night. A reboot stops every guest, including
OPNsense and with it the internet, for a few minutes. Both guests start on boot
(OPNsense first).

There is no automatic fallback to the previous kernel. `/boot` is on LVM, where
GRUB cannot record a boot attempt, so a one-time boot (`grub-reboot`) would
stick. A kernel that does not boot needs the console.

After a reboot, `homelab-host-boot-check.service` waits up to 15 minutes for
the configured router VM and Docker container and `1.1.1.1`. Both units report failures through the backup
monitor's Telegram alerts (`host-update` and `host-boot` jobs with
`failure_only: true` in `/etc/homelab-backup/monitor.json`). If the host does
not come back at all, nothing on it can report that.

## Host settings this relies on

- Verify the host's actual bootloader and retain a private EFI/boot-entry
  recovery snapshot before enabling unattended kernel updates. A different
  bootloader layout needs a separate review.

- `/etc/fstab` mounts `/mnt/usb_drive` with
  `nofail,x-systemd.device-timeout=30s`, so a missing USB drive cannot stop
  the boot in emergency mode (a dependent container may fail to start instead).
- `/etc/apt/preferences.d/homelab-no-auto-ookla` pins the third-party Ookla
  repository to priority 99, so it is never upgraded unattended.

## Install

As root on Proxmox, create the root-only private
`/etc/homelab-backup/proxmox.env` first. Set `ROUTER_VM_ID` and `DOCKER_CT_ID`
to the intended guests; the supplied example leaves IDs blank. Missing
or invalid IDs fail closed. Back up this file with the host configuration.
Do not enable the updated units until those private inputs are installed:


```sh
install -m 0755 proxmox-update/homelab-host-update.sh /usr/local/sbin/homelab-host-update
install -m 0755 proxmox-update/homelab-host-boot-check.sh /usr/local/sbin/homelab-host-boot-check
install -m 0644 proxmox-update/homelab-host-update.service proxmox-update/homelab-host-update.timer \
  proxmox-update/homelab-host-boot-check.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now homelab-host-update.timer
systemctl enable homelab-host-boot-check.service
```

Check runs with `journalctl -u homelab-host-update -u homelab-host-boot-check`.
`DRY_RUN=1 homelab-host-update` prints the plan and decisions without
installing, holding or rebooting.

## Docker guest TRIM

The Docker container's rootfs is a thin volume on `local-lvm`. Blocks freed inside the
container stay allocated in the pool until they are trimmed, and the container
cannot trim its own rootfs. `homelab-guest-fstrim.timer` runs
`pct fstrim "$DOCKER_CT_ID" --ignore-mountpoints 1` at 06:20, after the Docker cleanup at
06:05. Install as root on Proxmox:

```sh
install -m 0644 proxmox-update/homelab-guest-fstrim.service proxmox-update/homelab-guest-fstrim.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now homelab-guest-fstrim.timer
```
