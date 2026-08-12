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
docker network create --attachable health-internal
docker volume create health-pg-data
```

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

Start from the repository root. This preserves the same Compose project
identity as the rest of the homelab:

```bash
docker compose up -d health-postgres health-service
docker compose ps health-postgres health-service
docker compose logs health-service
```

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
deduplication, append-only measurement corrections, audit records, validation,
and PNG measurement charts. Remote homelab deployment and Telegram acceptance
remain operational verification steps; later document/Drive sync, reminders,
NotebookLM, reporting, and diet phases are not implemented here.

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
