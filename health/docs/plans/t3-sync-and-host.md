# T3 — Official Obsidian Sync + rclone Docker + host paths

Status: scout findings for T6 / T7  
Date: 2026-08-19  
Host probed: `docker.local.iamstubborn.dev` (SSH, read-only)  
This file is tracked. No tokens, client secrets, or rclone.conf contents.

## Verdict

**GO — official Obsidian Sync can run headless under this image policy.**

Do not stop the DAG at G1 except as the planned human login. Official
`obsidian-headless` (npm, Node.js 22+, Dynalist Inc., current `0.0.14`) is
the real Sync client. There is **no official Obsidian Docker image**. The
policy-compliant way is an in-repo Dockerfile `FROM` official
`node:22-bookworm-slim` pinned by digest, `USER 10000:10000`,
`npm install -g obsidian-headless@0.0.14`, command `ob sync --continuous`.

Do **not** substitute Syncthing. If T7 later cannot get `ob login` /
`ob sync --continuous` working on this host, **ask the user** before any
other sync method.

Third-party `ghcr.io/belphemur/obsidian-headless-sync-docker` wraps the same
CLI but starts as root, remaps PUID via s6, and wants the token in env. Do
not use it unless the user asks. LinuxServer `obsidian` is the Electron GUI
and is out of scope.

---

## 1. Host path decision

```text
WIKI_ROOT=/mnt/internal/wiki
```

The plan default `/opt/data/wiki` is **wrong on this host**.

| Path | Live state (2026-08-19) |
|---|---|
| `/opt/data` | **missing** |
| `/opt/data/wiki` | **missing** |
| `/opt/homelab` | **missing** |
| `/opt` | only `containerd/`; lives on the 79 G root LV |
| `/` | 66 G / 79 G used, **8.9 G free (89%)**; Docker overlay is here |
| `/home/iamstubborn/homelab` | real git clone (`HOMELAB_ROOT`) |
| `/mnt/internal` | 3.6 T data disk, 40 G free, `INTERNAL_STORAGE`; mode `775` `1000:1000` |
| `/mnt/internal/data/{andrii,valentyna}` | existing personal dumps — **not** the wiki |
| `/mnt/usb_drive` | 1.9 T, 22 G free; media/torrents only |
| rclone / obsidian containers or images | **none** |
| host `rclone` binary | **none** (Proxmox backup rclone is on another host) |

No Docker user-namespace remapping (`daemon.json` has only log rotation).
`subuid`/`subgid` exist for `iamstubborn` but the engine is rootful. Bind-mount
UID 10000 is host UID 10000. Host has **no** passwd entry for 10000/10001;
that is fine (numeric ownership).

Do **not** put the live vault under the git clone or on the root LV.

Add to root `.env` / `.env.example` (T7):

```bash
WIKI_ROOT=/mnt/internal/wiki
```

G3 (human, do not run in T3/T6/T7 code):

```bash
sudo mkdir -p /mnt/internal/wiki
sudo chown -R 10000:10000 /mnt/internal/wiki
sudo chmod 2770 /mnt/internal/wiki
```

---

## 2. UID / GID map

Hermes already writes named-volume files as `10000:10000` (`HERMES_UID` /
`HERMES_GID`). Container PID 1 stays root (s6); the agent files are 10000.
Current `health-service` is `10001:10001` and its token files are `10001:10001
400`. The official `node` image user is `1000`. Official `rclone/rclone` runs
as `0` unless Compose sets `user:`.

**Every process that creates or edits vault files must be `10000:10000`.**
Do not keep the Python cashier at 10001 or it will fight Hermes on
`shared/health/`.

