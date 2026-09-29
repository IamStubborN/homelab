# Vaultwarden

- **LAN:** `https://bitwarden.${DOCKER_DOMAIN}` (Traefik)
- **Public:** `https://bitwarden.example.test` (Cloudflare Tunnel via `bitwarden-cloudflared`)
- **`DOMAIN`** is the public URL so Bitwarden **Send** copy-link uses a shareable host.
- **`SIGNUPS_ALLOWED=false`** — only invited/existing accounts; recipients of Send links need no account.
- **No Cloudflare Access** on the public host (anonymous Send must work).

## Tunnel secret

Copy `tunnel.env.example` → `secrets/tunnel.env` and set `TUNNEL_TOKEN=...`
(from Cloudflare Zero Trust → Networks → Tunnels). Point the tunnel’s public
hostname `bitwarden.example.test` at service `http://bitwarden:80`.
