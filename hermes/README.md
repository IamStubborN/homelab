# Hermes

Private, Docker-first Hermes profiles for Andrii and Valentyna. Both profiles run the unmodified official `nousresearch/hermes-agent:latest` image while keeping configuration, memory, browser identity, Telegram credentials, and media credentials isolated. Vaultwarden login automation is available only to Andrii.

The umbrella design is maintained in [`media-orchestrator`](https://github.com/IamStubborN/media-orchestrator/blob/main/docs/superpowers/specs/2026-07-10-media-orchestrator-mvp-design.md).

## Deployment Policy

Prefer manual deployment from a trusted operator workstation. This repository
must not use GitHub Actions to update the household agents. Deployments pull the
official Hermes image, synchronize the reviewed profile files and skills, and
recreate the containers through the guarded `media-orchestrator` deployment
script after confirming that no media job is active.

## Official upstream

Hermes is not rebuilt or patched by this repository. Compose pulls:

```text
nousresearch/hermes-agent:latest
```

Configuration, skills, plugins, and deterministic notifier support are mounted
into the container. Conversational media operations and Telegram callbacks use
the media-service MCP endpoint. The media CLI is a trusted-host operator tool
and is not mounted into either Hermes container. Watchtower tracks both profile
containers and replaces them when the official `latest` image changes; profile
volumes remain intact.

- [Docker runtime](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/docker.md)
- [isolated Hermes profiles](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/profiles.md)
- [Telegram gateways](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/telegram.md)
- [plugin system](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/plugins.md)

The `agent-browser-updater` service installs `agent-browser@latest` into a persistent tools volume once per day. The Vaultwarden broker discovers the latest official Bitwarden Password Manager CLI release and verifies the downloaded archive against the SHA-256 digest published in GitHub asset metadata. Hermes' built-in `bws` integration remains unused because it targets Bitwarden Secrets Manager rather than the Vaultwarden-compatible Password Manager API.

## Runtime isolation

`compose.yaml` creates:

```text
hermes-andrii             media-notifier-andrii
hermes-valentyna          media-notifier-valentyna
agent-browser-updater     vaultwarden-broker-andrii
```

The Hermes containers share the official image but not state or credentials. Each has its own profile, config, SOUL, personal skills, memory, browser metadata, Telegram bot token, media client token, and health client token. Andrii alone has a Vaultwarden broker, login skill, and approval plugin. Profile sources are mounted read-only under `/etc/hermes-home`; the entrypoint installs shared and profile-local skills and plugins into the writable profile volume before the official bootstrap runs. Neither container receives the Docker socket.

The root filesystem is read-only. `/run` is the only executable tmpfs because s6-overlay stages its init binary there; `/tmp` remains `noexec`. All Linux capabilities are dropped except the official bootstrap requirements. Hermes runs as UID/GID `10000:10000`. Before privileges are dropped, the entrypoint copies only the media, health, and browser-broker client tokens into a private `0400` runtime directory owned by that user. The copies live only in `/run` and disappear with the container. The health token is not exported to the Hermes process environment: the config merger reads that private file without logging it, writes its bearer-bearing staging config atomically as `0600`, and the entrypoint installs the persisted gateway config as `0640`.

Both profiles discover the internal streamable-HTTP `health` MCP server at `health-service:8080/internal/mcp` through the external `health-internal` network. Each profile uses its own bearer token and owner default, while an explicitly named spouse may override that default. Hermes reuses the exact ignored token files owned by the embedded `health` stack; the health service must be available for first MCP discovery. The shared health skill specifies Russian user-facing text and native clarification choices, but these repository checks assert the skill contract rather than live Telegram behavior. Live Telegram acceptance and MCP discovery remain part of Task 14 after the service and credentials are available. Deployment remains the guarded manual flow.

The media service maps each MCP token server-side to its fixed owner. No
model-supplied owner field is accepted. The standalone `hermes-media` wrapper
remains available for trusted host operators, supplies its token from a private
file, clears caller-provided configuration, rejects identity and token flags,
and forces JSON output.

The Andrii Vaultwarden session is isolated by secret scoping and network segmentation, not by file permissions: `andrii_vaultwarden_session` is mounted only into `vaultwarden-broker-andrii`, never into a Hermes container. The broker joins Andrii's private network for approval operations and the external `rezka-credentials` network for media runner credential resolution. `hermes-valentyna` has no Vaultwarden broker, session secret, server configuration, or login skill. The Hermes-facing `vaultwarden-safe` client can return status, sync state, up to five item summaries, usernames, and URIs; passwords, notes, TOTP values, and complete item JSON never cross the Hermes boundary.

## Operator CLI artifact

Hermes does not mount or execute the media CLI. Trusted host recovery commands
may use the standalone release binary placed at:

```text
artifacts/media-0.1.0-linux-amd64
```

## Media administration MCP

Both Hermes profiles discover the same internal `media_admin` MCP server at
`media-service:8080/internal/mcp`. The endpoint is protected by the profile's
existing media API token, so media-service applies the same owner isolation as
the regular CLI wrapper: Andrii and Valentyna cannot see or control each
other's jobs or tracking subscriptions.

The MCP surface is discovered dynamically, without a profile-specific tool
allowlist. Both Hermes profiles can use every tool published by media-service;
owner isolation, audit identity, and explicit destructive confirmations remain
server-enforced safety properties. The surface covers user-owned jobs, the complete tracking lifecycle,
provider search and continuation, exact result selection, release schedules,
weekly trends, recovery alternatives, explicit episode mapping, shared Plex
library reads, qBittorrent visibility and controls, diagnostics within
configured media roots, Plex refresh, and application-level dependency health.
Provider credentials remain in media-service and Docker is never exposed.
Destructive actions are previewed first, short-lived, single-use, owner-bound,
and revalidated before execution. Files are quarantined rather than permanently
deleted.

Hermes registers this MCP server lazily from its persisted schema cache. After
one successful connection, an ordinary Hermes restart can therefore retain the
tool catalog while media-service is temporarily unavailable. A new profile
volume has no cache: its first boot requires media-service to be reachable.

Before recreating Hermes, run `./scripts/deploy-preflight`. It regenerates the
runtime `tools/list` snapshot from the sibling media-orchestrator checkout and
fails closed when the checked-in schema artifact differs. Use
`python3 scripts/check-media-capabilities --sync` intentionally when the MCP
contract changes, review both generated artifacts, and rerun the preflight.

The preflight verifies this mounted artifact before containers are recreated.
No Hermes image build is required.

## Configuration

1. Replace `config/vaultwarden-server` with the HTTPS URL of the Vaultwarden deployment.
2. Create `.env` from `.env.example` and set the numeric Telegram user/chat IDs and media network name.
3. Create each untracked file under `secrets/` from its `.example` counterpart, including `andrii.vaultwarden_session`, `andrii.rezka_broker_token`, and the shared `search_ladder.api_key`; keep ownership with deployment UID/GID `1000`, and use mode `0640`. The root bootstrap reads these mounted files and creates private, ephemeral runtime copies only for secrets needed after dropping to the image's unprivileged Hermes UID/GID `10000`.
4. Ensure the external media, `agent-tools`, and `rezka-credentials` networks exist, then run `docker compose pull` and `docker compose up -d`.

No provider API key or real Telegram/Vaultwarden/media secret is committed. Hermes model credentials can be initialized later in each profile volume through the normal official setup flow.

## Web research skill

The shared `web-research` skill uses the authenticated homelab adaptive research
pipeline first: `Tavily → Exa → SearXNG`, cached Firecrawl extraction, bounded
exact excerpts, and Spark Low escalation only when needed. Both profiles receive
the same broker credential as a read-only Docker secret copied to their private
ephemeral runtime directory. The client has a fixed internal endpoint and emits
no credential. Hermes falls back once to native `web_search`; native
`web_extract` is reserved for explicit raw-page needs or insufficient evidence.

## Media skill

The shared skill uses only the owner-scoped `media_admin` MCP server for
conversational media operations. Its toolset covers search and continuation,
exact result selection, jobs and queue state, release schedules, weekly trends,
the complete tracking lifecycle, recovery alternatives, episode mapping, Plex,
qBittorrent, and scoped filesystem diagnostics. It never invokes
`hermes-media`, `curl`, Docker, or a direct provider API.

Telegram prioritizes the read-only `/media` dashboard and four direct shortcuts
in its slash-command menu. The dashboard uses inline navigation for active Plex
sessions, recently added media, Plex library counts, storage capacity, downloads,
tracking, and trends. `/watching`
shows active Plex sessions, `/movies` and `/series` show category-specific weekly
TMDB trends, and `/trending` shows the combined weekly list.
The commands call the same authenticated MCP tools as natural-language media
requests and never start a search or download by themselves.

Rezka and Prowlarr are searched together by default and their results are shown
in one provider-labelled list. Natural-language requests such as `show more`
continue the selected provider page. The user must explicitly select one exact
result and any required translation, season, or episode before Hermes creates a
job; there is no silent provider fallback after selection.

Job status uses the stable job ID, while queue status reports the queued count,
active work, and durable runner availability (`ready`, `rotating`, or `blocked`)
with a sanitized blocking reason. Release lookup uses TVmaze for episode counts
and dates without creating a job or subscription. Tracking requires an explicit
personal or family scope and defaults to notification-only mode. When the user
explicitly requests automatic downloading, Hermes pins an exact Rezka title,
translation, and season; the scheduler then creates one episode job without an
LLM call whenever a new episode appears. Prowlarr tracking remains
notification-only and never becomes an implicit fallback.

If a required MCP tool is not discovered, the skill reports that the
corresponding media-service phase is not deployed. It never substitutes a CLI,
Docker access, or another transport.

## Andrii Vaultwarden login

Only Andrii receives the `vaultwarden-login` personal skill. It uses these redacted commands:

```sh
vaultwarden-safe login-request URL
vaultwarden-safe login-status ID
vaultwarden-safe login-approve ID
vaultwarden-safe login-deny ID
```

`login-request` accepts only an HTTPS URL from the reviewed allowlist. `login-approve` is escalated by the Andrii-only Hermes plugin to the native Telegram approval control and is bound to the exact request ID. Every request needs a fresh approval and expires after two minutes. A denial, expiration, MFA, CAPTCHA, passkey, redirect, or cross-origin form action fails closed. Terminal status retains the redacted outcome, and the broker writes redacted JSONL audit events to its private Vaultwarden volume.

Every non-empty allowlist entry requires `hostname` and `credential_item_id`.
After Telegram approval, Hermes invokes the `media_rezka_session_refresh` MCP
tool with the one-time request ID as `credential_request_id`. The media runner calls the existing broker
`POST /v1/command` endpoint with
`{command:"credential_resolve",argument:request_id}` and its dedicated broker
token. The credential remains inside the broker-runner boundary and is never
returned through MCP, Telegram, the model, or logs. The generic agent-browser
Vaultwarden provider instead calls `browser_credential_resolve` with
`/run/secrets/media_api_token`. Both commands consume the same approved request
permanently, and neither token can authorize the other command.

Routine Rezka downloader authentication does not use this approval flow.
`media-service` renews its cookie session automatically from private credential
files mounted only into that service. The approval flow remains available for
explicit browser login and operator recovery, not normal media searches or
downloads.

The broker `/health` endpoint is a fast process liveness check. Use the authenticated `vaultwarden-safe status` command for Vaultwarden readiness and session state; a slow or locked remote vault must not create a container restart loop.

Initialize or rotate only Andrii's session from the Docker host with `./scripts/init-andrii-vaultwarden`. The helper prompts through `bw`, writes the session directly to the untracked Docker secret, and never prints the session key.

## Notifications

Media notifications no longer pass through Hermes. Each profile has a separate `media-notifier` container on internal port `8644`; the port is not published on the Docker host. It validates the existing timestamped HMAC envelope, sends or edits the Telegram lifecycle card directly through Bot API, persists message IDs and presentation state in its own volume, and never invokes an LLM.

One movie, episode, or season owns one Telegram card. Progress and lifecycle changes edit that message. `Details` and `Back` switch the same message between compact and detailed views, and the selected view survives notifier restarts. A successful job adds one short completion reply after the card reaches its terminal state. Cancellation uses a same-message confirmation before Hermes sends the business command to `media-service`.

Hermes forwards only presentation commands to its matching notifier:

```text
hermes-andrii    -> http://media-notifier-andrii:8644/control/card
hermes-valentyna -> http://media-notifier-valentyna:8644/control/card
```

The control request reuses the profile's webhook HMAC secret and includes the Telegram message ID. Unknown cards, mismatched message IDs, stale timestamps, invalid signatures, and replayed request IDs fail closed. Hermes cannot address the other profile's notifier through configuration.

The media dispatcher chooses recipients: initiator scope sends one event to the initiating profile; family scope sends the same event to both profile endpoints. Use the upstream generic HMAC V2 headers:

```text
X-Webhook-Timestamp: <unix-seconds>
X-Webhook-Signature-V2: HMAC-SHA256(<timestamp>.<raw-body>)
X-Request-ID: <stable-delivery-id>
```

The notifier enforces a five-minute signature window, rejects oversized or malformed payloads, persists card revisions, view state, control receipts, and final-push receipts, and deduplicates legacy deliveries. If a presentation control fails, verify `/health`, the profile-specific `MEDIA_NOTIFIER_CONTROL_URL`, and the matching `webhook_hmac` mount. Roll back by reverting the deployment commit and recreating only the two Hermes and two notifier services; media-service, download-runner, Gluetun, and qBittorrent do not need a restart.

If the notifier loses the Telegram response after issuing a send, it keeps the
delivery fail-closed because Telegram has no idempotency key or API for looking
up a sent message by the notifier request ID. Resolve that state only after
checking the correct profile's Telegram chat. The operator resolution is a
trusted assertion; the notifier cannot independently verify it. Use `retry`
only after confirming that the message is absent, because retrying a message
that Telegram accepted can create a duplicate:

```sh
./scripts/reconcile-media-delivery \
  --profile andrii --kind card --delivery-id media-job:<job-uuid> \
  --resolution retry
```

Use `delivered` only after confirming the message is present in that profile's
chat. Card reconciliation requires the actual Telegram message ID and whether
the message is a photo card; source and push reconciliation use their upstream
request or receipt key as the delivery ID:

```sh
./scripts/reconcile-media-delivery \
  --profile andrii --kind card --delivery-id media-job:<job-uuid> \
  --resolution delivered --message-id 12345 --has-photo
```

The helper signs `/control/delivery` with the selected profile's webhook HMAC,
runs the request inside only that profile's notifier container, and uses a fresh
request ID so timestamp, profile isolation, and replay protection remain active.

## Browser isolation

The official image includes Playwright Chromium and the profile configs enable the officially supported local Docker browser path. Browser output uses agent-browser content boundary markers, and a separate `browser_auth` volume is reserved per profile. The Andrii broker cannot read browser profiles or cookie files. Rezka authentication is owned by the media orchestrator and does not use Hermes browser automation.

Hermes documents durable login persistence only for Camofox when an external Camofox server maps the stable profile `userId` to a persistent browser profile. This repository does not deploy Camofox, so `browser.camofox.managed_persistence` remains disabled. Local Chromium tasks work in Docker, but their login state is not claimed to survive restarts.

## Verification

```sh
./scripts/check
```

The check covers use of the unmodified official image, Watchtower labels, profile and secret isolation, notifier HMAC/state behavior, mounted plugins and tools, Andrii-only Vaultwarden login contracts, wrapper redaction, ShellCheck, YAML lint, and rendered Compose validation.
