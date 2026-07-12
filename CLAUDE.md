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
docker compose config --quiet && docker compose up -d --remove-orphans

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
- Each service has its own directory with `compose.yml`
- Disabled services are commented out in main compose.yml

### Network Architecture
- **Traefik** reverse proxy handles all HTTP/HTTPS traffic with Cloudflare DNS challenge
- **Gluetun** VPN container routes media services through NordVPN WireGuard
- Services use `network_mode: service:gluetun` to route through VPN
- Shared `proxy` network (external) connects all services to Traefik
- All services accessible via `*.${DOCKER_DOMAIN}` domain

### Key Service Groups
1. **Media Stack**: Plex, plex-auto-languages, media-preview-generator, qBittorrent, Prowlarr (active); Sonarr, Radarr, Bazarr, Lidarr, Readarr, Overseerr, Jellyfin (disabled)
2. **Media Orchestrator**: Inactive opt-in Compose scaffold (`media/compose.media-orchestrator.yml`) with a dedicated `gluetun-rezka` VPN namespace; see `media/README.md`
3. **Custom Apps**: KaraKeep (web scraper with AI/MeiliSearch), Freedium (Medium proxy), Movie-Tracker (Telegram bot)
4. **File Management**: Samba shares, Kavita (ebook reader), FileBrowser (disabled)
5. **Monitoring**: Watchtower (auto-updates), DeUnhealth (health checks)
6. **Other Services**: Bitwarden (Vaultwarden), Mosquitto (MQTT broker), RustDesk (remote desktop relay)

### VPN Routing (Gluetun)
Media services route through Gluetun container:
- qBittorrent and Prowlarr: `network_mode: service:gluetun`
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

Clean-host restore requires more than the root `.env`: create service-local env files for services with `env_file` (`glance/.env`, `speedtest-tracker/.env`), restore Docker secret files under `traefik/secrets/` and `media/secrets/`, restore ignored runtime data directories, and verify host prerequisites such as storage mounts, `/dev/net/tun`, `/dev/dri`, `/run/dbus`, Docker socket access, ports `80/443`, and the external `proxy` network.

Watchtower is configured in opt-in mode. Add `com.centurylinklabs.watchtower.enable=true` only to services that should be auto-updated. Keep stateful databases, source-built services, and private custom apps disabled unless their backup and restore path is tested.

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
**KaraKeep** (`/karakeep/`): Web scraper with Gemini AI summarization and MeiliSearch.

**Freedium** (`/freedium/`): Medium proxy with Caddy, PostgreSQL, Redis. The compose file builds from the pinned submodule at `freedium/repo/`. Restore it with:
```bash
git submodule update --init --recursive
```
Use the tracked helper for database backups:
```bash
freedium/backup-db.sh
```

**Movie-Tracker** (`/movie-tracker/`): Python Telegram bot deployed from the private image `ghcr.io/example/movie-tracker:latest`. The homelab repository intentionally tracks only the compose wrapper. A clean host must be logged in to GHCR before pulling:
```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u example-user --password-stdin
docker compose pull movie-tracker
```

When modifying custom applications:
- For image-based apps such as Movie-Tracker, change and publish the application in its own repository, then pull the image here.
- For source-built apps such as Freedium, update the pinned submodule deliberately and rebuild the relevant service.

### Storage Mounts
- `${INTERNAL_STORAGE:-/mnt/internal}/` - Main storage (torrents, media, books)
- `${USB_STORAGE:-/mnt/usb_drive}/` - Secondary USB storage
- Services mount these as `/data/internal` and `/data/usb_drive`
