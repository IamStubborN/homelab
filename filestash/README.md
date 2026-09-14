# Filestash

Web file manager at `https://files.${DOCKER_DOMAIN}` (Traefik, no host ports).
LAN-only on `*.docker.example.invalid` — no public exposure assumed.

## Stack

- `machines/filestash:latest` — app UI on `:8334`
- `collabora/code:24.04.10.2.1` — Collabora Online (WOPI) for office docs, internal-only

State: `filestash/data/` on the LXC disk (gitignored). Do not put state on `/mnt/internal`.

## Public URL

`APPLICATION_URL` must be the **bare hostname** (`files.${DOCKER_DOMAIN}`), never `https://...`.
Filestash prefixes the scheme itself; a full URL becomes `http://https://...` redirects.
Runtime `general.host` in `data/config/config.json` must match that bare host.

## Auth (how it works now)

**Share browsing — no login form (LAN open).** Runtime middleware uses Filestash
`passthrough` with `strategy: direct`. Selecting **internal** or **usb_drive** opens
that Local backend immediately (no password prompt).

Filestash’s Local backend `Init()` always checks a password against `auth.admin`
(bcrypt). For auto-connect, encrypted `middleware.attribute_mapping.params` embeds
that same admin password statically for each share path. Users never type it; only
`/admin` asks for it.

**Admin console** (`/admin`) remains password-protected via `auth.admin` in
`data/config/config.json` (gitignored). The password is not stored in git.

Middleware `identity_provider.params` and `attribute_mapping.params` are AES-GCM
encrypted with a key derived from `general.secret_key`. They must be **single**-encrypted
JSON. Double-encrypting (or writing Python `None`) causes:
`unpacking idp - invalid character 'n' in literal null`.

## Primary storage (bind mounts → Local backends)

Same host paths Samba already shares, mounted RW into the container:

| Host path | Container path | Filestash Local label |
| --- | --- | --- |
| `${INTERNAL_STORAGE:-/mnt/internal}` | `/mnt/shares/internal` | `internal` |
| `${USB_STORAGE:-/mnt/usb_drive}` | `/mnt/shares/usb_drive` | `usb_drive` |

### How to open shares in the UI

1. Open `https://host-7.example.invalid`
2. Pick **internal** or **usb_drive**
3. Browse — chrooted to that mount (`save`, `_partial`, `_cull` stay untouched)

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

## S3 placeholders

Three empty S3 backends are registered as labels `s3-1`, `s3-2`, `s3-3` (no keys).
Fill endpoint / bucket / access key / secret in **Admin → Storage**, or say the
values here and we will wire auto-connect like the local shares.
