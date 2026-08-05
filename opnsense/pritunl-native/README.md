# Native OPNsense Pritunl client

This directory contains the fail-safe supervisor used by the disabled native OpenVPN client instance named `Atlas Dev Pritunl native client` on OPNsense.

The persisted OPNsense instance intentionally stays disabled. The supervisor enables only an in-memory model, renders a current `PIN + TOTP` credential, and runs one foreground OpenVPN process per attempt. This prevents OPNsense service restarts or reboots from bypassing the retry budget.

Safety contract:

- one OpenVPN connection per supervisor attempt;
- first attempt immediately, including immediately after a connected session drops;
- one hour between subsequent failed attempts;
- cumulative lockout after three failures since the last manual reset;
- a successful connection resets only the consecutive failure counter;
- persistent state under `/conf/pritunl-native/state`;
- persistent logs under `/var/log/pritunl-native`;
- manual reset only through `pritunl-vpnctl reset`.

Installed paths:

- scripts: `/usr/local/opnsense/scripts/pritunl-native/`;
- controller: `/usr/local/sbin/pritunl-vpnctl`;
- secrets: `/conf/pritunl-native/secrets/` (`0600`, never stored in Git);
- state: `/conf/pritunl-native/state/`;
- logs: `/var/log/pritunl-native/`.

Useful commands:

```sh
pritunl-vpnctl status
pritunl-vpnctl logs
pritunl-vpnctl stop
pritunl-vpnctl reset
pritunl-vpnctl start
pritunl-vpnctl refresh-routes
pritunl-vpnctl test-retry-contract
```

OPNsense UI configuration:

- `VPN > OpenVPN > Instances`: disabled native client instance;
- `Services > Unbound DNS > Query Forwarding`: `platform-bo.com`, `cluster.local`, and `atlas-iac.com` to `192.168.217.1:53`;
- `Firewall > NAT > Outbound`: hybrid mode, LAN and TAILSCALE source NAT on the OpenVPN group;
- `Firewall > Aliases`: external alias `PRITUNL_CORPORATE_ROUTES`;
- `Firewall > Rules > Floating`: quick outbound WAN block to `PRITUNL_CORPORATE_ROUTES`;
- `Firewall > Rules > TAILSCALE`: allow only TAILSCALE net to `PRITUNL_CORPORATE_ROUTES`.

`route-table.sh` keeps the external alias populated with routes learned on `ovpnc1`. The last known set remains loaded after a tunnel failure so corporate destinations are blocked on WAN instead of leaking through the default route.
