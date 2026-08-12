# Family Health stack

The `health` stack builds `family-health-service:local` from the Rust workspace
in `health/service` and runs it with a dedicated PostgreSQL database. Both
containers join the external attachable `health-internal` network so the Hermes
stack can join it independently. The homelab repository is the canonical source
for both the service and its deployment; no separate `family-health` checkout is
required.

Create the external network and database volume once on a new Docker host,
before the first `up`:

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
docker volume create health-pg-data
```

An existing network with either check set to `false` is an operator blocker.
Do not recreate it automatically: first inspect attached containers and plan a
maintenance window.

On the Linux Docker host, generate each value once in a private temporary file,
then install copies with the ownership required by each consumer. The two
database files intentionally contain the same value: PostgreSQL reads its
root-owned bootstrap copy, while `health-service` reads the UID 10001 copy.
Neither copy is group- or world-readable.

```bash
mkdir -p health/secrets
secret_tmp=$(mktemp -d)
chmod 0700 "$secret_tmp"
openssl rand -hex 32 > "$secret_tmp/database-password"
openssl rand -hex 32 > "$secret_tmp/andrii-token"
openssl rand -hex 32 > "$secret_tmp/valentyna-token"
sudo install -o root -g root -m 0400 "$secret_tmp/database-password" health/secrets/health_pg_bootstrap_password
sudo install -o 10001 -g 10001 -m 0400 "$secret_tmp/database-password" health/secrets/health_service_db_password
sudo install -o 10001 -g 10001 -m 0400 "$secret_tmp/andrii-token" health/secrets/andrii.health_api_token
sudo install -o 10001 -g 10001 -m 0400 "$secret_tmp/valentyna-token" health/secrets/valentyna.health_api_token
rm -f "$secret_tmp/database-password" "$secret_tmp/andrii-token" "$secret_tmp/valentyna-token"
rmdir "$secret_tmp"
stat -c '%u:%g %a %n' health/secrets/*
```

The expected modes are `0:0 400` for `health_pg_bootstrap_password` and
`10001:10001 400` for the service database copy and both API tokens. On macOS,
Docker Desktop does not reproduce Linux bind-mount ownership faithfully; use
the Linux ownership probe below before deploying to the homelab host.

From the repository root, validate the canonical Compose project and build the
image before running the ownership probe:

```bash
docker compose config --quiet
docker compose build health-service
```

```bash
docker run --rm \
  -v "$PWD/health/secrets:/probe:ro" \
  --entrypoint /bin/sh \
  family-health-service:local \
  -eu -c 'test -r /probe/health_service_db_password; test -r /probe/andrii.health_api_token; test -r /probe/valentyna.health_api_token; ! test -r /probe/health_pg_bootstrap_password'
```

Before the first real medical record, create a manual dump and prove that it
restores. The ignored `health/backups/` directory is local staging only; the
automated Drive backup remains a future phase.

```bash
set -eu
umask 077
install -d -m 0700 health/backups
docker compose up -d health-postgres
docker compose up --wait health-postgres
backup=$(mktemp "health/backups/health-$(date -u +%Y%m%dT%H%M%SZ).dump.XXXXXX")
verify_db="health_restore_verify_$(date -u +%Y%m%d%H%M%S)_$$"
verify_db_created=false
cleanup_restore_verify() {
  if [ "$verify_db_created" = true ]; then
    docker compose exec -T health-postgres dropdb -U health "$verify_db"
  fi
}
trap cleanup_restore_verify EXIT HUP INT TERM
docker compose exec -T health-postgres pg_dump -U health -d health --format=custom > "$backup"
chmod 0600 "$backup"
test -s "$backup"
docker compose exec -T health-postgres createdb -U health "$verify_db"
verify_db_created=true
docker compose exec -T health-postgres pg_restore -U health -d "$verify_db" --exit-on-error < "$backup"
test "$(docker compose exec -T health-postgres psql -U health -d "$verify_db" -v ON_ERROR_STOP=1 -tAc "SELECT count(*) = 2 FROM people")" = t
test "$(docker compose exec -T health-postgres psql -U health -d "$verify_db" -v ON_ERROR_STOP=1 -tAc "SELECT to_regclass('public.audit_log') IS NOT NULL")" = t
docker compose exec -T health-postgres dropdb -U health "$verify_db"
verify_db_created=false
trap - EXIT HUP INT TERM
```

Deploy from the repository root so the health and embedded Hermes services use
one Compose project. Capture a rollback tag before replacing an existing local
image, start health first, wait for both health checks, then recreate both
Hermes services so their entrypoint installs the current config and skill:

```bash
previous_health_image=$(docker image inspect family-health-service:local --format '{{.Id}}' 2>/dev/null || true)
if [ -n "$previous_health_image" ]; then
  docker tag "$previous_health_image" family-health-service:rollback
fi
docker compose build health-service
docker compose up -d health-postgres health-service
docker compose up --wait health-postgres health-service
docker compose up -d --force-recreate hermes-andrii hermes-valentyna
docker compose ps health-postgres health-service hermes-andrii hermes-valentyna
docker compose logs --since=5m health-service hermes-andrii hermes-valentyna
```

The logs must show applied migrations and no `health` MCP discovery/auth error.
From each Telegram bot, run one read-only health query and confirm that the
`health` tools are discovered before writing real data. If rollback is needed,
retag `family-health-service:rollback` as `family-health-service:local`, recreate
`health-service`, wait for health, and then recreate both Hermes services again.

For isolated maintenance, retain the root project name explicitly:

```bash
docker compose -p homelab -f health/compose.yml config --quiet
docker compose -p homelab -f health/compose.yml build health-service
docker compose -p homelab -f health/compose.yml up -d
```

Run service-local checks from the embedded workspace:

```bash
cd health/service
mise install
mise run format
mise run check
mise run lint
mise run test
mise run test-integration
mise run audit
```

Phase 1 core is implemented locally: the Rust service includes the PostgreSQL
schema, token-to-profile authentication, typed MCP write/read operations,
deduplication (explicit stable source event IDs when the transport exposes
them, otherwise exact clinical event timestamps only),
append-only measurement corrections, audit records, validation, and PNG
measurement charts. Remote homelab deployment and Telegram acceptance
remain operational verification steps; later document/Drive sync, reminders,
NotebookLM, reporting, and diet phases are not implemented here.

Known deferred design discrepancy: the umbrella design describes additional
audit provenance fields for source, event date, and entry date, while the Phase
1 schema records actor, transport, target, action, entity, result, and old/new
values. Adding that provenance requires a later schema and contract decision;
this final-fix round intentionally does not invent or migrate those fields.

The `health-pg-data` volume is external and has the explicit engine name
`health-pg-data`, so both root and child workflows resolve the same persistent
state even if an operator accidentally omits `-p homelab`. Routine
`docker compose down` and `docker compose down -v` do not delete an external
volume.

Deleting the database is a separate, destructive operator action. Take and
verify a backup, stop the stack, and only then run the explicit command below
if permanent data loss is intended:

```bash
# DANGER: permanently deletes the Family Health PostgreSQL database.
docker volume rm health-pg-data
```

The application receives only secret file paths. No database password or API
token is interpolated into Compose environment values.
