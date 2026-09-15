# CLIProxyAPI

OpenAI-compatible gateway (`eceasy/cli-proxy-api`) for household LLM clients.

## Client URL

| Client | Base URL |
| --- | --- |
| Hermes / Karakeep (Docker DNS) | `http://cli-proxy-api:8317/v1` |
| Home Assistant (`network_mode: host`) | `http://127.0.0.1:8317/v1` |

Authenticate with the shared client key in `hermes/secrets/cliproxy_api_key` (also listed under `api-keys` in `config.yaml`).

## First-time setup

```bash
cp cliproxyapi/config.example.yaml cliproxyapi/config.yaml
# edit api-keys[0], then:
printf '%s' 'SAME_KEY' > hermes/secrets/cliproxy_api_key
chmod 0640 hermes/secrets/cliproxy_api_key cliproxyapi/config.yaml
```

## OAuth (Codex + xAI)

From the Docker host, with SSH tunnels from your laptop for the callback ports:

```bash
# Laptop:
ssh -L 1455:127.0.0.1:1455 \
    -L 54545:127.0.0.1:54545 \
    -L 51121:127.0.0.1:51121 \
    -L 56121:127.0.0.1:56121 \
    docker.example.invalid

# Docker host:
cd /srv/homelab
docker compose exec cli-proxy-api /CLIProxyAPI/CLIProxyAPI --no-browser --codex-login
docker compose exec cli-proxy-api /CLIProxyAPI/CLIProxyAPI --no-browser --xai-login
```

Open the printed URL in a browser on the laptop (tunnel must be up). Tokens land in `cliproxyapi/auths/` (gitignored).

## Verify

```bash
KEY=$(tr -d '\n' < hermes/secrets/cliproxy_api_key)
curl -fsS -H "Authorization: Bearer $KEY" http://127.0.0.1:8317/v1/models
```
