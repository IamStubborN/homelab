# Pritunl OpenVPN watcher

This project is a deliberately manual-started OpenVPN client for a Pritunl profile that requires `PIN + TOTP`.

The runtime is Debian 13.6 with OpenVPN 2.7.5 from the official OpenVPN 2.7 APT repository. The image build prints and verifies the installed runtime versions. OpenVPN 3 is not used here because this watcher needs to provide a freshly generated `PIN + TOTP` through an `auth-user-pass` file.

DNS is provided by a dnsmasq instance inside the container. Queries for `platform-bo.com`, `cluster.local`, and `atlas-iac.com` (including subdomains) are sent to the corporate VPN DNS at `192.168.217.1`; other queries use the bootstrap resolvers. The VPN remote hostname is resolved through bootstrap DNS before dnsmasq starts so the split-DNS rules cannot prevent the VPN from connecting. The Compose service publishes DNS on the Docker host LAN address `192.168.1.4:53` for the OPNsense split-DNS forwarder; the port is intentionally bound to the LAN address, not all host addresses.

Safety behavior:

- A fresh OTP is generated only immediately before a connection attempt.
- The first retry after an established tunnel disconnect is immediate, including a server-side OpenVPN process exit.
- Failed connection attempts after that are spaced by one hour.
- OpenVPN is constrained to one remote, one resolver pass, one session, and one try per remote entry per watcher attempt.
- Three failed attempts since the last manual reset cause the container to exit with a persistent lockout marker.
- A manual reset is required before another start.
- Docker restart policy is `no`, so the lockout is not bypassed by an automatic container restart.
- A successful connection resets only consecutive-failure telemetry; it does not erase the manual-reset failure budget.
- Connection success is recorded by an OpenVPN `up` hook and disconnect by its `down` hook; `tun0` alone is not treated as proof of success.
- Routes learned through `tun0` are protected by an OUTPUT firewall policy and are rejected if a packet tries to leave through the pre-VPN uplink. The OpenVPN endpoint and bootstrap DNS remain allowed on that uplink.
- The service healthcheck becomes healthy only after the VPN tunnel and the fail-closed policy are both ready.
- Watcher, OpenVPN, dnsmasq, event, and OpenVPN status logs are persisted under `logs/` and `state/`.
- OpenVPN internal soft restarts are remapped to process termination; TLS failure and ping timeout are bounded so the watcher can apply the retry policy.

Secrets are expected as Docker Compose secrets under `secrets/` and must not be committed.

The canonical project path on the Docker host is `~/homelab/pritunl-vpn-gateway`. The previous `~/homelab/wproxy` implementation has been removed after traffic cutover.

The service is included by `~/homelab/compose.yml` with the `manual` profile. A normal homelab start does not start the VPN watcher.

OPNsense should forward the three private suffixes to `192.168.1.4` on port 53. When the VPN is unavailable, the gateway's fail-closed policy prevents private DNS queries from reaching the corporate resolver through the ordinary uplink.

## Running selected containers through the VPN

The supported opt-in gateway mode is a shared network namespace. A selected service shares the VPN container's namespace, so it receives the same `tun0`, pushed corporate routes, and local split-DNS resolver. Ordinary services remain unchanged.

Add this to a service that must use the VPN namespace:

```yaml
services:
  selected-worker:
    image: your-image:tag
    profiles: [vpn]
    network_mode: service:pritunl-vpn
    depends_on:
      pritunl-vpn:
        condition: service_healthy
```

Start the gateway first with `vpnctl start`, then start the selected service with the `vpn` profile. A service using `network_mode: service:pritunl-vpn` cannot publish its own ports or attach to another Docker network; expose ports on the gateway service if an inbound port is ever needed. This mode is for selected containers, not transparent routing for the Docker host or the LAN. If the tunnel disappears, previously learned corporate destinations remain blocked through the normal Docker uplink while unrelated public traffic keeps the existing split-routing behavior.

## Manual commands on the Docker host

From `~/homelab`, use the helper script:

```sh
./pritunl-vpn-gateway/vpnctl set-secrets
./pritunl-vpn-gateway/vpnctl start
./pritunl-vpn-gateway/vpnctl status
./pritunl-vpn-gateway/vpnctl logs
./pritunl-vpn-gateway/vpnctl stop
./pritunl-vpn-gateway/vpnctl reset
./pritunl-vpn-gateway/vpnctl test-lockout
./pritunl-vpn-gateway/vpnctl test-disconnect
```

The lockout marker is `state/lockout`. Remove it only as an intentional manual reset, then start the service again.

Persistent diagnostics are available in `logs/watcher.log`, `logs/openvpn.log`, `logs/openvpn-current.log`, `logs/dnsmasq.log`, `logs/events.log`, and `state/openvpn-status.log`. Diagnostic files are non-secret and host-readable; runtime logs and state are ignored by Git. Secrets remain Docker Compose secrets.

## Simulation

Run the image with `SIMULATE_AUTH_FAILURE=true` and verify that exactly three failed attempts are made and the process exits with status 78. The test overrides the retry interval to one second and does not contact the corporate VPN server.

`vpnctl test-disconnect` simulates an established tunnel followed by a server disconnect. It verifies that the first retry is immediate, subsequent simulated failures use the retry delay, and the container eventually locks out after three failed retries. It also does not contact the corporate VPN server.
