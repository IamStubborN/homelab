# OpenList

Multi-storage file browser at `https://openlist.${DOCKER_DOMAIN}` (Traefik, no host ports).
LAN-only on `*.docker.example.invalid` — does **not** replace Filestash (`files.*`).

## Stack

- `openlistteam/openlist:latest` — UI/API on `:5244` (Watchtower-enabled)
- Runs as `user: 1000:1000` (host `iamstubborn`) for data volume permissions

State: `openlist/data/` on the LXC disk (gitignored). Do not put state on `/mnt/internal`.
Admin password: ignored file `openlist/data/.admin-password` (chmod 600). Optional env
`OPENLIST_ADMIN_PASSWORD` sets it on first start; unset after bootstrap.

## Public URL

`https://openlist.${DOCKER_DOMAIN}` — Traefik Host rule only. Filestash keeps `files.*`.

## Local mounts

Same host paths Samba/Filestash share, mounted RW:

| Host path | Container path | OpenList mount |
| --- | --- | --- |
| `${INTERNAL_STORAGE:-/mnt/internal}` | `/mnt/shares/internal` | `/internal` |
| `${USB_STORAGE:-/mnt/usb_drive}` | `/mnt/shares/usb_drive` | `/usb_drive` |

Never delete or rearrange `save/`, `_partial/`, `_cull/` under internal.

## Atlas S3

Fourteen AWS S3 (`eu-central-1`) storages, one mount each (configured via admin API,
credentials copied from Filestash gitignored config — never commit keys):

| Mount | Bucket | Root/prefix |
| --- | --- | --- |
| `/Atlas/Test/SR` | `static.pl-test.cdn-platform.xyz` | _(bucket root)_ |
| `/Atlas/Test/BO` | `bo.pl-test.cdn-platform.xyz` | |
| `/Atlas/Feature/BO` | `bo.pl-feature.cdn-platform.xyz` | |
| `/Atlas/Test/CMS` | `media.pl-test.cdn-platform.xyz` | `cms/` |
| `/Atlas/Stage/SR` | `static.pl-stage1.cdn-platform.xyz` | |
| `/Atlas/Stage/BO` | `bo.pl-stage1.cdn-platform.xyz` | |
| `/Atlas/Stage/CMS` | `media.pl-stage1.cdn-platform.xyz` | `cms/` |
| `/Atlas/Stage/CMS2` | `media.pl-stage1.cdn-platform.xyz` | `cms2/` |
| `/Atlas/Green-Prod/SR` | `static.pl-01.cdn-platform.xyz` | |
| `/Atlas/Green-Prod/BO` | `bo.pl-01.cdn-platform.xyz` | |
| `/Atlas/Green-Prod/CMS` | `media.pl-01.cdn-platform.xyz` | `cms/` |
| `/Atlas/Yellow-Prod/SR` | `static.pl-01.cdn-yellow-platform.xyz` | |
| `/Atlas/Yellow-Prod/BO` | `bo.pl-01.cdn-yellow-platform.xyz` | |
| `/Atlas/Yellow-Prod/CMS` | `media.pl-01.cdn-yellow-platform.xyz` | `cms/` |

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
Spot-check S3: `/Atlas/Test/SR`, `/Atlas/Green-Prod/CMS`, `/Atlas/Yellow-Prod/CMS`.
