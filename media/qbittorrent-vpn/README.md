# qBittorrent Proton VPN profile pool

This directory contains the tracked operator command for switching the Hotio
qBittorrent container between a small, manually curated set of Proton
WireGuard profiles.

The profiles themselves contain the WireGuard private key and are stored under
the already ignored runtime path:

```text
media/qbittorrent/config/wireguard/profiles/
```

There is deliberately no background selector and no automatic server
rotation. A switch is initiated only by an operator:

```bash
media/qbittorrent-vpn/vpn-server list
media/qbittorrent-vpn/vpn-server status
media/qbittorrent-vpn/vpn-server use bg-13
```

The ignored pool can be recreated without printing the private key. Save the
current last-known-good configuration, then derive another profile by replacing
only its public peer settings:

```bash
media/qbittorrent-vpn/vpn-server save nl-612
media/qbittorrent-vpn/vpn-server derive bg-13 192.0.2.1:51820 '<peer-public-key>'
```

`use` validates the selected profile, atomically installs it as `wg0.conf`,
restarts only the `qbittorrent` container, and waits for all of the following:

- healthy Hotio container;
- expected WireGuard endpoint;
- allocated Proton forwarded port;
- Hotio confirmation that the forwarded port is reachable.

If validation does not complete within four minutes, the command restores the
previous profile and restarts the container once. If rollback also fails,
Hotio's firewall remains fail-closed.

The initial pool is ordered operationally as follows:

1. `bg-13` (`BG#13`, Sofia)
2. `bg-26` (`BG#26`, Sofia)
3. `nl-612` (last-known-good fallback)

Adding or replacing profiles is an explicit manual operation. Never commit the
profile directory or copy private keys into this tracked documentation.
