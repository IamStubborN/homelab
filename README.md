# Homelab Compose

Docker Compose configuration for a self-hosted homelab stack.

This repository is public-safe by design: secrets, runtime databases, local Home Assistant configuration, ACME state, Tailscale state, and service-local runtime configs are ignored. Tracked files are either compose definitions or sanitized examples.

## Deployment Policy

Prefer manual deployment from a trusted operator workstation. This repository
does not use GitHub Actions for homelab deployment. Validate the relevant
Compose project locally, inspect the current runtime state, and apply changes
with the documented Docker Compose or guarded media deployment commands.

## Services

- Traefik reverse proxy with Cloudflare DNS challenge
- Gluetun VPN routing for selected media services
- qBittorrent and Prowlarr
- Plex, Kavita, Samba, Watchtower, DeUnhealth
- Media Orchestrator with a dedicated Rezka VPN, managed by the root Compose project
- KaraKeep, Freedium, Movie Tracker, Glance, Speedtest Tracker
- Bitwarden (Vaultwarden), Mosquitto, RustDesk
- OpenCode Go for household chat, NVIDIA embeddings for KaraKeep
- Family Health Python MCP cashier (jsonl under `/mnt/internal/wiki/shared/health`)
- Home Assistant with public-safe example config only

## Setup

Copy root environment values:

```bash
cp .env.example .env
```

Copy runtime config examples:

```bash
cp traefik/config/config.example.yml traefik/config/config.yml
cp glance/config/glance.example.yml glance/config/glance.yml
cp homeassistant/config/configuration.example.yaml homeassistant/config/configuration.yaml
cp homeassistant/config/automations.example.yaml homeassistant/config/automations.yaml
cp homeassistant/config/scripts.example.yaml homeassistant/config/scripts.yaml
cp homeassistant/config/scenes.example.yaml homeassistant/config/scenes.yaml
```

Fill real values only in ignored local files:

- `.env`
- `glance/.env`
- `speedtest-tracker/.env`
- `traefik/secrets/cf_dns_api_token`
- `download/secrets/protonvpn_wireguard_private_key`
- `plex/secrets/plex_token`
- `homeassistant/config/secrets.yaml`


Initialize the Freedium submodule:

```bash
git submodule update --init --recursive
```

Validate compose:

```bash
docker compose config --quiet
```

Media Orchestrator is included in the root Compose project. See
`media/README.md` for its image build, secrets, validation, and rollback notes.

The tracked Compose definitions for Plex and the torrent stack are split into
`plex/` and `download/`. Their mutable data and secret files intentionally stay
under `media/` so an existing installation can upgrade without moving state or
briefly starting against empty directories.

Family Health is built by the root Compose project from `health/mcp`
(`family-health-mcp:local`). The host vault lives at `${WIKI_ROOT}`
(`/mnt/internal/wiki` on host-5.example.invalid) and is not in git. See
`health/README.md` for the deploy runbook and `wiki/README.md` for
Obsidian Sync and rclone.

Start services:

```bash
docker compose up -d
```

## Public Safety

Do not commit real local files. Keep private domains, Tailscale URLs, LAN IPs, MAC addresses, device IDs, tokens, passwords, and runtime databases in ignored files only.
