# Hermes

Private, Docker-first Hermes profiles for Primary and Secondary. Both profiles run the unmodified official `nousresearch/hermes-agent:stable` image with its own bootstrap while keeping configuration, memory, browser identity, Telegram credentials, and media credentials isolated. Explicit Vaultwarden browser login is available only to Primary.

The umbrella design lives in the private `media-orchestrator` repository.

## Deployment Policy

Prefer manual deployment from a trusted operator workstation. This repository
must not use GitHub Actions to update the household agents. The agents use the
official Hermes image; deployment synchronizes reviewed profile files and
skills and recreates only the affected consumers.

The live profile files are ignored: `HERMES_PRIMARY_PROFILE_DIR` and
`HERMES_SECONDARY_PROFILE_DIR` in the root `.env` point at
`private-profiles/<profile>/`, and the containers mount `config/config.yaml`,
`SOUL.md`, `identity` and (Primary) `plugins/vaultwarden-approval` from there.
The tracked `profiles/<profile>/` files are sanitized templates and the Compose
fallback; changing them on the host affects nothing that runs.

For a profile configuration change, including a model switch, edit the file in
`private-profiles/<profile>/` on the Docker host and recreate only that agent:

```bash
docker compose up -d --force-recreate hermes-primary   # or hermes-secondary
```

Recreating interrupts a reply in progress; check that no media job is waiting on
the agent first.

For shared media skills, MCP schema, or CLI artifact changes, use the guarded
`media-orchestrator` deployment script after confirming that no media job is
active. It checks the release bundle against the live Media Service before
staging those shared artifacts. Profile configuration files are also part of
the Hermes runtime input and participate in the guarded deployment's recreate
fingerprint.

## Official upstream

Hermes is not rebuilt, patched, or wrapped by this repository. Both profiles
run `nousresearch/hermes-agent:stable` with the image's own entrypoint and
bootstrap, and Watchtower follows the tag like any other labelled service.
This is a personal bot: an update may interrupt a reply in progress, and there
is no canary, snapshot, or rollback. To go back, pin an older digest in
`compose.yaml` by hand.

`scripts/telegram-watchdog` runs from the deployment user's crontab every five
minutes. When an agent is not healthy or its Telegram gateway is not connected
on two checks in a row, it reports through the disk-watchdog's bot, and again
on recovery:

```text
*/5 * * * * /path/to/homelab/hermes/scripts/telegram-watchdog 2>&1 | /usr/bin/logger -t hermes-telegram-watchdog
```

Everything else is attached through upstream extension points:

| Mount | Purpose |
| --- | --- |
| `private-profiles/<profile>/config/config.yaml` → `/etc/hermes/config.yaml` | Managed config layer, deep-merged over the user config; `${VAR}` values resolve from the environment |
| `private-profiles/<profile>/SOUL.md` → `/opt/data/SOUL.md` | Persona |
| `private-profiles/<profile>/identity` → `/etc/hermes-home/profile-id` | Profile identity |
| `shared/skills` → `/opt/data/skills/home` | Shared skills as their own `home` category, because bundled skills already use names like `media/` |
| `shared/plugins/telegram-home` → `/opt/data/plugins/telegram-home` | Telegram adapter with the media panel |
| `private-profiles/primary/plugins/vaultwarden-approval` → `/opt/data/plugins/vaultwarden-approval` | Primary only |

Upstream does not apply `session_reset`, so both profiles enable the
community plugin `hermes-session-reset-policy`, which resets a conversation on
the first message after 1440 idle minutes. It is not mounted: it lives in each
profile volume and follows the Hermes plugin catalog, which pins a reviewed
commit and moves with Hermes. Every Media Orchestrator deployment that touches
Hermes installs it when missing, updates it, and restarts an agent whose copy
changed. To do the same by hand:

```sh
for c in hermes-primary hermes-secondary; do
  docker exec "$c" hermes plugins install hermes-session-reset-policy --no-enable --yes-deps ||
    docker exec "$c" hermes plugins update hermes-session-reset-policy
  docker restart "$c"
done
```

Profile files, skills, plugins, scripts and secrets are mounted read-only. The
profile, memory and `browser_auth` volumes and the wiki binds (`/wiki` and
`/wiki/shared`) are writable; the agent-browser tools volume is read-only.
Conversational media operations and Telegram callbacks use the media-service
MCP endpoint.
The media CLI is a trusted-host operator tool and is
not mounted into either Hermes container.

- [Docker runtime](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/docker.md)
- [isolated Hermes profiles](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/profiles.md)
- [Telegram gateways](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/telegram.md)
- [plugin system](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/plugins.md)

