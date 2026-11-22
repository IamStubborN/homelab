# Family Health stack

`health-service` is a Python MCP cashier. It writes append-only jsonl under
`${WIKI_ROOT}/shared/health` and serves the streamable-HTTP endpoint both Hermes
profiles use:

```text
http://health-service:8080/internal/mcp
```

- Image: `${HEALTH_MCP_IMAGE}`, default `family-health-mcp:local` (build context `health/mcp`)
- Container name: `health-service`
- Process UID:GID: `10000:10000`
- Host vault: `${WIKI_ROOT}` (set in the ignored deployment environment)
- Cashier mount: `${WIKI_ROOT}/shared/health` → `/wiki/shared/health`
- Watchtower: off
- No database: the jsonl files are the store

The vault, its Syncthing device sync and the one-way Drive copy
(`health-drive`) are documented in [`wiki/README.md`](../wiki/README.md).

`health/service/` is an unused Rust crate. Compose does not build it; the live
service is the Python package in `health/mcp/`.

## Topology

```text
Telegram Primary    → hermes-primary   ─┐
Telegram Secondary  → hermes-secondary ─┼─ health-internal ─ health-service
                                        │
                                        └─ writes only:
                                             ${WIKI_ROOT}/shared/health/data/**/*.jsonl
                                             ${WIKI_ROOT}/shared/health/generated/*.md
```

Only `health-service` and the two Hermes profiles join `health-internal`. The network is `--internal`, so `health-service` has no route out; the Hermes containers reach the internet through their other networks.
`syncthing` and `health-drive` mount the vault but do not join it.

The cashier fails closed if the wiki path is missing (`WikiStore` exits with
`missing health wiki directory`). Create the vault and run
[`wiki/bootstrap-vault.sh`](../wiki/bootstrap-vault.sh) before the first start
(see the host directory section of `wiki/README.md`).

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

## API tokens

Each profile has its own bearer token. Hermes mounts the same files, so the
health stack owns them. On the Docker host, generate each value once in a
private temporary file, then install copies owned by the cashier UID:

```bash
set -eu
umask 077
mkdir -p health/secrets
secret_tmp=$(mktemp -d)
chmod 0700 "$secret_tmp"
openssl rand -hex 32 > "$secret_tmp/primary-token"
openssl rand -hex 32 > "$secret_tmp/secondary-token"
sudo install -o 10000 -g 10000 -m 0400 "$secret_tmp/primary-token" health/secrets/primary.health_api_token
sudo install -o 10000 -g 10000 -m 0400 "$secret_tmp/secondary-token" health/secrets/secondary.health_api_token
rm -f "$secret_tmp/primary-token" "$secret_tmp/secondary-token"
rmdir "$secret_tmp"
stat -c '%u:%g %a %n' health/secrets/*.health_api_token
```

The expected modes are `10000:10000 400` for both API tokens.
`HEALTH_PRIMARY_TOKEN_PATH` and `HEALTH_SECONDARY_TOKEN_PATH` can point the
secrets at other files. Set Hermes' `HERMES_PRIMARY_HEALTH_API_TOKEN_PATH` and
`HERMES_SECONDARY_HEALTH_API_TOKEN_PATH` to the same files at the same time, or
MCP authentication fails. The application receives only secret file paths; no
token is interpolated into Compose environment values. Leftover
`health_pg_bootstrap_password` and `health_service_db_password` files are
unused.

Docker Desktop on macOS does not reproduce Linux bind-mount ownership, so run
this ownership probe on the Linux host after building the image:

```bash
docker run --rm \
  -v "$PWD/health/secrets:/probe:ro" \
  --entrypoint /bin/sh \
  "${HEALTH_MCP_IMAGE:-family-health-mcp:local}" \
  -eu -c 'test -r /probe/primary.health_api_token; test -r /probe/secondary.health_api_token'
```

## Deploy

Deployment follows the repository flow: commit and push from a dev checkout,
then on the host `git pull --ff-only`, build, recreate and `make check-deploy`.
No Watchtower and no GitHub Actions: the image is built locally and recreated
by hand.

```bash
docker compose build health-service
docker compose up -d --wait health-service
docker compose up -d --force-recreate hermes-primary hermes-secondary
docker compose logs --since=5m health-service hermes-primary hermes-secondary
```

Recreate both Hermes services after an MCP tool-schema change so they discover
the new tools. The logs must show the cashier listening and no `health` MCP
discovery or auth error. From each Telegram bot, run one read-only health query
and confirm the `health` tools are discovered before writing real data.
User-facing Telegram text stays Russian; identifiers stay English.

Root `docker compose config --quiet` needs the filled root `.env`; on a laptop
without it, it fails on required variables such as `NEXTAUTH_SECRET`. Do not
invent secrets. The per-module renders work without it:

```bash
docker compose -f health/compose.yml config --quiet
docker compose -f wiki/compose.yml config --quiet
```

## Rollback

Image-only rollback and in-place downgrade are unsupported after MCP
tool-schema changes. On a failed deployment, stop `health-service` and both
Hermes services so they cannot write:

```bash
docker compose stop health-service hermes-primary hermes-secondary
```

The recommended default is to roll forward with a corrected Python cashier,
wiki mount, Hermes config, and skill. Do **not** switch Compose back to the
leftover Rust crate.

## Local checks

Run the cashier tests from the Python package:

```bash
cd health/mcp
python3 -m pytest
```

`hermes/scripts/check` also covers the health integration (Compose, token
reuse, skill contract). It also runs the media release preflight, so it needs
`MEDIA_RELEASE_DIR`; the sanitized `media/release.example/` is enough for
checks. Run it from `hermes/`:

```bash
cd hermes
MEDIA_RELEASE_DIR="$PWD/../media/release.example" ./scripts/check
```

`python3 -m health_mcp.ingest` (in `health/mcp`) bulk-imports exported records
through `WikiStore`; it writes jsonl directly and does not use HTTP MCP. Test it
against a temporary vault from `wiki/bootstrap-vault.sh` first.
