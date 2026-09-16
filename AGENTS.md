# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a self-hosted homelab infrastructure project using Docker Compose. The setup includes media management, reverse proxy, VPN routing, file sharing, and various web services.

## Essential Commands

### Container Management
```bash
# Start all services
docker compose up -d

# Restart services after changes
docker compose config --quiet && docker compose up -d

# View logs for a specific service
docker compose logs -f [service_name]

# Pull updated images and recreate changed containers without stopping first
make update-containers

# Clean up Docker system
make prune
```

### Network Testing (through VPN)
```bash
make ip-test        # Test public IP through Gluetun VPN
make speedtest      # Run speed test through VPN
make dns-leak-test  # Test for DNS leaks
```

### Media Analysis
```bash
make check-codecs   # Check video codec information for Plex compatibility
make check-codecs VIDEO_DIR=/path/to/dir  # Custom directory
```

## Architecture

### Service Organization
- Main orchestration: `/compose.yml` includes all active services via `include:` directive
- Each service group has its own directory and Compose file
- All active services under this repository are launched from the root project

### Network Architecture
- **Traefik** reverse proxy handles all HTTP/HTTPS traffic with Cloudflare DNS challenge
- **Gluetun** VPN containers route media services through Proton VPN WireGuard
- Services use `network_mode: service:gluetun` to route through VPN
- Shared `proxy` network (external) connects all services to Traefik
- All services accessible via `*.${DOCKER_DOMAIN}` domain

### Key Service Groups
1. **Media library**: Plex, plex-auto-languages, media-preview-generator (`plex/compose.yml`); Kavita is a separate module
2. **Download VPN stack**: Gluetun, qBittorrent, Prowlarr, FlareSolverr (`download/compose.yml`)
3. **Media Orchestrator**: Active root-Compose module (`media/compose.media-orchestrator.yml`) with a dedicated `gluetun-rezka` VPN namespace; see `media/README.md`
4. **Family Health**: Python MCP cashier (`health-service`, image `family-health-mcp:local`) writes append-only jsonl under `${WIKI_ROOT}/shared/health`. Live vault is `/mnt/internal/wiki` on host-5.example.invalid (not in git; `/opt/data/wiki` is wrong on this host). `health-internal` is Hermes + health-service only. Wiki host services (`obsidian-sync`, `health-drive`) live in `wiki/compose.yml`. `health-drive` stays Created/unstarted until G2 rclone OAuth is configured; it uses Compose profile `g2-oauth` and must not be started without credentials. No Postgres, no SQLite, no Rust health binary. See `health/README.md`. Plan: `health/docs/plans/2026-08-19-family-health-wiki.md`.
5. **Custom Apps**: KaraKeep (web scraper with AI/MeiliSearch), Freedium (Medium proxy), Movie-Tracker (Telegram bot)
6. **File Management**: Samba shares (`samba/`, host network), Kavita (ebook reader), OpenList (`openlist/`, `https://openlist.${DOCKER_DOMAIN}`; Local drivers bind `${INTERNAL_STORAGE}` and `${USB_STORAGE}` at `/mnt/shares/{internal,usb_drive}`; optional SMB via Samba), FileBrowser (disabled)
7. **Monitoring**: Watchtower (auto-updates), DeUnhealth (health checks)
8. **Other Services**: Bitwarden (Vaultwarden), Mosquitto (MQTT broker), RustDesk (remote desktop relay)


### VPN Routing (Gluetun)
Media services route through Gluetun container:
- qBittorrent uses `network_mode: service:gluetun`; Prowlarr connects directly
- speedtest-tracker-vpn also routes through the same Gluetun container: `network_mode: service:gluetun`
- Plex: Does NOT route through VPN (direct network access)
- Health checks integrated with DeUnhealth for auto-restart

### Security Considerations
- All containers except Home Assistant (which requires `privileged: true` for hardware access) run with `security_opt: no-new-privileges:true`
- Media traffic routed through VPN via Gluetun
- Traefik handles SSL with Cloudflare DNS challenge
- Sensitive credentials stored in `.env` files (not in compose files)