The `agent-browser-updater` service installs `agent-browser@latest` into a persistent tools volume once per day. The Vaultwarden broker discovers the latest official Bitwarden Password Manager CLI release and verifies the downloaded archive against the SHA-256 digest published in GitHub asset metadata. Hermes' built-in `bws` integration remains unused because it targets Bitwarden Secrets Manager rather than the Vaultwarden-compatible Password Manager API.

## Runtime isolation

`compose.yaml` creates:

```text
hermes-primary             media-notifier-primary
hermes-secondary          media-notifier-secondary
agent-browser-updater     vaultwarden-broker-primary
```

The Hermes containers share the official image but not state or credentials. Each has its own profile volume, managed config, SOUL, memory, browser metadata, Telegram bot token, media client token, and health client token. Primary alone has a Vaultwarden broker and approval plugin. Profile sources are mounted read-only straight into the upstream locations listed above; nothing is copied into the profile volume. Neither container receives the Docker socket.

The root filesystem is read-only. Two tmpfs mounts are executable: `/run`, because s6-overlay stages its init binary there, and `/opt/data/tmp`, the terminal tool's `TMPDIR`, which keeps its environment snapshots (tokens included) off the profile volume. `/tmp` is `noexec`. All Linux capabilities are dropped except the official bootstrap requirements. Hermes runs as UID/GID `10000:10000`.

Secrets reach Hermes through the upstream command secret source. Each profile's
user config (`/opt/data/config.yaml` in the volume, not the managed layer,
which upstream does not read for this key) holds:

```yaml
secrets:
  command:
    enabled: true
    override_existing: true
    command: 'for f in /run/secrets/*; do v=$(cat "$f") || exit 1; printf "%s=%s\n" "$(basename "$f" | tr a-z A-Z)" "$v"; done'
```

At start every mounted `/run/secrets/<name>` becomes the environment variable
`<NAME>`, and the managed config refers to them as `${HEALTH_API_TOKEN}` and
so on. Values never land in `config.yaml` or `.env`. `override_existing` wins
over the `API_SERVER_KEY` that the bootstrap generates into `.env`, so the
webhook HMAC secret is mounted as `api_server_key`. The scripts read their
tokens straight from `/run/secrets`, and the Primary approval plugin blocks
terminal commands that touch that directory. An unreadable file fails the
whole command instead of exporting an empty value.

The secrets are not hidden from the agent's own terminal: it runs as the same
UID and can read the mounted files, and upstream strips only the names it knows
(`TELEGRAM_BOT_TOKEN` and other adapter or provider keys) from child processes.
The boundary is the container, not the environment.

Both profiles discover the internal streamable-HTTP `health` MCP server at `health-service:8080/internal/mcp` through the external `health-internal` network. Each profile uses its own bearer token and owner default, while an explicitly named spouse may override that default. Hermes reuses the exact ignored token files owned by the embedded `health` stack; the health service must be available for first MCP discovery. The shared health skill specifies Russian user-facing text and native clarification choices; the repository checks assert the skill contract, not live Telegram behavior.

The media service maps each MCP token server-side to its fixed owner. No
model-supplied owner field is accepted. The standalone `hermes-media` wrapper
remains available for trusted host operators, supplies its token from a private
file, clears caller-provided configuration, rejects identity and token flags,
and forces JSON output.

The Primary Vaultwarden session is isolated by secret scoping and network segmentation, not by file permissions: `primary_vaultwarden_session` is mounted only into `vaultwarden-broker-primary`, never into a Hermes container. The broker joins only Primary's private network and serves the generic metadata and approved browser-credential interfaces. `hermes-secondary` has no Vaultwarden broker, session secret, server configuration, or login skill. The Hermes-facing `vaultwarden-safe` client can return status, sync state, up to five item summaries, usernames, and URIs; passwords, notes, TOTP values, and complete item JSON never cross the Hermes boundary.

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
the regular CLI wrapper: Primary and Secondary cannot see or control each
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

Before recreating Hermes, copy a real private export to the ignored
`media/release/` directory and run `MEDIA_RELEASE_DIR=/absolute/path/to/media/release
./scripts/deploy-preflight`. The preflight validates all four release files and
fails closed when the checked-in schema artifact differs. Use
`MEDIA_RELEASE_DIR=/absolute/path/to/media/release python3
scripts/check-media-capabilities --sync` intentionally when the MCP contract
changes, review both generated artifacts, and rerun the preflight. The tracked
`media/release.example/` bundle is sanitized test data and cannot be deployed.
When a private guarded rollout stages the CLI, it passes
`--staged-cli /absolute/path/to/media`; preflight then hashes that regular file
and compares it with the digest in the bundle's authenticated
`media-linux-amd64.sha256` file before activation.

