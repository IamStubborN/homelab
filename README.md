# Homelab Compose

Docker Compose configuration for a self-hosted homelab stack.

This repository is public-safe by design: secrets, runtime databases, local Home Assistant configuration, ACME state, Tailscale state, and service-local runtime configs are ignored. Tracked files are either compose definitions or sanitized examples.

## Services

- Traefik reverse proxy with Cloudflare DNS challenge
- Gluetun VPN routing for selected media services
- qBittorrent and Prowlarr
- Plex, Kavita, Samba, Watchtower, DeUnhealth
- KaraKeep, Freedium, Movie Tracker, Glance, Speedtest Tracker
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
- `media/secrets/protonvpn_wireguard_private_key`
- `media/secrets/plex_token`
- `homeassistant/config/secrets.yaml`

Initialize the Freedium submodule:

```bash
git submodule update --init --recursive
```

Validate compose:

```bash
docker compose config --quiet
```

Start services:

```bash
docker compose up -d
```

## Public Safety

Do not commit real local files. Keep private domains, Tailscale URLs, LAN IPs, MAC addresses, device IDs, tokens, passwords, and runtime databases in ignored files only.