## Restore Notes

Use this file and the tracked `*.example.*` files for clean-host recovery. The repository intentionally does not contain runtime data, local Home Assistant state, or secrets. Freedium source is tracked as a pinned git submodule.

Clean-host restore requires more than the root `.env`: create service-local env files for services with `env_file` (`glance/.env`, `speedtest-tracker/.env`), restore Docker secret files under `traefik/secrets/`, `download/secrets/`, and `media/orchestrator-secrets/` (`MEDIA_SECRETS_DIR`), restore ignored runtime data directories, and verify host prerequisites such as storage mounts, `/dev/net/tun`, `/dev/dri`, `/run/dbus`, Docker socket access, ports `80/443`, and the external `proxy` network. Follow the storage classes below. Plex state lives in `plex/`; download stack state (Gluetun, qBittorrent, Prowlarr, VPN secrets) lives in `download/`.


### Gluetun control-server API key

The main Gluetun control server (`download/compose.yml`) binds on `:8000` so the
Glance "VPN Speed" widget can reach `/v1/publicip/ip` cross-container, but every
route is locked behind an apikey. Generate one key and place the SAME value in
three spots:

```bash
KEY=$(docker run --rm qmcgaw/gluetun:<pinned-version> genkey)
# 1. Gluetun auth config (copy the tracked example, then set apikey = "$KEY"):
cp download/gluetun/control-auth-config.example.toml download/secrets/gluetun_control_auth_config

# 2. Raw key for the qBittorrent healthcheck:
printf '%s' "$KEY" > download/secrets/gluetun_control_api_key
# 3. glance/.env: GLUETUN_CONTROL_API_KEY=$KEY
chmod 0600 download/secrets/gluetun_control_auth_config download/secrets/gluetun_control_api_key
```

The only route exposed is `GET /v1/publicip/ip` (used by both the Glance widget
and the qBittorrent healthcheck). A mismatched or missing key makes the
qBittorrent healthcheck fail closed and the Glance widget go blank.

Watchtower is configured in opt-in mode. Add `com.centurylinklabs.watchtower.enable=true` only to services that should be auto-updated. Keep source-built services and private custom apps disabled unless their backup and restore path is tested.

Plex (`linuxserver/plex:latest`), Vaultwarden (`vaultwarden/server:latest`),
Traefik (`traefik:latest`), Home Assistant (`ghcr.io/home-assistant/home-assistant:stable`),
Media Orchestrator Postgres (`postgres:17-alpine`), and Freedium Postgres
(`postgres:16-alpine`) are Watchtower-enabled. Pin Postgres to a major tag
without a digest so patch images can be pulled; do not use `postgres:latest`
(a major jump will not migrate `PGDATA`). Vaultwarden and Traefik no longer use
`monitor-only`. Source-built application images (media-orchestrator
service/runner, Freedium app, Hermes, health) stay off.

Run `make check-runtime` after deployment to detect containers launched directly from child Compose files.

## Development Notes

### Adding New Services
1. Create directory under `${HOMELAB_ROOT:-/opt/homelab}/[service_name]/`
2. Add `compose.yml` in service directory
3. Include in main `/compose.yml` using `include:` directive
4. Add to `proxy` network and configure Traefik labels:
```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.myservice.rule=Host(`myservice.${DOCKER_DOMAIN}`)"
  - "traefik.http.routers.myservice.entrypoints=https"
  - "traefik.http.routers.myservice.tls=true"
networks:
  - proxy
```

### Environment Variables
Most active compose variables are loaded from the root `.env` file next to `compose.yml`. Keep `.env.example` in sync with the variables reported by `docker compose config --variables`.

Only services that declare `env_file` use service-local `.env` files. At the moment those are:
- `/glance/.env`
- `/speedtest-tracker/.env`

