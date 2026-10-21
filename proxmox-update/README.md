# Proxmox host updates

`homelab-host-update.timer` runs at 04:45 `Europe/Sofia`, after Watchtower
(04:00) and the Docker guest's Ubuntu updates (04:30), inside the nightly
04:00–05:00 update window described in `watchtower/README.md`.

The script takes the shared backup lock, finishes any interrupted `dpkg` run,
and runs `apt-get full-upgrade` with the default answers for configuration
prompts. It skips the night and fails the unit when the upgrade would remove a
package; review those with `apt-get -s full-upgrade`.

It reboots only when a `/boot/vmlinuz-*-pve` kernel newer than the running one
is installed, and only after these checks pass:

- `dpkg --audit` is clean, the kernel has an initrd, and GRUB's first entry
  boots it;
- the EFI partition has at least 200 MiB free;
- the Docker guest's `apt-daily-upgrade.service` is not running (otherwise it
  reboots the next night);
- it is still 04:xx.

It reboots once per kernel: if the host comes back on another kernel, the unit
fails instead of rebooting every night. A reboot stops every guest, including
OPNsense and with it the internet, for a few minutes. Both guests start on boot
(OPNsense first).

There is no automatic fallback to the previous kernel. `/boot` is on LVM, where
GRUB cannot record a boot attempt, so a one-time boot (`grub-reboot`) would
stick. A kernel that does not boot needs the console.

After a reboot, `homelab-host-boot-check.service` waits up to 15 minutes for
VM 100, CT 300 and `1.1.1.1`. Both units report failures through the backup
monitor's Telegram alerts (`host-update` and `host-boot` jobs with
`failure_only: true` in `/etc/homelab-backup/monitor.json`). If the host does
not come back at all, nothing on it can report that.

## Host settings this relies on

- `/etc/fstab` mounts `/mnt/usb_drive` with
  `nofail,x-systemd.device-timeout=30s`, so a missing USB drive cannot stop
  the boot in emergency mode (CT 300 then fails to start instead).
- `/etc/apt/preferences.d/homelab-no-auto-ookla` pins the third-party Ookla
  repository to priority 99, so it is never upgraded unattended.

## Install

As root on Proxmox:

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
