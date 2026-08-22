# Family Health stack

The live stack is a Python MCP cashier. It writes append-only jsonl under
`${WIKI_ROOT}/shared/health` and serves the same streamable-HTTP endpoint
Hermes already uses:

```text
http://health-service:8080/internal/mcp
```

- Image: `family-health-mcp:local` (build context `health/mcp`)
- Container name: `health-service` (unchanged on purpose)
- Process UID:GID: `10000:10000`
- Host vault: `${WIKI_ROOT}` = `/mnt/internal/wiki` on docker.local (not in git)
- Cashier mount: `${WIKI_ROOT}/shared/health` → `/wiki/shared/health`
- No Postgres. No SQLite. No Rust health binary in Compose.

`/opt/data/wiki` is wrong on this host. Do not create or mount it.

Obsidian Sync (`obsidian-sync`) and the one-way Drive mirror (`health-drive`)
live in [`wiki/compose.yml`](../wiki/compose.yml). Human gates **G1** (Obsidian
login) and **G2** (server rclone OAuth, destination `drive:HealthWiki/` only)
are documented in [`wiki/README.md`](../wiki/README.md). Do not reuse the
laptop `healthdrive` remote. Do not target `Здоровье/`.

The unused Phase 1 Rust crate remains on disk at [`service/`](service/) as
leftover source only. Compose does not build it. Do not treat
`family-health-service:local` or `health/service` mise/cargo as the live path.

Design and task DAG:
[docs/plans/2026-08-19-family-health-wiki.md](docs/plans/2026-08-19-family-health-wiki.md).
Host path decision (T3):
[docs/plans/t3-sync-and-host.md](docs/plans/t3-sync-and-host.md).

## Topology

```text
Telegram Andrii     → hermes-andrii      ─┐
Telegram Valentyna  → hermes-valentyna   ─┼─ health-internal ─ health-service
                                          │
                                          └─ writes only:
                                               ${WIKI_ROOT}/shared/health/data/**/*.jsonl
                                               ${WIKI_ROOT}/shared/health/generated/*.md

obsidian-sync  mounts ${WIKI_ROOT} rw → /vault     (does not join health-internal)
health-drive   mounts ${WIKI_ROOT} ro → /data      (does not join health-internal)
```

`health-internal` is still required. Only `health-service` and the two Hermes
profiles join it. Create it as an external attachable internal network.

The cashier fails closed if the wiki path is missing (`WikiStore` exits with
`missing health wiki directory`). Complete **G3** and
[`wiki/bootstrap-vault.sh`](../wiki/bootstrap-vault.sh) before the first
`health-service` up. Do not start the cashier against an empty or absent vault.

## Human gates (operator; do not automate)

These are not Worker tasks and are not GitHub Actions. Watchtower is off for
`health-service`, `obsidian-sync`, and `health-drive`.