Runtime-only config files are ignored. Copy tracked examples before first use:
```bash
cp traefik/config/config.example.yml traefik/config/config.yml
cp glance/config/glance.example.yml glance/config/glance.yml
cp homeassistant/config/configuration.example.yaml homeassistant/config/configuration.yaml
cp homeassistant/config/automations.example.yaml homeassistant/config/automations.yaml
cp homeassistant/config/scripts.example.yaml homeassistant/config/scripts.yaml
cp homeassistant/config/scenes.example.yaml homeassistant/config/scenes.yaml
```

### Custom Applications
**CLIProxyAPI** (`/cliproxyapi/`): OpenAI-compatible LLM gateway (Codex OAuth + xAI/Grok OAuth). Public: `https://cliproxy.${DOCKER_DOMAIN}/v1`; Control Center: `https://cliproxy.${DOCKER_DOMAIN}/management.html` (needs `remote-management.allow-remote` + `secret-key`; plaintext in `hermes/secrets/cliproxy_management_key`); Docker DNS: `http://cli-proxy-api:8317/v1`; HA: `http://127.0.0.1:8317/v1`.

**KaraKeep** (`/karakeep/`): Web scraper with AI summarization and MeiliSearch.

**Freedium** (`/freedium/`): Medium proxy with Caddy, PostgreSQL, Redis. The compose file builds from the pinned submodule at `freedium/repo/`. Restore it with:
```bash
git submodule update --init --recursive
```
Use the tracked helper for database backups:
```bash
freedium/backup-db.sh
```

**Hermes** (`/hermes/`): Household Telegram agents. Chat and auxiliary tasks use CLIProxyAPI (`cliproxyapi/`, `http://cli-proxy-api:8317/v1`, model `gpt-5.6-luna`); web search and extract use native Exa. See `hermes/README.md`.

**Movie-Tracker** (`/movie-tracker/`): Python Telegram bot deployed from the private image `ghcr.io/example/movie-tracker:latest`. The homelab repository intentionally tracks only the compose wrapper. A clean host must be logged in to GHCR before pulling:
```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u example-user --password-stdin
docker compose pull movie-tracker
```

When modifying custom applications:
- For image-based apps such as Movie-Tracker, change and publish the application in its own repository, then pull the image here.
- For source-built apps such as Freedium, update the pinned submodule deliberately and rebuild the relevant service.

### Storage classes

Pick the class by data kind. Do not invent a fourth style, and do not move a
service between classes for naming consistency.

- **Libraries:** `${INTERNAL_STORAGE:-/mnt/internal}` and
  `${USB_STORAGE:-/mnt/usb_drive}`. Media, torrents, books, and the live wiki
  vault. Services mount these as `/data/internal` and `/data/usb_drive`. Never
  put library trees in Docker named volumes.
- **App state:** bind mounts under the service directory next to its Compose
  file (`plex/config`, `download/qbittorrent/config`, `bitwarden/data`,
  `homeassistant/config`, Traefik ACME, *arr configs). This is the default for
  operator-visible databases and settings. Plex and download Compose live in
  `plex/` and `download/`; do not restore Gluetun, qBittorrent, or Prowlarr
  state under `media/`.
- **Engine state:** Docker named volumes prefixed `homelab_` for runtime that
  should not sit in the git checkout (Hermes profiles, Vaultwarden broker
  tools, media-orchestrator Postgres and Rezka session, Movie-Tracker cache).
  Do not keep `external: true` pins to old project prefixes
  (`hermes-home_*`, `media-orchestrator_*`).
- **Ephemeral:** tmpfs (`FlareSolverr` `/config`, container `/tmp`). Do not
  persist challenge-solver or throwaway cache state as an anonymous volume.
- **Secrets:** ignored files under `secrets/` (mode `0640`), never named
  volumes or Compose literals.

On restore, recreate bind-mount directories from backup, recreate `homelab_*`
volumes only for engine state, and remount the library disks. The root `.env`
alone is not enough.
