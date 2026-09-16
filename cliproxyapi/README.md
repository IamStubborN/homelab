# CLIProxyAPI

OpenAI-compatible gateway (`eceasy/cli-proxy-api`) for household LLM clients.

## Client URL

| Client | Base URL |
| --- | --- |
| LAN / Traefik | `https://cliproxy.${DOCKER_DOMAIN}/v1` |
| Hermes / Karakeep (Docker DNS) | `http://cli-proxy-api:8317/v1` |
| Home Assistant (`network_mode: host`) | `http://127.0.0.1:8317/v1` |

Authenticate with the shared client key in `hermes/secrets/cliproxy_api_key` (also listed under `api-keys` in `config.yaml`). Traefik does not replace client api-key auth.

## First-time setup

```bash
cp cliproxyapi/config.example.yaml cliproxyapi/config.yaml
# edit api-keys[0], then:
printf '%s' 'SAME_KEY' > hermes/secrets/cliproxy_api_key
chmod 0640 hermes/secrets/cliproxy_api_key
chmod 0600 cliproxyapi/config.yaml
```

## OAuth (Codex + xAI)

Binary flags use a **single** leading dash (`-no-browser`, `-codex-login`, `-xai-login`).

### Codex (localhost callback on port 1455)

From your laptop, open an SSH tunnel, then run login on the Docker host:

```bash
# Laptop (keep this session open):
ssh -L 1455:127.0.0.1:1455 docker.example.invalid

# Docker host:
cd /srv/homelab
docker compose exec cli-proxy-api /CLIProxyAPI/CLIProxyAPI -no-browser -codex-login
```

Open the printed `https://auth.openai.com/...` URL in the laptop browser. Ignore any `root@public-ip` tunnel example the binary prints — use the `host-5.example.invalid...` tunnel above.

### xAI / Grok (device-code flow)

Current image uses device authorization (no localhost callback required):

```bash
cd /srv/homelab
docker compose exec cli-proxy-api /CLIProxyAPI/CLIProxyAPI -no-browser -xai-login
```

Open the printed `https://accounts.x.ai/oauth2/device?...` URL and enter the shown user code. Port `56121` remains published for older callback-based builds.

Tokens land in `cliproxyapi/auths/` (gitignored).


## Control Center (Management API)

UI: `https://cliproxy.${DOCKER_DOMAIN}/management.html`

Management API base: `/v0/management` (same Traefik host; router is host-wide, not `/v1`-only).

1. Generate a management secret: `openssl rand -hex 32`
2. Store it in `hermes/secrets/cliproxy_management_key` (gitignored) and set the same plaintext under `remote-management.secret-key` in `config.yaml`.
3. Keep `remote-management.allow-remote: true` so Traefik/LAN access works (localhost alone is not enough behind the proxy hostname).
4. Paste the **plaintext** key into «Ключ управления» (not the bcrypt hash written back into `config.yaml` after startup).

```bash
MGMT=$(tr -d '\n' < hermes/secrets/cliproxy_management_key)
# without key → 401/403; with key → non-404
curl -sS -o /dev/null -w '%{http_code}\n' "https://cliproxy.${DOCKER_DOMAIN}/v0/management/config"
curl -fsS -H "Authorization: Bearer $MGMT" "https://cliproxy.${DOCKER_DOMAIN}/v0/management/config" | head
```

## Verify

```bash
KEY=$(tr -d '\n' < hermes/secrets/cliproxy_api_key)
curl -fsS -H "Authorization: Bearer $KEY" http://127.0.0.1:8317/v1/models
# via Traefik:
curl -fsS -H "Authorization: Bearer $KEY" "https://cliproxy.${DOCKER_DOMAIN}/v1/models"
```

After successful OAuth, the models list should include Codex/`gpt-5.6-luna` and Grok models.
