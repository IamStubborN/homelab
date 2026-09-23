# CLIProxyAPI

OpenAI-compatible gateway (`eceasy/cli-proxy-api`) for household LLM clients.

## Client URL

| Client | Base URL |
| --- | --- |
| LAN / Traefik | `https://cliproxy.${DOCKER_DOMAIN}/v1` |
| Hermes / Karakeep (Docker DNS) | `http://cli-proxy-api:8317/v1` |
| Home Assistant (`network_mode: host`) | `http://127.0.0.1:8317/v1` |

Authenticate with the shared client key in `hermes/secrets/cliproxy_api_key` (also listed under `api-keys` in `config.yaml`). Traefik does not replace client api-key auth.

### Which key belongs to which client

The gateway's **client** key (who may call the gateway) and the **upstream** OpenCode Go keys
listed in the `openai-compatibility` block are different credentials — do not mix them up:

| Path | Credential | Stored in |
| --- | --- | --- |
| Karakeep / HA → gateway | gateway client key | `api-keys` in `config.yaml`, `hermes/secrets/cliproxy_api_key` |
| gateway → OpenCode Go | Go key named `cliproxy` in the console | `openai-compatibility` in `config.yaml`, sops `OPENCODE_GO_API_KEY` |
| pi agent → OpenCode Go (direct) | Go key named `pi` | `~/.pi/agent/auth.json` |
| OpenCode CLI → OpenCode Go (direct) | Go key named `opencode-cli` | `~/.local/share/opencode/auth.json` |

One key per client, so rotating one does not touch the others. When rotating an upstream
Go key, update the `openai-compatibility` block **and** sops `OPENCODE_GO_API_KEY`, then
`docker compose restart cli-proxy-api`.

## First-time setup

```bash
cp cliproxyapi/config.example.yaml cliproxyapi/config.yaml
# edit api-keys[0], then:
printf '%s' 'SAME_KEY' > hermes/secrets/cliproxy_api_key
chmod 0640 hermes/secrets/cliproxy_api_key
chmod 0600 cliproxyapi/config.yaml
```

## OAuth (Codex)

Binary flags use a **single** leading dash (`-no-browser`, `-codex-login`).

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

## OpenCode Go (third-party models)

The `openai-compatibility` entry named `opencode-go` in `config.yaml` adds selected
[OpenCode Go](https://opencode.ai/docs/go) models to the same `/v1` surface as the
Codex OAuth models. The gateway calls Go's `/chat/completions`, so **only models that
answer on that endpoint can be listed** (see “Adding models”). The Go key is a literal
in `config.yaml` (gitignored); on the Mac the same value lives in sops as
`OPENCODE_GO_API_KEY`.

Two things are easy to get wrong:

- `headers: x-opencode-session: "$session-id"` — the `$NAME` form copies a header from
the downstream request. OpenCode Go rejects requests without a session header
(`400 MissingSessionID`), and Codex sends it as `session-id` (**dash**, not underscore).
Remove that line and every Go model starts failing.
- **Any client of these models must send `session-id` itself.** The gateway only relays
it; it does not invent one, so a request without that header gets
`400 MissingSessionID` back from OpenCode Go. Codex CLI/desktop does send it; plain
`curl` (or a client that doesn't) has to add `-H 'session-id: <stable-id>'`.
- An alias must not collide with a native model. Check the current Codex model
list before adding or renaming any Go aliases.

Model names and context windows mirror `~/.cache/opencode/models.json` (the OpenCode
CLI's cache).

> Codex on the Mac is **not** wired to this gateway: its `model_provider` and
> `model_catalog_json` were rolled back, so Codex talks to OpenAI directly again. The
> Go models above are reachable only by clients that call this gateway themselves.

### Adding models

Probe the upstream first — the live `/models` list contains entries that are not
actually served:

```bash
go_key=$(python3 -c "import yaml;print(yaml.safe_load(open('cliproxyapi/config.yaml'))['openai-compatibility'][0]['api-key-entries'][0]['api-key'])")
curl -s -o /dev/null -w '%{http_code}\n' https://opencode.ai/zen/go/v1/chat/completions \
  -H "Authorization: Bearer $go_key" -H 'Content-Type: application/json' \
  -H 'x-opencode-session: probe' \
  -d '{"model":"glm-5.3","messages":[{"role":"user","content":"hi"}],"max_tokens":8}'
```

`200` means it can be added. Known failures: `Model is unavailable` (listed but not
served), `403 DataPolicyError` (muse-spark models need an explicit opt-in in the
OpenCode console), and `not supported for format oa-compat` (Responses-only models
such as `grok-4.6`). Add a working model to the `models:` list in `config.yaml` and
`docker compose restart cli-proxy-api`.

## Control Center (Management API)

UI: `https://cliproxy.${DOCKER_DOMAIN}/management.html` (LAN only).
Management API base: `/v0/management` on the same Traefik host.

> ⚠️ **Do not paste management API output anywhere.** Some endpoints return the
> upstream credentials **in plaintext** — `GET /v0/management/api-key-usage` (and
> `/v0/management/config`) embed the provider API keys as part of the JSON. Anyone
> with the management key plus network access can read every upstream key, so the
> management key must be treated as a secret that unlocks all of them. If you need to
> show someone a response, mask `sk-…` values first.
>
> To close the surface off (it stays reachable over the LAN, which is deliberate for
> the Control Center), append to the Traefik rule in `compose.yml`:
> `&& !PathPrefix(`/v0/management`) && !PathPrefix(`/management.html`)
> and recreate the container. Keep `remote-management.allow-remote: true` either way:
> the container sees the Docker gateway as the peer, so `allow-remote: false` answers
> `403` even through an SSH tunnel to `127.0.0.1:8317`.

1. Generate a management secret: `openssl rand -hex 32`
2. Store it in `hermes/secrets/cliproxy_management_key` (gitignored) and set the same plaintext under `remote-management.secret-key` in `config.yaml`.
3. Paste the **plaintext** key into «Ключ управления» (not the bcrypt hash written back into `config.yaml` after startup).

```bash
MGMT=$(tr -d '\n' < hermes/secrets/cliproxy_management_key)
# without key → 401/403; with key → non-404
curl -sS -o /dev/null -w '%{http_code}\n' "https://cliproxy.${DOCKER_DOMAIN}/v0/management/config"
curl -fsS -H "Authorization: Bearer $MGMT" "https://cliproxy.${DOCKER_DOMAIN}/v0/management/config" | sed -E 's/sk-[A-Za-z0-9]+/<KEY>/g' | head
```

## Verify

```bash
KEY=$(tr -d '\n' < hermes/secrets/cliproxy_api_key)
curl -fsS -H "Authorization: Bearer $KEY" http://127.0.0.1:8317/v1/models
# via Traefik:
curl -fsS -H "Authorization: Bearer $KEY" "https://cliproxy.${DOCKER_DOMAIN}/v1/models"
```

After successful OAuth, the models list should include Codex/`gpt-6-luna`.