| Role | UID:GID | Vault mount | Notes |
|---|---|---|---|
| hermes-andrii / hermes-valentyna | `10000:10000` | rw personal + `shared` | already the agent uid |
| health-service (T4 Python) | **`10000:10000`** (change from 10001) | rw `${WIKI_ROOT}/shared/health` | chown token files `10000:10000 0400` when T4/T9 switch |
| `obsidian-sync` | `10000:10000` | rw `${WIKI_ROOT}` → `/vault` | Dockerfile `USER`; no PUID remapping |
| `health-drive` | `10000:10000` | **ro** `${WIKI_ROOT}` → `/data` | config dir rw for token refresh |
| Samba (existing) | force `1000:1000` | incidental if wiki lives under `/mnt/internal` | **not a write path** |

Config / secret ownership on the clone (gitignored `health/secrets/`):

```text
health/secrets/obsidian/     10000:10000 0700   (ob HOME)
health/secrets/rclone/       10000:10000 0700   (whole dir, not a single file)
```

Samba today (`samba/config/config.yml` on the host): one share `share`, path
`/mnt`, `force user/group = iamstubborn` (1000). Adding a wiki share would
edit that layout. **T7 must not add a Samba share.**
`${WIKI_ROOT}=/mnt/internal/wiki` will appear as `share/internal/wiki` on the
existing share. LAN writes would be uid 1000 and fight Hermes — treat Samba
as read-only visibility only. LAN write fallback is official Sync on
laptops, or later `sshfs` (ask the user).

---

## 3. Official Obsidian Sync (T7)

### 3.1 Upstream

- Docs: <https://obsidian.md/help/headless>, <https://obsidian.md/help/sync/headless>
- CLI: <https://github.com/obsidianmd/obsidian-headless>, npm `obsidian-headless@0.0.14`
- Requires Node.js **22** (`better-sqlite3@12.11.1`; forum reports Node 24+
  breakage). Use `node:22-bookworm-slim`, not `node:lts` / Alpine.
- License: `UNLICENSED` (official Obsidian binary). Open beta; pin the npm
  version, Watchtower off.
