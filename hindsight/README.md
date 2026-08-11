# Hindsight

Shared memory server for Pi clients.

- API and built-in MCP: `https://hindsight.${DOCKER_DOMAIN}`
- LLM: `gpt-5.6-luna` through the internal CLIProxy service
- Embeddings: `gemini-embedding-001`
- Reranking: RRF (no extra model)
- Storage: PostgreSQL 17 with pgvector
- Authentication: bearer token from `HINDSIGHT_API_TOKEN`

The Control Plane port is not exposed. PostgreSQL is reachable only on the
internal Compose network. Do not change the embedding provider/model after
writing memories without re-embedding or recreating the database.

## Runtime secrets

Generate unique hex values in the ignored root `.env`:

```bash
HINDSIGHT_DB_PASSWORD=$(openssl rand -hex 32)
HINDSIGHT_API_TOKEN=$(openssl rand -hex 32)
CLIPROXY_HINDSIGHT_KEY=$(openssl rand -hex 32)
```

Add `CLIPROXY_HINDSIGHT_KEY` to the ignored
`web-research/cliproxy/config.yaml` `api-keys` list, then restart CLIProxy.

## Validate and start

From the repository root:

```bash
docker compose config --quiet
docker compose pull hindsight hindsight-db
docker compose up -d hindsight-db hindsight
curl -fsS -H "Authorization: Bearer $HINDSIGHT_API_TOKEN" \
  "https://hindsight.${DOCKER_DOMAIN}/health"
```

## Backup

```bash
hindsight/backup-db.sh
```

The script writes a PostgreSQL custom-format dump under the ignored
`backups/` directory. Copy that dump off-host.

Restore is destructive. Stop the API and restore only after confirming the
target database:

```bash
docker compose stop hindsight
docker exec -i hindsight-db pg_restore --clean --if-exists \
  -U hindsight -d hindsight < backups/hindsight-YYYYMMDD-HHMMSS.dump
docker compose up -d hindsight
```
