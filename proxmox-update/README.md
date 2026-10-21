# Proxmox host updates

`homelab-host-update.timer` runs at 04:45 `Europe/Sofia`, after Watchtower
(04:00) and the Docker guest's Ubuntu updates (04:30), inside the nightly
04:00–05:00 update window described in `watchtower/README.md`.

The script takes the shared backup lock, finishes any interrupted `dpkg` run,
and runs `apt-get full-upgrade` with the default answers for configuration
prompts. It skips the night and fails the unit when the upgrade would remove a
package; review those with `apt-get -s full-upgrade`. It reboots only when a
`/boot/vmlinuz-*-pve` kernel newer than the running one is installed, and only
once per kernel: if the host comes back on the old kernel (a pinned kernel),
the unit fails instead of rebooting every night. Before rebooting it waits up
to ten minutes for the Docker guest's `apt-daily-upgrade.service` to finish,
and it never reboots after 04:59; a missed reboot happens the next night. A reboot stops
every guest, including OPNsense and with it the internet, for a few minutes.
Both guests start on boot (OPNsense first).

Install as root on Proxmox:

```sh
install -m 0755 proxmox-update/homelab-host-update.sh /usr/local/sbin/homelab-host-update
install -m 0644 proxmox-update/homelab-host-update.service proxmox-update/homelab-host-update.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now homelab-host-update.timer
```

Check the last run with `journalctl -u homelab-host-update`.
