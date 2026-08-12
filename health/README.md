# Family Health stack

The `health` stack runs the local `family-health-service:local` image with a
dedicated PostgreSQL database. Both containers join the external attachable
`health-internal` network so the Hermes stack can join it independently.

Create the network once on a new Docker host:

```bash
docker network create --attachable health-internal
```

Create the ignored secret files without printing their contents:

```bash
mkdir -p health/secrets
openssl rand -hex 32 > health/secrets/health_pg_password
openssl rand -hex 32 > health/secrets/andrii.health_api_token
openssl rand -hex 32 > health/secrets/valentyna.health_api_token
chmod 0600 health/secrets/*
```

Build `family-health-service:local` from the family-health repository, then
validate and launch this stack from the homelab repository root:

```bash
docker compose -f health/compose.yml config --quiet
docker compose -f health/compose.yml up -d
docker compose -f health/compose.yml ps
docker compose -f health/compose.yml logs health-service
```

The application receives only secret file paths. No database password or API
token is interpolated into Compose environment values.
