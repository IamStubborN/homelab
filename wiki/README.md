# Wiki host services

The live vault is `${WIKI_ROOT}` on the Docker host (default
`/mnt/internal/wiki`). It is not in this repository. The whole wiki root is one
vault: Primary, Secondary and `shared/health`.

`wiki/compose.yml` defines:

- **syncthing**: device sync of the vault for desktop and phone clients;
- **health-drive**: one-way rclone copy to the Google Drive folder
  `HealthWiki/` (Compose profile `g2-oauth`, not started by a plain `up`).

```text
${WIKI_ROOT}                 host, canonical, uid 10000:10000
  primary/                   Hermes Primary wiki (HERMES_PRIMARY_WIKI_PATH)
  secondary/                 Hermes Secondary wiki (HERMES_SECONDARY_WIKI_PATH)
  shared/                    mounted into both Hermes containers at /wiki/shared
  shared/health/             health MCP cashier

syncthing      mounts ${WIKI_ROOT} rw → /var/syncthing/wiki
health-drive   mounts ${WIKI_ROOT} ro → /data
```

The files in `${WIKI_ROOT}` are the source of truth. Syncthing devices hold
copies; Hermes and the health cashier write the host files directly. Every
process that writes the vault runs as `10000:10000`; the host needs no passwd
entry for that UID.

The vault is also visible through the existing Samba share of `/mnt`. Treat
that path as read-only: LAN writes land as UID 1000 and fight Hermes. Devices
write through Syncthing.

## Host directory

On a new host, create the vault root and the rclone config directory, then run
the bootstrap as the vault owner:

```bash
sudo mkdir -p /mnt/internal/wiki
sudo chown 10000:10000 /mnt/internal/wiki
sudo chmod 2770 /mnt/internal/wiki
sudo install -d -o 10000 -g 10000 -m 0700 health/secrets/rclone
sudo -u '#10000' wiki/bootstrap-vault.sh /mnt/internal/wiki
```

[`bootstrap-vault.sh`](bootstrap-vault.sh) is idempotent and needs no root. It
creates `primary/`, `secondary/` and
`shared/health/{data/{primary,secondary},generated,people/{primary,secondary},family,raw/{primary,secondary,family}}`,
then writes initial SCHEMA/index/log files from
[`health/docs/wiki-SCHEMA.example.md`](../health/docs/wiki-SCHEMA.example.md)
and
[`health/docs/wiki-health-SCHEMA.example.md`](../health/docs/wiki-health-SCHEMA.example.md).
Existing SCHEMA.md, index.md, log.md and jsonl files are left untouched. It does
not create `primary/shared`: Hermes bind-mounts `${WIKI_ROOT}/shared`. The
default argument is `$WIKI_ROOT`, else `/mnt/internal/wiki`.

```bash
wiki/bootstrap-vault.sh /tmp/wiki-test
wiki/tests/test-bootstrap-vault.sh
```

## syncthing

- Image: `syncthing/syncthing:latest`, updated by Watchtower
- UID:GID `10000:10000`, so synced files match the cashier and Hermes ownership
- Vault: `${WIKI_ROOT}` mounted read-write at `/var/syncthing/wiki`
- State and device keys: ignored `wiki/syncthing/home/` → `/var/syncthing`
- GUI: `https://syncthing.${DOCKER_DOMAIN}` through Traefik (port 8384), LAN
  and VPN only; set a GUI admin password on first login
- Joins only `proxy`, not `health-internal`

Share the folder `/var/syncthing/wiki` with each device from the GUI. Treat
`wiki/syncthing/home/` as a credential: it holds the device identity.

## health-drive

One-way copy from the host vault to `drive:HealthWiki/`. `wiki/rclone/copy-loop.sh`
runs `rclone copy` (no deletes) with `wiki/rclone/exclude.txt`, then sleeps 24
hours. It never runs bisync or sync.

- Image: `rclone/rclone`, pinned by digest; Watchtower off
- Source: `${WIKI_ROOT}` read-only at `/data`
- Config: ignored `health/secrets/rclone/` → `/config/rclone` (a directory
  mount, so token refresh can rewrite `rclone.conf`)
- UID:GID `10000:10000`; default project network for outbound HTTPS, not
  `health-internal`

Start it only after the OAuth setup below:

```bash
docker compose --profile g2-oauth up -d health-drive
```

Never target the Drive folder `Здоровье/`, and do not reuse a laptop rclone
remote; the server has its own config.

### OAuth setup

rclone's shared Google client ID is being retired, so use your own
([guide](https://rclone.org/drive/#making-your-own-client-id),
[headless authorization](https://rclone.org/remote_setup/)).

1. In Google Cloud Console, create a project and enable the Google Drive API.
2. Configure the OAuth consent screen (External with the Drive account as a
   test user is enough for a personal account).
3. Create an OAuth client ID of type Desktop app; keep the redirect URI
   `http://127.0.0.1:53682/`.
4. On the Docker host, from the checkout root:

   ```bash
   cp wiki/rclone/rclone.conf.example health/secrets/rclone/rclone.conf
   sudo chown 10000:10000 health/secrets/rclone/rclone.conf
   sudo chmod 0600 health/secrets/rclone/rclone.conf
   ```

   Put `client_id` and `client_secret` only in that ignored file, never in
   `.env` or Compose.

5. Authorize with the same rclone version on a machine with a browser, then
   paste the token into the server config (the service entrypoint is the copy
   loop, so override it):

   ```bash
   rclone authorize "drive" --client-id … --client-secret …   # with a browser
   docker compose run --rm -it --user 10000:10000 --entrypoint rclone \
     health-drive config                                        # on the host
   ```

   Answer `N` to the browser prompt and paste the token. Remote name `drive`,
   scope `drive.file`, Shared Drive no. Alternatively tunnel the callback port
   (`ssh -L 53682:127.0.0.1:53682 docker-host.example.com`) and run the same
   `config` with `-p 53682:53682`, answering `Y`.

6. Let rclone create the destination, so the `drive.file` scope owns it (a
   folder created in the Drive UI is invisible to that scope):

   ```bash
   docker compose run --rm --user 10000:10000 --entrypoint rclone \
     health-drive mkdir drive:HealthWiki
   docker compose run --rm --user 10000:10000 --entrypoint rclone \
     health-drive lsd drive:
   ```

### Dry run

Writes nothing to Drive:

```bash
docker compose run --rm --user 10000:10000 --entrypoint rclone health-drive \
  copy /data drive:HealthWiki --exclude-from /etc/rclone/exclude.txt --dry-run -v
```

The log must show source `/data`, destination `drive:HealthWiki`, the excludes
from `wiki/rclone/exclude.txt`, and nothing under `Здоровье/`. Switching
`copy-loop.sh` to `rclone sync` would delete Drive files that vanished from the
vault; do it only after a reviewed `sync --dry-run`.
