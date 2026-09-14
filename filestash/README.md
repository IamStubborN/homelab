# Filestash

Web file manager at `https://files.${DOCKER_DOMAIN}` (Traefik, no host ports).

## Stack

- `machines/filestash:latest` — app UI on `:8334`
- `collabora/code:24.04.10.2.1` — Collabora Online (WOPI) for office docs, internal-only

State: `filestash/data/` on the LXC disk (gitignored). Do not put state on `/mnt/internal`.

## First login

1. Open `https://host-7.example.invalid`
2. On first boot Filestash asks you to set the **admin password** (also printed once in `docker compose logs filestash`)
3. In Admin → Storage backends, add what you need (SMB to the Samba container/host, SFTP, S3, local plugin, etc.)
4. Prefer protocol backends over bind-mounting all of `/mnt/internal` read-write

## Ops

Included from root `compose.yml`. Recreate with:

```bash
docker compose up -d filestash filestash-wopi
```