- Needs an active [Obsidian Sync](https://obsidian.md/sync) subscription (G1).

Commands (vault = directory):

```bash
ob login [--email …] [--password …] [--mfa …]
ob sync-list-remote
ob sync-setup --vault <id-or-name> --path /vault --device-name docker.local
ob sync-config --path /vault --file-types image,audio,video,pdf,unsupported
ob sync --path /vault --continuous
```

Default sync mode is `bidirectional` (correct: Hermes writes locally, phones
write remotely). `ob sync-config --file-types …` is required so chart PNGs
and lab PDFs leave the server.

### 3.2 Credentials (never in the vault or Drive)

After `ob login`, the token is a file under `$HOME`:

- `$HOME/.config/obsidian-headless/auth_token`, or
- `$HOME/.obsidian-headless/auth_token`

(community reports both; WhiteNoise 2026-03-05: beta paths still move.)

Mount `health/secrets/obsidian` as `/home/obsidian` (`HOME=/home/obsidian`).
Do not interpolate the token into Compose env. `ob logout` deletes and
invalidates the token.

Vault link state after `sync-setup` also lives under that HOME (`sync/` +
sqlite). Keep it on the secret volume, not under `${WIKI_ROOT}`.

### 3.3 Image policy

Pin the **index** digest (same style as `hindsight` / `cursorpipe`):

```text
node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
```

Resolved 2026-08-19 from Docker Hub (`linux/amd64` manifest
`sha256:a17d50af28002a160548bd4225b3cfcb12c5efcb171f79e68758f2885fb1b066`).
T7 should re-run `docker buildx imagetools inspect node:22-bookworm-slim`
and update if the tag moved.

### 3.4 Dockerfile (T7 creates `health/obsidian-sync/Dockerfile`)

```dockerfile
# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
FROM ${NODE_IMAGE}
ARG OBSIDIAN_HEADLESS_VERSION=0.0.14
RUN groupadd --gid 10000 obsidian \
 && useradd --uid 10000 --gid 10000 --create-home --home-dir /home/obsidian \
      --shell /usr/sbin/nologin obsidian \
 && npm install -g "obsidian-headless@${OBSIDIAN_HEADLESS_VERSION}" \
 && mkdir -p /vault \
 && chown 10000:10000 /vault /home/obsidian
USER 10000:10000
ENV HOME=/home/obsidian
WORKDIR /vault
ENTRYPOINT ["ob"]
CMD ["sync", "--continuous", "--path", "/vault"]
```

### 3.5 Compose snippet — `obsidian-sync` (T7)

Drop into `health/compose.yml` or a new `wiki/compose.yml` included from
root. Do **not** join `health-internal` (that network is `--internal`).
Default project network is enough for outbound HTTPS to Obsidian.

```yaml
  obsidian-sync:
    <<: *locked-down
    build:
      context: ./obsidian-sync
      dockerfile: Dockerfile
    image: homelab-obsidian-sync:local
    container_name: obsidian-sync
    user: "10000:10000"
    restart: unless-stopped
    init: true
    pids_limit: 64
    environment:
      HOME: /home/obsidian
      TZ: ${TIMEZONE:-UTC}
    volumes:
      - ${WIKI_ROOT:?set WIKI_ROOT}:/vault
      - ./secrets/obsidian:/home/obsidian
    tmpfs:
      - /tmp:rw,nosuid,nodev,size=64m
    labels:
      com.centurylinklabs.watchtower.enable: "false"
```

G1 login / first setup (human, interactive, after G3). Do not put this in
`command:`:

```bash
# from the clone on docker.local, after the image is built
docker compose run --rm -it --user 10000:10000 --entrypoint ob obsidian-sync login
docker compose run --rm -it --user 10000:10000 --entrypoint ob obsidian-sync sync-list-remote
# create the remote vault in the Obsidian account if none exists:
#   docker compose run --rm -it --user 10000:10000 --entrypoint ob \
#     obsidian-sync sync-create-remote --name FamilyWiki
docker compose run --rm -it --user 10000:10000 --entrypoint ob obsidian-sync \
  sync-setup --vault FamilyWiki --path /vault --device-name docker.local
docker compose run --rm -it --user 10000:10000 --entrypoint ob obsidian-sync \
  sync-config --path /vault --file-types image,audio,video,pdf,unsupported
docker compose up -d obsidian-sync
```

Suggested remote vault name: `FamilyWiki` (one vault = entire
`${WIKI_ROOT}`). E2E vault password, if the user enabled it, belongs in
`health/secrets/obsidian/` and is passed only to that `sync-setup` run
(`--password`), never in Compose env (and never a bare `$` in an env file).

---

## 4. rclone one-way Drive mirror (T6)

### 4.1 Image pin

Official image, maintained by rclone, Alpine, config dir
`/config/rclone` (mount the **directory**, not a single file — token
refresh renames the file). Docs: <https://rclone.org/install/#docker-installation>.

```text
rclone/rclone:1.75.0@sha256:b06aed988cf5967de7c25be5925240983981c757f4ed1ac9d2fa659d51d60548
```

`1.75.0` (2026-07-31) is current `latest` as of this scout. Index digest
above; amd64 manifest `sha256:ec1adc2ecacf03f3ae86a20907a76efdb83ddc9ed48ca90ab936a2e50da11afb`.
T6 may re-inspect before commit. Do not use `pfidr/rclone`, cron forks, or
the rclone Docker **volume plugin**.

No `crypt` remote. Plain `type = drive`. Do not set
`--drive-import-formats` (would turn `.md` into Google Docs).

### 4.2 Destination

```text
drive:HealthWiki/
```

- Remote name on the **server** is `drive`. Do **not** reuse the laptop
  remote `healthdrive` or copy that `rclone.conf`.
- English folder `HealthWiki/` is new. Never target `Здоровье/`.
- First command after OAuth: `rclone mkdir drive:HealthWiki` so a
  `drive.file` scope can own the folder. If the user creates the folder in
  the Drive UI first, `drive.file` cannot see it — then either delete it
  and let rclone mkdir, or use scope `drive` with dest still
  `drive:HealthWiki/`.
- First rollout: `rclone copy` (no deletes). Switch to `rclone sync` only
  after a user-accepted `--dry-run`.

### 4.3 Cadence: nightly

Keep the plan default. The vault is markdown + jsonl + a few PDFs/PNGs.
Drive is an archive / optional NotebookLM source, not the working copy.
15–30 min would only matter for automated NotebookLM, which this plan
does not do, and would spend personal-client Drive quota for nothing.

Official `rclone/rclone` has no cron. Use the same sleep-loop pattern as
`agent-browser-updater` (`sleep 86400`). First start copies immediately,
then every 24 h. Host `TIMEZONE=Europe/Sofia`.

### 4.4 Shared client_id retirement (G2)

<https://rclone.org/drive/> and the rclone forum (2026-07): rclone’s
shared Google Drive client_id **stops working during 2026** after a 90-day
notice. Creating your own is now the default in the config wizard
(`y/n> n`). Guide: <https://rclone.org/drive/#making-your-own-client-id>.

G2 human steps (do not authorize in T3/T6):

1. Google Cloud Console → new project (e.g. `homelab-healthwiki`) → enable
   **Google Drive API**.
2. OAuth consent screen (External is fine for a personal Gmail; add the
   Drive account as a test user).
3. Credentials → Create OAuth client ID → **Desktop app**. Redirect URI
   must stay `http://127.0.0.1:53682/`.
4. Put `client_id` / `client_secret` only in
   `health/secrets/rclone/rclone.conf` (gitignored).
5. Headless authorize on `docker.local` per
   <https://rclone.org/remote_setup/> — preferred: on the laptop run the
   **same** rclone 1.75.0 with that client id
   (`rclone authorize "drive" --client-id … --client-secret …`) and paste
   the token into `docker compose run --rm -it health-drive config` on the
   server answering `N` to the browser prompt. Alternative: SSH tunnel
   `ssh -L 53682:127.0.0.1:53682 docker.local.iamstubborn.dev` and answer
   `Y` in the container with `-p 53682:53682`.
6. Remote name `drive`, scope **`drive.file`**, Shared Drive = no.
7. `rclone mkdir drive:HealthWiki` then
   `rclone lsd drive:` — must list `HealthWiki` and must **not** be used
   to copy into `Здоровье`.

Example (tracked) `health/rclone/rclone.conf.example` — no token:

```ini
[drive]
type = drive
scope = drive.file
# client_id =
# client_secret =
# token =   # written by `rclone config` / authorize
```

### 4.5 Exclude list

Tracked file `health/rclone/exclude.txt` (use `--exclude-from` only; do
not mix `--filter-from` with `--exclude`):

```text
# Obsidian runtime (keep the rest of .obsidian)
.obsidian/cache/**
.obsidian/workspace.json
.obsidian/workspace-mobile.json

# OS junk
.DS_Store
**/.DS_Store
._*
**/._*
Thumbs.db
**/Thumbs.db
desktop.ini
**/desktop.ini
.Spotlight-V100/**
.Trashes/**
lost+found/**
```

`workspace*.json` is optional vs the plan text; include it so laptop UI
state does not churn Drive. Do **not** exclude all of `.obsidian`.

### 4.6 Compose snippet — `health-drive` (T6)

```yaml
  health-drive:
    <<: *locked-down
    image: rclone/rclone:1.75.0@sha256:b06aed988cf5967de7c25be5925240983981c757f4ed1ac9d2fa659d51d60548
    container_name: health-drive
    user: "10000:10000"
    restart: unless-stopped
    init: true
    read_only: true
    pids_limit: 32
    environment:
      TZ: ${TIMEZONE:-UTC}
      RCLONE_CONFIG: /config/rclone/rclone.conf
    volumes:
      - ${WIKI_ROOT:?set WIKI_ROOT}:/data:ro
      - ./secrets/rclone:/config/rclone
      - ./rclone/exclude.txt:/etc/rclone/exclude.txt:ro
      - ./rclone/copy-loop.sh:/usr/local/bin/copy-loop:ro
    tmpfs:
      - /tmp:rw,nosuid,nodev,size=32m
    entrypoint: ["/bin/sh", "/usr/local/bin/copy-loop"]
    labels:
      com.centurylinklabs.watchtower.enable: "false"
```

Tracked `health/rclone/copy-loop.sh`:

```sh
#!/bin/sh
set -eu
DEST="${RCLONE_DEST:-drive:HealthWiki}"
# First rollout: copy (no deletes). After a user-accepted dry-run of
# `rclone sync`, T6/T9 may switch the subcommand to sync.
while true; do
  rclone copy /data "$DEST" \
    --exclude-from /etc/rclone/exclude.txt \
    --fast-list \
    --transfers 2 \
    --checkers 4 \
    --drive-chunk-size 8M \
    --log-level INFO
  sleep 86400
done
```

Dry-run (human / T10, not a deploy):

```bash
docker compose run --rm --entrypoint rclone health-drive \
  copy /data drive:HealthWiki --exclude-from /etc/rclone/exclude.txt --dry-run -v
```

`health-drive` must not join `health-internal`.

---

## 5. Human gates (Orchestrator stops)

| Gate | When | What the user does |
|---|---|---|
| **G1** Obsidian Sync | before T7 `up` | Confirm paid Sync. Interactive `ob login` in `obsidian-sync` (email / password / MFA). `sync-list-remote` or `sync-create-remote`. `sync-setup --path /vault`. Optional E2E vault password. |
| **G2** rclone OAuth | before T6 `up` | Own Drive OAuth client (shared id dies in 2026). Authorize on/via `docker.local`. Remote `drive`, dest `HealthWiki/` only. Do not copy laptop `healthdrive`. |
| **G3** Host directory | before first deploy | `sudo mkdir -p /mnt/internal/wiki && sudo chown -R 10000:10000 /mnt/internal/wiki && sudo chmod 2770 /mnt/internal/wiki`. Also `install -d -o 10000 -g 10000 -m 0700` for `health/secrets/obsidian` and `health/secrets/rclone`. |

This scout did **not** mkdir, chown, authorize, or `docker compose up`.

---

## 6. T6 / T7 worker checklist

**T6**

- Add `health-drive` + `health/rclone/{exclude.txt,copy-loop.sh,rclone.conf.example}`.
- Document G2 in `health/README.md`.
- `docker compose config --quiet` includes the service.
- Secrets stay files under `health/secrets/rclone/`; never env interpolation.
- First command is `copy`, dest `drive:HealthWiki/`.

**T7**

- Dockerfile + `obsidian-sync` service. Watchtower off.
- Bootstrap script for `andrii/`, `valentyna/`, `shared/health/…` as the
  plan already specifies (not this scout).
- `.gitignore` safety net for `wiki/` and `/opt/data/wiki/` plus
  `/mnt/internal/wiki/`.
- `wiki/README.md`: live vault is `${WIKI_ROOT}` on the host.
- No Samba share rewrite.
- G1/G3 before live `up`.

**T4 implication (not this task):** run the Python cashier as `10000:10000`
when it bind-mounts the wiki, and chown the health API token files to match.

**T5 implication:** bind `${WIKI_ROOT}/andrii` + `…/shared` (and the
Valentyna pair) as `10000:10000`.

---

## 7. Sources

- Plan: `health/docs/plans/2026-08-19-family-health-wiki.md` §1.3, §1.6, §1.7, T3/T6/T7, G1–G3
- Official CLI: <https://github.com/obsidianmd/obsidian-headless>, npm `0.0.14`
- Official help: <https://obsidian.md/help/headless>, <https://obsidian.md/help/sync/headless>
- Token path reports: <https://forum.obsidian.md/t/111740>
- rclone Docker: <https://rclone.org/install/#docker-installation>
- rclone Drive + 2026 client_id: <https://rclone.org/drive/>, <https://forum.rclone.org/t/54005>
- Headless OAuth: <https://rclone.org/remote_setup/>
- Filters: <https://rclone.org/filtering/>
- Live SSH to `docker.local.iamstubborn.dev` (2026-08-19)
