# Filestash

Web file manager at `https://files.${DOCKER_DOMAIN}` (Traefik, no host ports).

## Stack

- `machines/filestash:latest` — app UI on `:8334`
- `collabora/code:24.04.10.2.1` — Collabora Online (WOPI) for office docs, internal-only

State: `filestash/data/` on the LXC disk (gitignored). Do not put state on `/mnt/internal`.

## First login

1. Open `https://host-7.example.invalid`
2. On first boot Filestash asks you to set the **admin password** (also printed once in `docker compose logs filestash`)
3. In Admin → Storage backends, enable **Samba** (or use the pre-seeded connection in `data/config/config.json` if present)
4. Prefer the SMB backend over bind-mounting all of `/mnt/internal` read-write

## SMB → existing Samba (homelab)

Samba (`samba/compose.yml`) uses `network_mode: host`, so it is not on the Docker bridge DNS. Filestash compose maps hostname `samba` to `host-gateway` (verified reachable on `:445` via the `proxy` gateway).

Ready-to-paste Admin → Storage → Samba fields:

| Field | Value |
| --- | --- |
| Type | `samba` |
| Label | `Samba` (or any label) |
| Hostname | `samba` |
| Username | same as `samba/config/config.yml` → `auth[].user` (currently `iamstubborn`) |
| Password | same as `samba/config/config.yml` → `auth[].password` (gitignored; do not commit) |
| Port | `445` |
| Share Name | `share` |
| Domain | _(leave empty)_ |
| Path | _(optional)_ after connect, browse `share/internal` for `/mnt/internal` and `share/usb_drive` for USB |

Alternates if `samba` host alias is missing: `192.0.2.13` (proxy gateway) or `docker.example.invalid` / `192.0.2.19`.

Do **not** invent credentials — copy from live `samba/config/config.yml` on the Docker host.

## Ops

Included from root `compose.yml`. Recreate with:

```bash
docker compose up -d filestash filestash-wopi
```