| Gate | When | What the operator does |
| --- | --- | --- |
| **G1** Obsidian Sync | before `obsidian-sync` up | Confirm a paid [Obsidian Sync](https://obsidian.md/sync) subscription. Interactive `ob login` / `sync-setup` / `sync-config` in the container. Full commands: [`wiki/README.md`](../wiki/README.md). |
| **G2** Server rclone OAuth | before `health-drive` up | Create a personal Drive OAuth client (rclone’s shared id retires in 2026). Authorize on/via `docker.local`. Remote `drive`, dest `HealthWiki/` only. Full commands: [`wiki/README.md`](../wiki/README.md). |
| **G3** Host directory | before first deploy | Create `${WIKI_ROOT}` as `10000:10000` mode `2770`, plus secret dirs. Then bootstrap the vault. Commands below and in [`wiki/README.md`](../wiki/README.md). |
| **G4** Keep Google archive | after T8 ingest sample | Confirm the ingest sample before anyone deletes Google Docs/Sheet `Здоровье/`. Leave the archive in place until that confirmation. |
| **G5** Recreate Hermes | after G3 + bootstrap (and G1/G2 before those wiki services) | Manual `docker compose up` / `--force-recreate` of Hermes from this runbook. No Watchtower. No GitHub Actions. |

## G3 + bootstrap (before first `health-service` up)

On docker.local. Do **not** run this from a Worker or from this laptop against
the live host unless you are the operator at **G3**.

```bash
sudo mkdir -p /mnt/internal/wiki
sudo chown -R 10000:10000 /mnt/internal/wiki
sudo chmod 2770 /mnt/internal/wiki
sudo install -d -o 10000 -g 10000 -m 0700 health/secrets
sudo install -d -o 10000 -g 10000 -m 0700 health/secrets/obsidian
sudo install -d -o 10000 -g 10000 -m 0700 health/secrets/rclone
sudo -u '#10000' wiki/bootstrap-vault.sh /mnt/internal/wiki
```

SSH check after G3 (path must exist only after this gate):

```bash
ssh docker.local.iamstubborn.dev 'ls -la /mnt/internal/wiki'
```

## External network (before the first `up`)

Create the external network once on a new Docker host, before the first `up`:

```bash
set -eu
if docker network inspect health-internal >/dev/null 2>&1; then
  internal=$(docker network inspect -f '{{.Internal}}' health-internal)
  attachable=$(docker network inspect -f '{{.Attachable}}' health-internal)
  if [ "$internal" != true ] || [ "$attachable" != true ]; then
    echo "health-internal must have Internal=true and Attachable=true" >&2
    exit 1
  fi
else
  docker network create --internal --attachable health-internal
fi
```

An existing network with either check set to `false` is an operator blocker.
Do not recreate it automatically: first inspect attached containers and plan a
maintenance window.

Do **not** `docker volume create health-pg-data`. That volume is unused by
the live stack.

## API tokens

On the Linux Docker host, generate each value once in a private temporary file,
then install copies owned by the cashier UID. There are no Postgres passwords
and no UID `10001` files.

```bash
set -eu
umask 077
mkdir -p health/secrets
secret_tmp=$(mktemp -d)
chmod 0700 "$secret_tmp"
openssl rand -hex 32 > "$secret_tmp/andrii-token"
openssl rand -hex 32 > "$secret_tmp/valentyna-token"
sudo install -o 10000 -g 10000 -m 0400 "$secret_tmp/andrii-token" health/secrets/andrii.health_api_token
sudo install -o 10000 -g 10000 -m 0400 "$secret_tmp/valentyna-token" health/secrets/valentyna.health_api_token
rm -f "$secret_tmp/andrii-token" "$secret_tmp/valentyna-token"
rmdir "$secret_tmp"
stat -c '%u:%g %a %n' health/secrets/*.health_api_token
```

The expected modes are `10000:10000 400` for both API tokens. Leftover
`health_pg_bootstrap_password` / `health_service_db_password` files (UID
`0` / `10001`) are unused; do not create new ones.

On macOS, Docker Desktop does not reproduce Linux bind-mount ownership
faithfully; use the Linux ownership probe below before deploying to the
homelab host.

From the repository root, validate Compose and build the image before running
the ownership probe:

```bash
docker compose -f health/compose.yml config --quiet
docker compose -f wiki/compose.yml config --quiet
docker compose build health-service
```

Root `docker compose config --quiet` needs a filled `.env` next to
`compose.yml`. On a laptop without that file it fails on required variables
such as `KARAKEEP_OMNIROUTE_KEY`. Do not invent secrets. On docker.local,
after `.env` is present, `docker compose config --quiet` from the repo root
is the canonical whole-project check.

```bash
docker run --rm \
  -v "$PWD/health/secrets:/probe:ro" \
  --entrypoint /bin/sh \
  family-health-mcp:local \
  -eu -c 'test -r /probe/andrii.health_api_token; test -r /probe/valentyna.health_api_token'
```

The application receives only secret file paths. No API token is interpolated
into Compose environment values.

## G5 — Deploy (human; no Watchtower; no GitHub Actions)

G5 is a **manual** operator step on docker.local after G3 + bootstrap. Do not
run these `up` commands from a Worker. Do not enable Watchtower. Do not add
GitHub Actions.

Start health first, wait for the healthcheck, start wiki host services only
after their gates, then recreate both Hermes services so their entrypoint
installs the current config and skill:

```bash
docker compose build health-service
docker compose up -d health-service
docker compose up --wait health-service
# After G1 + G3:
docker compose up -d obsidian-sync
# After G2 + G3:
docker compose up -d health-drive
docker compose up -d --force-recreate hermes-andrii hermes-valentyna
docker compose ps health-service health-drive obsidian-sync hermes-andrii hermes-valentyna
docker compose logs --since=5m health-service hermes-andrii hermes-valentyna
```

The logs must show the cashier listening and no `health` MCP discovery/auth
error. From each Telegram bot, run one read-only health query and confirm that
the `health` tools are discovered before writing real data. User-facing
Telegram text stays Russian; identifiers stay English.

Image-only rollback and in-place downgrade are unsupported after MCP
tool-schema changes. On a failed deployment, stop `health-service` and both
Hermes services so they cannot write:

```bash
docker compose stop health-service hermes-andrii hermes-valentyna
```

The recommended default is to roll forward with a corrected Python cashier,
wiki mount, Hermes config, and skill. Do **not** switch Compose back to the
leftover Rust crate or reintroduce `health-postgres` as a recovery path.

For isolated maintenance, retain the root project name explicitly:

```bash
docker compose -p homelab -f health/compose.yml config --quiet
docker compose -p homelab -f health/compose.yml build health-service
```

`docker compose -p homelab -f health/compose.yml up -d` is the same G5
decision as the root project; do not run it from a Worker.

## Local cashier checks

Run service-local checks from the Python package, not from `health/service`:

```bash
cd health/mcp
python3 -m pytest
```

## T8 — one-shot Здоровье ingest

Ingest uses `WikiStore` (`via=system`). It is not HTTP MCP. Do not
`docker compose up`. Do not delete Google Docs/Sheet (`G4` is a human
gate after the sample). Do not ingest `valentyna-teeth/Data.zip`.

Column map: [`docs/plans/t8-ingest-map.md`](docs/plans/t8-ingest-map.md).
Counts-only report: [`docs/plans/t8-ingest-report.md`](docs/plans/t8-ingest-report.md).

G3 is not done. Run against a **temp vault**, not `/mnt/internal/wiki`:

```bash
VAULT=$(mktemp -d /tmp/t8-wiki-XXXX)
wiki/bootstrap-vault.sh "$VAULT"
# binaries already copied off Drive (read-only). Do not write to Здоровье/.
cd health/mcp
python3 -m health_mcp.ingest \
  --wiki-root "$VAULT/shared/health" \
  --export-dir /tmp/zdorovie-export \
  --xlsx "/tmp/zdorovie-xlsx/Дневник показателей здоровья.xlsx" \
  --raw-src /tmp/t8-zdorovie-raw
```

After G3, the same command with `--wiki-root "$WIKI_ROOT/shared/health"`
re-runs against the host vault. Medications/conditions/allergies have no
`source_event_id`; the command refuses a nonempty medications jsonl unless
`--force`. Chronology/journal sections are not facts. Weight sheet uses
columns C/D only.

## Leftover Rust source and unused Postgres volume

`health/service` is leftover Phase 1 Rust source. It is not shipped from
Compose. Do not make a Rust rebuild the default rollback.

The external volume `health-pg-data` is no longer in Compose. It is empty of
medical rows (only the old `people` seed, if the volume still exists on the
host). Routine `docker compose down` does not delete it.

Deleting that unused volume is a **later manual** operator step, after the
Python cashier is the accepted live path and the operator no longer wants the
empty Postgres volume around. It is not part of deploy, not part of G5, and
not part of routine rollback:

```bash
# Later manual only. Not a deploy or rollback command.
# DANGER: permanently deletes the unused Family Health PostgreSQL volume.
docker volume rm health-pg-data
```
