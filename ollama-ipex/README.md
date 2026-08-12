# Ollama IPEX-LLM

Local Intel GPU embeddings for OmniRoute. The container is not published on
Traefik. OmniRoute reaches it as `http://ollama-ipex.local:11434/v1` on the
shared `agent-tools` network and registers the `ollama-ipex` embeddings
provider from `omniroute/start.sh`.

Hindsight uses `ollama-ipex/bge-m3:latest` through OmniRoute. Do not change
the embedding model after writing memories without re-embedding.

## Validate and start

From the repository root:

```bash
docker compose config --quiet
docker compose up -d ollama-ipex
```
