# Proxmox backups

These units upload verified backups to `Google Drive/Homelab Backups/Proxmox`.

- OPNsense VM 100: weekly on Sunday at 04:00 UTC, keep 3 full VM archives.
- Docker LXC 300: first Sunday of each month at 05:00 UTC, keep 2 full rootfs archives.
- Proxmox host configuration: weekly on Sunday at 03:30 UTC, keep 3 archives.

The Docker LXC bind mounts `/mnt/internal` and `/mnt/usb_drive` are excluded by
Proxmox `vzdump`. A local guest archive is removed only after upload and remote
size verification succeed. Failed jobs retain their local archive for recovery.

The rclone configuration is stored only on the Proxmox host at
`/root/.config/rclone/rclone.conf` with mode `0600`; it is not committed.
