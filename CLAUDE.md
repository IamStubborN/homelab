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
1. **Media Stack**: Plex, qBittorrent, Prowlarr (active); Sonarr, Radarr, Bazarr, Lidarr, Readarr, Overseerr, Jellyfin (disabled)
2. **Custom Apps**: KaraKeep (web scraper with AI/MeiliSearch), Freedium (Medium proxy), Movie-Tracker (Telegram bot)
3. **File Management**: Samba shares, Kavita (ebook reader), FileBrowser (disabled)
4. **Monitoring**: Watchtower (auto-updates), DeUnhealth (health checks)

### VPN Routing (Gluetun)
Media services route through Gluetun container:
- qBittorrent and Prowlarr: `network_mode: service:gluetun`
- Plex: Does NOT route through VPN (direct network access)
- Health checks integrated with DeUnhealth for auto-restart

### Security Considerations
- All containers run with `security_opt: no-new-privileges:true`
- Media traffic routed through VPN via Gluetun
- Traefik handles SSL with Cloudflare DNS challenge
- Sensitive credentials stored in `.env` files (not in compose files)


## Restore Notes

Use `restore notes` for clean-host recovery. The repository intentionally does not contain runtime data or secrets. Freedium source is tracked as a pinned git submodule.

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
Check `.env` files in service directories for credentials:
- `/traefik/.env` - Cloudflare API (CF_API_EMAIL, CF_DNS_API_TOKEN)
- `/media/.env` - VPN credentials (WIREGUARD_PRIVATE_KEY, PLEX_CLAIM)
- `/karakeep/.env` - Gemini API, MeiliSearch keys
- `/movie-tracker/.env` - TMDb, Telegram, Prowlarr API keys

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
- `/mnt/internal/` - Main storage (torrents, media, books)
- `/mnt/usb_drive/` - Secondary USB storage
- Services mount these as `/data/internal` and `/data/usb_drive`
