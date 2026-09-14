# Filestash

Web file manager at `https://files.${DOCKER_DOMAIN}` (Traefik, no host ports).

## Stack

- `machines/filestash:latest` — app UI on `:8334`
- `collabora/code:24.04.10.2.1` — Collabora Online (WOPI) for office docs, internal-only

State: `filestash/data/` on the LXC disk (gitignored). Do not put state on `/mnt/internal`.

## Public URL

`APPLICATION_URL` must be the **bare hostname** (`files.${DOCKER_DOMAIN}`), never `https://...`.
Filestash prefixes the scheme itself; a full URL becomes `http://https://...` redirects.
Runtime `general.host` in `data/config/config.json` must match that bare host.

## Primary storage (bind mounts → Local backends)

Same host paths Samba already shares, mounted RW into the container:

| Host path | Container path | Filestash Local label |
| --- | --- | --- |
| `${INTERNAL_STORAGE:-/mnt/internal}` | `/mnt/shares/internal` | `internal` |
| `${USB_STORAGE:-/mnt/usb_drive}` | `/mnt/shares/usb_drive` | `usb_drive` |

Runtime `data/config/config.json` (gitignored) enables those Local connections and maps
passthrough `password_only` auth so the login password is the Filestash **admin password**.
Attribute mapping roots each backend at the container path above (trailing slash required).

### How to open shares in the UI

1. Open `https://host-7.example.invalid`
2. Pick **internal** or **usb_drive** on the login screen
3. Enter the Filestash **admin password** (set on first boot; also printed once in `docker compose logs filestash`)
4. Browse — chrooted to that mount (`save`, `_partial`, `_cull` stay untouched)

Admin → Storage can add more backends later (multiple **S3** connections are supported;
no lab S3 credentials are configured by default).

## Optional SMB fallback

Samba (`samba/compose.yml`) uses `network_mode: host`, so it is not on Docker bridge DNS.
Compose maps hostname `samba` → `host-gateway` (smbd on `:445`). Prefer Local binds above.

| Field | Value |
| --- | --- |
| Type | `samba` |
| Label | `samba` |
| Hostname | `samba` |
| Username / Password | from live `samba/config/config.yml` (gitignored) |
| Port | `445` |
| Share Name | `share` |

Browse `share/internal` and `share/usb_drive` after connect.

## Ops

Included from root `compose.yml`. Recreate after volume or config changes:

```bash
docker compose up -d --force-recreate filestash filestash-wopi
```

Verify mounts: `docker exec filestash ls /mnt/shares/internal /mnt/shares/usb_drive`
