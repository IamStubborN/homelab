# Homelab Compose

Docker Compose configuration for a self-hosted homelab stack.

This repository is public-safe by design: secrets, runtime databases, local Home Assistant configuration, ACME state, Tailscale state, and service-local runtime configs are ignored. Tracked files are either compose definitions or sanitized examples.

Deployment, checks and the configuration boundary: [AGENTS.md](AGENTS.md#deployment).

## Services

The root `compose.yml` (project `homelab`) includes one Compose file per
directory. Each README covers that service's secrets, configuration and
deployment.

| Directory | Services |
| --- | --- |
| [traefik](traefik/compose.yml) | `traefik` reverse proxy, Cloudflare DNS challenge |
| [glance](glance/compose.yml) | `glance` dashboard |
| [uptime-kuma](uptime-kuma/README.md) | `uptime-kuma` availability monitoring |
| [jacred](jacred/README.md) | `jacred`, `jacred-cron` torrent tracker index |
| [lampa](lampa/README.md) | `lampa`, `lampa-media`, `lampa-ai-adapter` |
| [download](download/compose.yml) | `gluetun`, `gluetun-torrserver` VPNs and their watchers, `qbittorrent`, `qbittorrent-port-sync`, `prowlarr`, `torrserver`, `torrserver-port-sync`, `solverr`, `solverr-crawl` ([TorrServer maintenance](download/TORRSERVER-MAINTENANCE.md)) |
| [mosquitto](mosquitto/compose.yml) | `mosquitto` MQTT broker |
| [homeassistant](homeassistant/compose.yml) | `homeassistant`, `tailscale-homeassistant` |
| [karakeep](karakeep/compose.yml) | `karakeep-web`, `meilisearch`, `chrome` |
| [kavita](kavita/compose.yml) | `kavita` |
| [plex](plex/compose.yml) | `plex`, `plex-auto-languages`, `plex-orphan-watcher`, `media-preview-generator` |
| [watchtower](watchtower/README.md) | `watchtower`; nightly image retention, cleanup and host updates |
| [deunhealth](deunhealth/compose.yml) | `deunhealth` |
| [disk-watchdog](disk-watchdog/compose.yml) | `disk-watchdog` |
| [samba](samba/compose.yml) | `samba`, `wsdd`, `avahi` |
| [openlist](openlist/README.md) | `openlist` |
| [cliproxyapi](cliproxyapi/README.md) | `cli-proxy-api` OpenAI-compatible gateway |
| [rustdesk](rustdesk/compose.yml) | `hbbs`, `hbbr` |
| [freedium](freedium/compose.yml) | `freedium`, `freedium-db`, `freedium-cache`, `freedium-proxy` |
| [movie-tracker](movie-tracker/docker-compose.yml) | `movie-tracker` |
| [bitwarden](bitwarden/README.md) | `bitwarden` (Vaultwarden), `bitwarden-cloudflared` |
| [hermes](hermes/README.md) | `hermes-primary`, `hermes-secondary` agents and their helpers |
| [media](media/README.md) | `media-service`, `media-postgres`, `media-migrate`, `media-session-init`, `download-runner`, `gluetun-rezka`, `gluetun-rezka-watcher` |
| [health](health/README.md) | `health-service` |
| [wiki](wiki/README.md) | `syncthing` vault sync, `health-drive` (profile `g2-oauth`) |

Host-installed jobs outside Compose: [proxmox-backup](proxmox-backup/README.md)
and [proxmox-update](proxmox-update/README.md).

## Setup

Copy root environment values and runtime config examples, then fill real values
only in the ignored copies:

```bash
cp .env.example .env
cp traefik/config/config.example.yml traefik/config/config.yml
cp glance/.env.example glance/.env
cp glance/config/glance.example.yml glance/config/glance.yml
cp homeassistant/config/configuration.example.yaml homeassistant/config/configuration.yaml
cp homeassistant/config/automations.example.yaml homeassistant/config/automations.yaml
cp homeassistant/config/scripts.example.yaml homeassistant/config/scripts.yaml
cp homeassistant/config/scenes.example.yaml homeassistant/config/scenes.yaml
```

Secret files are listed in each Compose file's `secrets:` section and stay
ignored (mostly under `secrets/` directories); service READMEs name any other
ignored env or config files. Home Assistant's `homeassistant/config/secrets.yaml`
is ignored too; the example configs use no `!secret`, so it needs entries only
for `!secret` references you add.

Initialize the Freedium submodule, validate and start:

```bash
git submodule update --init --recursive
docker compose config --quiet
docker compose up -d
```

## Public Safety

Do not commit real local files. Keep private domains, Tailscale URLs, LAN IPs, MAC addresses, device IDs, tokens, passwords, and runtime databases in ignored files only.
