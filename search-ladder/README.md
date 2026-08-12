# Search Ladder

Authenticated adaptive research broker used by the Hermes `web-research`
skill. It calls OmniRoute for search, fetch, rerank, and Spark Medium
summaries.

- Public health: `https://search-ladder.${DOCKER_DOMAIN}/healthz`
- Internal API: `http://search-ladder:8080` on `agent-tools`

## Runtime secrets

Set these in the ignored root `.env`:

```bash
SEARCH_LADDER_OMNIROUTE_KEY
SEARCH_LADDER_API_KEY
```

`SEARCH_LADDER_OMNIROUTE_KEY` must match an OmniRoute API key named
`search-ladder`.

## Validate and start

From the repository root:

```bash
docker compose config --quiet
docker compose up -d search-ladder
```
