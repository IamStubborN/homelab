# Cursorpipe

OpenAI-compatible proxy in front of the official Cursor Python SDK. OmniRoute
and other internal clients call it as a custom OpenAI provider. It is not
published on Traefik.

- Internal URL: `http://cursorpipe:8080/v1`
- OmniRoute prefix: `cursorpipe` (models such as `cursorpipe/composer-2.5`)
- Auth: bearer token from `CURSORPIPE_BEARER_TOKEN`
- Upstream: `CURSOR_API_KEY` from the Cursor dashboard Integrations page

The container joins the shared `agent-tools` network. Do not expose port 8080
on the host.

## Runtime secrets

Generate the gateway token in the ignored root `.env` and paste the Cursor key
from https://cursor.com/dashboard/integrations:

```bash
CURSORPIPE_BEARER_TOKEN=$(openssl rand -hex 32)
CURSOR_API_KEY=crsr_replace-me
```

OmniRoute receives the same `CURSORPIPE_BEARER_TOKEN` and registers the
upstream on startup via `omniroute/start.sh`.

## Validate and start

From the repository root:

```bash
docker compose config --quiet
docker compose pull cursorpipe
docker compose up -d cursorpipe omniroute
```

Direct check from another `agent-tools` container:

```bash
docker compose exec omniroute node -e "fetch('http://cursorpipe:8080/health').then(r=>r.text()).then(console.log)"
```

Chat through OmniRoute after the provider is active:

```text
model: cursorpipe/composer-2.5
base:  http://omniroute:20129/v1
```