The private guarded deployment takes explicit `HOMELAB_ROOT` and
`MEDIA_RELEASE_DIR` paths and does not discover sibling checkouts. Registry
login and real published image digests are operator steps; export, preflight
and this repository perform no registry login, publishing or deployment.

The preflight verifies this mounted artifact before containers are recreated.
No Hermes image build is required.

## Configuration

1. Keep the Vaultwarden server URL and login allowlist in ignored local files. Set `HERMES_VAULTWARDEN_SERVER_PATH` and `HERMES_VAULTWARDEN_ALLOWLIST_PATH` to those files. The tracked `config/*.example*` files are synthetic.
2. Set the Hermes variables in the root `.env` (template: root `.env.example`): the numeric Telegram user/chat IDs, media network name, private profile directories, secret paths, wiki paths and named volume names. With existing named volumes, set `HERMES_EXISTING_VOLUMES=true` so Compose reuses them; that also covers the rebuildable tool caches `homelab_agent_browser_tools` and `homelab_vaultwarden_tools`, which a new host creates first with `docker volume create`.
3. Create the ignored secret files. Their names and default paths are the `secrets:` entries in `compose.yaml`; the per-profile `HERMES_*_PATH` variables can point them elsewhere. Keep ownership with deployment UID/GID `1000`. Compose ignores `uid`, `gid`, and `mode` for file secrets, so files mounted into Hermes must be mode `0644` for UID `10000` to read them (the bootstrap drops supplementary groups, so `group_add` does not help); the `0750` directory still keeps other host users out.
4. The external networks `media-internal` (`MEDIA_NETWORK`) and `health-internal` must exist; Compose creates `agent-tools` and the per-profile private networks. Then run `docker compose pull` and `docker compose up -d` from the checkout root.
5. Once per profile volume, add the `secrets:` block above to `/opt/data/config.yaml`, then install the optional dependencies the configs use and restart the profile:

   ```sh
   docker exec -u 10000 -e HERMES_HOME=/opt/data hermes-primary \
     hermes pm install --extra exa --extra edge-tts --extra ddgs
   docker restart hermes-primary
   ```

   The package manager keeps them as a generation in `/opt/data/installs` (about 1.9 GB per profile) and the bootstrap re-resolves it after an image update. Runtime lazy installs stay disabled.

No provider API key or real Telegram/Vaultwarden/media secret is committed. Hermes model credentials can be initialized later in each profile volume through the normal official setup flow.

## Web search

Both profiles use native Hermes web backends: Exa for search and extract.
API keys are shared Docker secrets.

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

## Primary Vaultwarden login

Only Primary's profile has the generic Vaultwarden browser-credential boundary.
Use these redacted commands when an explicitly reviewed website needs a login:

```sh
vaultwarden-safe login-request URL
vaultwarden-safe login-status ID
vaultwarden-safe login-approve ID
vaultwarden-safe login-deny ID
```

`login-request` accepts only an HTTPS URL from the reviewed allowlist. `login-approve` is escalated by the Primary-only Hermes plugin to the native Telegram approval control and is bound to the exact request ID. Every request needs a fresh approval and expires after two minutes. A denial, expiration, MFA, CAPTCHA, passkey, redirect, or cross-origin form action fails closed. Terminal status retains the redacted outcome, and the broker writes redacted JSONL audit events to its private Vaultwarden volume.

Every non-empty allowlist entry requires `hostname` and `credential_item_id`.
The generic agent-browser Vaultwarden provider calls
`browser_credential_resolve` with the dedicated broker token. Credentials stay
inside the broker and are never returned through MCP, Telegram, the model, or
logs. The committed allowlist is intentionally empty until a low-risk host is
reviewed and added explicitly.

The broker `/health` endpoint is a fast process liveness check. Use the authenticated `vaultwarden-safe status` command for Vaultwarden readiness and session state; a slow or locked remote vault must not create a container restart loop.

Initialize or rotate only Primary's session from the Docker host with `hermes/scripts/init-primary-vaultwarden`. The helper prompts through `bw`, writes the session directly to the ignored Docker secret, and never prints the session key. It does not read `.env`: export the matching root `.env` values first, or it falls back to the synthetic server example and default volume name:

```sh
export HERMES_VAULTWARDEN_SERVER_PATH=<value from .env>
export VAULTWARDEN_VOLUME=<HERMES_PRIMARY_VAULTWARDEN_VOLUME from .env>
hermes/scripts/init-primary-vaultwarden
```

