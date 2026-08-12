# OmniRoute

Household LLM gateway. Dashboard is public on Traefik; the OpenAI-compatible
API binds on `127.0.0.1:20129` and on the shared `agent-tools` network.

- Dashboard: `https://omniroute.${DOCKER_DOMAIN}`
- Internal API: `http://omniroute:20129/v1`
- Redis: private `omniroute-backend` network only
- Startup patch: `omniroute/start.sh` (NVIDIA rerank URL, Gemini embeddings
  fix, Ollama IPEX and Cursorpipe provider registration)

Hermes, Hindsight, KaraKeep, Search Ladder, and Home Assistant call this
service. Cursorpipe and Ollama IPEX are separate Compose modules on
`agent-tools`.

## Runtime secrets

Set these in the ignored root `.env`:

```bash
OMNIROUTE_JWT_SECRET
OMNIROUTE_API_KEY_SECRET
OMNIROUTE_STORAGE_ENCRYPTION_KEY
OMNIROUTE_INITIAL_PASSWORD
CURSORPIPE_BEARER_TOKEN
```

## Validate and start

From the repository root:

```bash
docker compose config --quiet
docker compose up -d omniroute-redis omniroute
```

The startup wrapper starts the official server first so it can create and
migrate a fresh database, then registers the internal providers idempotently.
Run the clean-volume regression test before changing that order:

```bash
omniroute/test-empty-volume.sh
```
