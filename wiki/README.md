# Wiki host services

The live vault is `${WIKI_ROOT}` on docker.local (default `/mnt/internal/wiki`).
It is not in this git clone. One Obsidian vault = the entire wiki root
(Andrii + Valentyna + `shared/health`).

This module ships:

- **obsidian-sync** — official Obsidian Sync (`obsidian-headless`)
- **health-drive** — one-way rclone mirror to Google Drive `HealthWiki/`

Do **not** substitute Syncthing. Do **not** add a Samba write path.

```text
${WIKI_ROOT}                 host, canonical, uid 10000:10000
  andrii/                    Hermes Andrii WIKI_PATH
  valentyna/                 Hermes Valentyna WIKI_PATH
  shared/health/             health MCP cashier
  .obsidian/                 created by obsidian-headless on sync-setup

obsidian-sync  mounts ${WIKI_ROOT} rw → /vault
health-drive   mounts ${WIKI_ROOT} ro → /data
```

## Bootstrap

Tracked script: [`bootstrap-vault.sh`](bootstrap-vault.sh). Idempotent.
Creates `andrii/`, `valentyna/`, and
`shared/health/{data/{andrii,valentyna},generated,people/{andrii,valentyna},family,raw/{andrii,valentyna,family}}`,
then writes initial SCHEMA/index/log from
[`health/docs/wiki-SCHEMA.example.md`](../health/docs/wiki-SCHEMA.example.md)
and
[`health/docs/wiki-health-SCHEMA.example.md`](../health/docs/wiki-health-SCHEMA.example.md).
Existing SCHEMA.md / index.md / log.md / jsonl are left untouched.

Does not require root. Does not SSH. Does not invent `.obsidian/` (that
appears on first `sync-setup`). Does not create `andrii/shared` — Hermes
bind-mounts `${WIKI_ROOT}/shared`.

```bash
# laptop / CI: any writable temp dir
wiki/bootstrap-vault.sh /tmp/wiki-test
wiki/tests/test-bootstrap-vault.sh

# docker.local after G3, as the vault owner
sudo -u '#10000' wiki/bootstrap-vault.sh /mnt/internal/wiki
```

Default argument is `/mnt/internal/wiki` (or `$WIKI_ROOT` if set).
`/opt/data/wiki` is wrong on this host.

## G3 — Host directory (human; do not automate)

Before first deploy. Do **not** run this from a Worker.

SSH check (path must exist only after this gate):

```bash
ssh docker.local.iamstubborn.dev 'ls -la /mnt/internal/wiki'
```

On docker.local:

```bash
sudo mkdir -p /mnt/internal/wiki
sudo chown -R 10000:10000 /mnt/internal/wiki
sudo chmod 2770 /mnt/internal/wiki
sudo install -d -o 10000 -g 10000 -m 0700 health/secrets/obsidian
sudo install -d -o 10000 -g 10000 -m 0700 health/secrets/rclone
```

Every process that writes the vault is `10000:10000`. Host has no passwd
entry for 10000; numeric ownership is enough.

## obsidian-sync

- Service: `obsidian-sync` in `wiki/compose.yml`
- Image: `homelab-obsidian-sync:local` (build context `wiki/obsidian-sync/`)
- Base: official `node:22-bookworm-slim` pinned by digest
- CLI: `obsidian-headless@0.0.14` (`ob`)
- Command: `ob sync --continuous --path /vault`
- Vault: `${WIKI_ROOT:-/mnt/internal/wiki}` mounted **read-write** at `/vault`
- HOME: gitignored `health/secrets/obsidian/` → `/home/obsidian`
- UID:GID: `10000:10000`
- Watchtower: off
- Does **not** join `health-internal`

Credentials stay under `$HOME` (`~/.config/obsidian-headless/` or
`~/.obsidian-headless/`). Never in the vault, never in Drive, never in
Compose env. Vault link state after `sync-setup` also lives on that HOME
volume (`sync/` + sqlite), not under `${WIKI_ROOT}`.

Remote vault name: **FamilyWiki**. One remote vault = the entire
`${WIKI_ROOT}`.

## G1 — Obsidian Sync login (human; do not automate)

