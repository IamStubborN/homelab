# OpenList

Multi-storage file browser at `https://openlist.${DOCKER_DOMAIN}` (Traefik, no host ports).
LAN-only on `*.host-5.example.invalid.example.test` — primary file manager UI.

## Stack

- `openlistteam/openlist:latest` — UI/API on `:5244` (Watchtower-enabled)
- Runs as `user: 1000:1000` (deployment account) for data volume permissions

State: `openlist/data/` on the LXC disk (gitignored). Do not put state on `/mnt/internal`.
Admin password: ignored file `openlist/data/.admin-password` (chmod 600). Optional env
`OPENLIST_ADMIN_PASSWORD` sets it on first start; unset after bootstrap.

## Public URL

`https://openlist.${DOCKER_DOMAIN}` — Traefik Host rule only (replaces former `files.*` Filestash URL).

## Local mounts

Same host paths Samba shares, mounted RW:

| Host path | Container path | OpenList mount |
| --- | --- | --- |
| `${INTERNAL_STORAGE:-/mnt/internal}` | `/mnt/shares/internal` | `/internal` |
| `${USB_STORAGE:-/mnt/usb_drive}` | `/mnt/shares/usb_drive` | `/usb_drive` |

Never delete or rearrange `save/`, `_partial/`, `_cull/` under internal.

## Additional storage

Configure storage providers, bucket names, mount labels, regions and credentials
through the administrator UI/API after bootstrap. Keep the actual account and
storage inventory in private operator records, not in this repository.

## Guest access (LAN)

If enabled in admin settings, the built-in **guest** user can browse without login
(read-only recommended). Toggle via Admin → Users → guest → enable, or settings API
`allow_guest` / guest user `disabled=false` and permission bits. Prefer site-wide
guest read only on this LAN-only Traefik host.

## Ops

Included from root `compose.yml`. After volume or env changes:

```bash
mkdir -p openlist/data && chmod 700 openlist/data
# first boot only — password also written to openlist/data/.admin-password
# export OPENLIST_ADMIN_PASSWORD='...'   # from that file; do not commit
docker compose up -d openlist
docker compose ps openlist
curl -fsS https://openlist.${DOCKER_DOMAIN}/ping
```

Verify Local: Admin or API list `/internal` and `/usb_drive`.
Spot-check one explicitly configured private storage mount.
