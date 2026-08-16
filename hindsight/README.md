# Hindsight

Shared memory server for Pi clients.

- Control Plane UI: `https://hindsight.${DOCKER_DOMAIN}`
- API and built-in MCP: internal port `8888` (proxied by the Control Plane)
- LLM: `opencode-go/gpt-5.6-luna` through OmniRoute
- Embeddings: local Ollama `bge-m3` at 1024 dimensions through OmniRoute
- Reranking: NVIDIA `nv-rerank-qa-mistral-4b:1` through OmniRoute
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
```

Hindsight uses its own internal `HINDSIGHT_OMNIROUTE_KEY`; OmniRoute stores upstream provider credentials.

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
