# Vaultwarden

- **LAN:** `https://bitwarden.${DOCKER_DOMAIN}` (Traefik)
- **Public:** `https://bitwarden.example.test` (Cloudflare Tunnel via `bitwarden-cloudflared`)
- **`DOMAIN`** comes from `BITWARDEN_PUBLIC_URL` in the root `.env` (the public
  URL, default `https://bitwarden.example.test`), so Bitwarden **Send** copy-links
  use a shareable host. Set it to the real public hostname.
- **`SIGNUPS_ALLOWED=false`** and **`INVITATIONS_ALLOWED=false`**: only existing
  accounts can sign in, and organization owners cannot invite new users. To add
  an account, enable signups temporarily. Recipients of Send links need no
  account.
- **No Cloudflare Access** on the public host (anonymous Send must work).

## Tunnel secret

Copy `tunnel.env.example` → `secrets/tunnel.env` and set `TUNNEL_TOKEN=...`
(from Cloudflare Zero Trust → Networks → Tunnels). Point the tunnel’s public
hostname `bitwarden.example.test` at service `http://bitwarden:80`.