Requires an active [Obsidian Sync](https://obsidian.md/sync) subscription.
Complete this on docker.local **before** `docker compose up` for
`obsidian-sync`. Login is interactive `docker compose run`, not the
service command.

From the repository root, after the image is built
(`docker compose build obsidian-sync`):

```bash
docker compose run --rm -it --user 10000:10000 --entrypoint ob obsidian-sync login
docker compose run --rm -it --user 10000:10000 --entrypoint ob obsidian-sync sync-list-remote
# create the remote vault in the Obsidian account if none exists:
#   docker compose run --rm -it --user 10000:10000 --entrypoint ob \
#     obsidian-sync sync-create-remote --name FamilyWiki
docker compose run --rm -it --user 10000:10000 --entrypoint ob obsidian-sync \
  sync-setup --vault FamilyWiki --path /vault --device-name docker.local
docker compose run --rm -it --user 10000:10000 --entrypoint ob obsidian-sync \
  sync-config --path /vault --file-types image,audio,video,pdf,unsupported
```

`--file-types image,audio,video,pdf,unsupported` is required so chart
PNGs and lab PDFs leave the server.

An optional E2E vault password, if enabled on the account, belongs in
`health/secrets/obsidian/` and is passed only to that `sync-setup` run
(`--password`). Never put it in Compose env or a bare `$` in an env file.

`.obsidian/` is created by `obsidian-headless` on first `sync-setup`. Do
not invent a fake vault config in git.

`docker compose up -d obsidian-sync` is a later human **G5** step, after
G1 and G3. The Family Health deploy/rollback runbook (G1–G5, cashier,
Hermes recreate) is [`health/README.md`](../health/README.md).

## Samba / LAN visibility

T7 does **not** add a Samba share. The existing share is path `/mnt`,
`force user/group = iamstubborn` (uid 1000). `${WIKI_ROOT}` already
appears as `share/internal/wiki`. LAN writes would be uid 1000 and fight
Hermes — treat that path as **read-only visibility** only.

Write path is official Obsidian Sync on laptops/phones. A later `sshfs`
(or a dedicated share that does not rewrite the current Samba layout) is
a follow-up; ask before adding either.

## health-drive

One-way copy: host vault → Google Drive folder `HealthWiki/`.

- Service: `health-drive` in `wiki/compose.yml`
- Image: `rclone/rclone:1.75.0` pinned by digest
- Source: `${WIKI_ROOT:-/mnt/internal/wiki}` mounted **read-only** at `/data`
- Destination: `drive:HealthWiki/` (new English folder)
- First rollout: `rclone copy` (no deletes)
- Cadence: nightly (`sleep 86400` after each copy)
- UID:GID: `10000:10000`
- Watchtower: off
- Does **not** join `health-internal`

Never bisync. Never rsync. Never target the existing Drive folder `Здоровье/`.
Do not reuse the laptop remote `healthdrive`; the server has its own config.

OAuth lives in gitignored `health/secrets/rclone/` (directory mount at
`/config/rclone` so token refresh can rewrite `rclone.conf`). Secrets are
files, not Compose env interpolation.

## G2 — Server rclone OAuth (human; do not automate)

Complete this on/via `docker.local` **before** `docker compose up` for
`health-drive`. rclone’s shared Google client_id stops working during 2026;
create your own. Guide: <https://rclone.org/drive/#making-your-own-client-id>.
Headless authorize: <https://rclone.org/remote_setup/>.

1. Google Cloud Console → new project (e.g. `homelab-healthwiki`) → enable
   **Google Drive API**.
2. OAuth consent screen (External is fine for a personal Gmail; add the Drive
   account as a test user).
3. Credentials → Create OAuth client ID → **Desktop app**. Redirect URI must
   stay `http://127.0.0.1:53682/`.
4. On the clone:

   ```bash
   sudo install -d -o 10000 -g 10000 -m 0700 health/secrets/rclone
   cp wiki/rclone/rclone.conf.example health/secrets/rclone/rclone.conf
   sudo chown 10000:10000 health/secrets/rclone/rclone.conf
   sudo chmod 0600 health/secrets/rclone/rclone.conf
   ```

   Put `client_id` / `client_secret` only in that ignored `rclone.conf`.
   Do not paste them into `.env` or Compose.

5. Authorize. Preferred: on a laptop run the **same** rclone **1.75.0** with
   that client id, then paste the token into a server `rclone config`:

   ```bash
   # laptop (browser)
   rclone authorize "drive" --client-id … --client-secret …

   # docker.local — custom entrypoint is the copy loop, so override it
   docker compose run --rm -it --user 10000:10000 --entrypoint rclone \
     health-drive config
   ```

   Answer `N` to the browser prompt and paste the token. Remote name `drive`,
   scope **`drive.file`**, Shared Drive = no.

   Alternative: SSH tunnel and answer `Y` in the container:

   ```bash
   ssh -L 53682:127.0.0.1:53682 docker.local.iamstubborn.dev
   docker compose run --rm -it --user 10000:10000 -p 53682:53682 \
     --entrypoint rclone health-drive config
   ```

6. Create the destination folder with rclone (so a `drive.file` scope can own
   it). If the folder was created in the Drive UI first, `drive.file` cannot
   see it — delete that UI folder and let rclone mkdir, or use scope `drive`
   with dest still `drive:HealthWiki/`.

   ```bash
   docker compose run --rm --user 10000:10000 --entrypoint rclone \
     health-drive mkdir drive:HealthWiki
   docker compose run --rm --user 10000:10000 --entrypoint rclone \
     health-drive lsd drive:
   ```

   `lsd` must list `HealthWiki`. Do **not** copy into `Здоровье`.

G3 (host vault directory ownership) is a separate human gate before first
deploy. The rclone config dir above is part of G2/G3:

```bash
install -d -o 10000 -g 10000 -m 0700 health/secrets/rclone
```

## Dry-run (human / T10, not a deploy)

Does not write to Drive. Run from the repository root after G2:

```bash
docker compose run --rm --user 10000:10000 --entrypoint rclone health-drive \
  copy /data drive:HealthWiki --exclude-from /etc/rclone/exclude.txt --dry-run -v
```

Read the log: source is `/data`, dest is `drive:HealthWiki`, excludes match
`wiki/rclone/exclude.txt`, and nothing under `Здоровье/` is listed.

## Later switch: copy → sync

Keep `rclone copy` until the user accepts a dry-run of **sync** (sync can
delete dest files that vanished from the vault):

```bash
docker compose run --rm --user 10000:10000 --entrypoint rclone health-drive \
  sync /data drive:HealthWiki --exclude-from /etc/rclone/exclude.txt --dry-run -v
```

Only then change the subcommand in `wiki/rclone/copy-loop.sh` from `copy` to
`sync`. Do not enable bisync.
