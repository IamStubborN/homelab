# Native OPNsense Pritunl client

This directory contains the fail-safe supervisor used by the disabled native OpenVPN client instance named `Atlas Dev Pritunl native client` on OPNsense.

The persisted OPNsense instance intentionally stays disabled. The supervisor enables only an in-memory model, renders a current `PIN + TOTP` credential, and runs one foreground OpenVPN process per attempt. This prevents OPNsense service restarts or reboots from bypassing the retry budget.

Safety contract:

- OPNsense generates the complete native instance configuration, including its
  management socket, PID file, daemon identity, standard link hooks and logs;
- one native OpenVPN process launch per reserved attempt;
- serialized start and lifetime locks prevent concurrent supervisors from
  launching or updating retry state in parallel;
- simulation and validation runs never signal an OpenVPN process they did not
  start and own;
- first attempt immediately, including immediately after a connected session drops;
- one hour between subsequent attempts that do not reach `route-up`;
- at most three OpenVPN launches in a rolling 24-hour window, regardless of
  the OpenVPN exit reason or which lifecycle events were observed;
- at most three consecutive failed or shorter-than-one-hour sessions;
- connection success is accepted only at `route-up`, after authentication and
  route installation;
- a session resets the consecutive counter only after one uninterrupted hour
  with both the native OpenVPN process and the `route-up` connection marker
  continuously present;
- a successful session never clears the rolling 24-hour launch history;
- reaching either limit creates a persistent lockout instead of starting a
  fourth process;
- persistent state under `/conf/pritunl-native/state`;
- persistent logs under `/var/log/pritunl-native`;
- manual reset only through `pritunl-vpnctl reset`; it clears lockout and all
  retry history, but only while both the watcher and OpenVPN are stopped.

The persisted instance stays disabled only to prevent OPNsense boot or a generic
service reconfigure from starting it outside the attempt gate. While running,
the process uses the native OPNsense management socket, PID file, link hooks and
syslog pipeline, so Connection Status and Log File remain available in the UI.

The conservative launch budget is intentional. A client cannot prove that a
TLS or transport failure happened before the corporate server observed an
authentication request, so every process launch is charged before OpenVPN is
started. This makes three the hard upper bound on server-facing attempts in 24
hours.

The generated client ignores pushed `redirect-gateway` and `redirect-private`
directives. Ordinary internet traffic therefore keeps using the WAN default
route; only routes explicitly pushed for corporate destinations use the VPN.

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
- `Firewall > Rules > Floating`: quick outbound OpenVPN block for destinations
  outside `PRITUNL_CORPORATE_ROUTES`;
- `Firewall > Rules > TAILSCALE`: allow only TAILSCALE net to `PRITUNL_CORPORATE_ROUTES`.

`route-table.sh` keeps the external alias populated with routes learned on `ovpnc1`. The last known set remains loaded after a tunnel failure so corporate destinations are blocked on WAN instead of leaking through the default route.
