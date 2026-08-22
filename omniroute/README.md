# OmniRoute

Household LLM gateway. Dashboard is public on Traefik; the OpenAI-compatible
API binds on `127.0.0.1:20129` and on the shared `agent-tools` network.

- Dashboard: `https://omniroute.${DOCKER_DOMAIN}`
- Internal API: `http://omniroute:20129/v1`
- Redis: private `omniroute-backend` network only
- Startup patch: `omniroute/start.sh` (NVIDIA rerank URL, Gemini embeddings
  fix)

Hermes, KaraKeep, Search Ladder, and Home Assistant call this service.

## Runtime secrets

Set these in the ignored root `.env`:

```bash
OMNIROUTE_JWT_SECRET
OMNIROUTE_API_KEY_SECRET
OMNIROUTE_STORAGE_ENCRYPTION_KEY
OMNIROUTE_INITIAL_PASSWORD
```

## Validate and start

From the repository root:

```bash
docker compose config --quiet
docker compose up -d omniroute-redis omniroute
```

Run the clean-volume regression test after changing startup:

```bash
omniroute/test-empty-volume.sh
```