`VAULTWARDEN_SESSION_FILE` is a path inside the helper container under `/run/hermes-home-secrets/` (the host `hermes/secrets/`); set it only when `HERMES_PRIMARY_VAULTWARDEN_SESSION_PATH` names a different file in that directory.

## Notifications

Media notifications do not pass through Hermes. Each profile has a separate `media-notifier` container on internal port `8644`; the port is not published on the Docker host. It validates the existing timestamped HMAC envelope, sends or edits the Telegram lifecycle card directly through Bot API, persists message IDs and presentation state in its own volume, and never invokes an LLM.

One movie, episode, or season owns one Telegram card. Progress and lifecycle changes edit that message. `Details` and `Back` switch the same message between compact and detailed views, and the selected view survives notifier restarts. A successful job adds one short completion reply after the card reaches its terminal state. Cancellation uses a same-message confirmation before Hermes sends the business command to `media-service`.

Hermes forwards only presentation commands to its matching notifier:

```text
hermes-primary    -> http://media-notifier-primary:8644/control/card
hermes-secondary -> http://media-notifier-secondary:8644/control/card
```

The control request reuses the profile's webhook HMAC secret and includes the Telegram message ID. Unknown cards, mismatched message IDs, stale timestamps, invalid signatures, and replayed request IDs fail closed. Hermes cannot address the other profile's notifier through configuration.

The media dispatcher chooses recipients: initiator scope sends one event to the initiating profile; family scope sends the same event to both profile endpoints. Use the upstream generic HMAC V2 headers:

```text
X-Webhook-Timestamp: <unix-seconds>
X-Webhook-Signature-V2: HMAC-SHA256(<timestamp>.<raw-body>)
X-Request-ID: <stable-delivery-id>
```

The notifier enforces a five-minute signature window, rejects oversized or malformed payloads, persists card revisions, view state, control receipts, and final-push receipts, and deduplicates legacy deliveries. If a presentation control fails, verify `/health`, the profile-specific `MEDIA_NOTIFIER_CONTROL_URL`, and the matching webhook HMAC mount (`api_server_key` in Hermes, `webhook_hmac` in the notifier). Roll back by reverting the deployment commit and recreating only the two Hermes and two notifier services; media-service, download-runner, Gluetun, and qBittorrent do not need a restart.

If the notifier loses the Telegram response after issuing a send, it keeps the
delivery fail-closed because Telegram has no idempotency key or API for looking
up a sent message by the notifier request ID. Resolve that state only after
checking the correct profile's Telegram chat. The operator resolution is a
trusted assertion; the notifier cannot independently verify it. Use `retry`
only after confirming that the message is absent, because retrying a message
that Telegram accepted can create a duplicate:

```sh
./scripts/reconcile-media-delivery \
  --profile primary --kind card --delivery-id media-job:<job-uuid> \
  --resolution retry
```

Use `delivered` only after confirming the message is present in that profile's
chat. Card reconciliation requires the actual Telegram message ID and whether
the message is a photo card; source and push reconciliation use their upstream
request or receipt key as the delivery ID:

```sh
./scripts/reconcile-media-delivery \
  --profile primary --kind card --delivery-id media-job:<job-uuid> \
  --resolution delivered --message-id 12345 --has-photo
```

The helper signs `/control/delivery` with the selected profile's webhook HMAC,
runs the request inside only that profile's notifier container, and uses a fresh
request ID so timestamp, profile isolation, and replay protection remain active.

## Browser isolation

The official image includes Playwright Chromium and the profile configs enable the officially supported local Docker browser path. Browser output uses agent-browser content boundary markers, and a separate `browser_auth` volume is reserved per profile. The Primary broker cannot read browser profiles or cookie files. Rezka uses anonymous media-orchestrator sessions and does not use Hermes browser automation.

Hermes documents durable login persistence only for Camofox when an external Camofox server maps the stable profile `userId` to a persistent browser profile. This repository does not deploy Camofox, so `browser.camofox.managed_persistence` remains disabled. Local Chromium tasks work in Docker, but their login state is not claimed to survive restarts.

## Verification

```sh
cd hermes
MEDIA_RELEASE_DIR="$PWD/../media/release.example" ./scripts/check
```

`MEDIA_RELEASE_DIR` is required because the check runs `deploy-preflight`; the
sanitized example bundle is enough for checks, a real export for deployment.

The check covers use of the unmodified official stable image under
Watchtower, profile and secret isolation, notifier HMAC/state
behavior, mounted plugins and tools, Primary-only Vaultwarden login contracts,
wrapper redaction, ShellCheck, YAML lint, and rendered Compose validation.
