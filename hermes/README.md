# Hermes

Private, Docker-first Hermes profiles for Primary and Secondary. Both profiles run the unmodified official `nousresearch/hermes-agent` image pinned by repository digest while keeping configuration, memory, browser identity, Telegram credentials, and media credentials isolated. Explicit Vaultwarden browser login is available only to Primary.

The umbrella design is maintained in [`media-orchestrator`](https://github.com/IamStubborN/media-orchestrator/blob/main/docs/superpowers/specs/2026-07-10-media-orchestrator-mvp-design.md).

## Deployment Policy

Prefer manual deployment from a trusted operator workstation. This repository
must not use GitHub Actions to update the household agents. The agents use the
official Hermes image; deployment synchronizes reviewed profile files and
skills and recreates only the affected consumers.

For a profile configuration change only, including a model switch, use the
profile-only deployment command from `media-orchestrator`. It copies the
profile YAML from the selected local Homelab checkout, leaves the pinned
official Hermes image and Media Service untouched, and recreates only the
Hermes agents. It checks for active media jobs, waits for both agents to become
healthy, verifies the mounted configs, and restores the previous configs if
deployment fails:

```bash
cd /path/to/media-orchestrator
HOMELAB_ROOT=/opt/homelab ./scripts/homelab.sh deploy-hermes-profiles
```

For shared media skills, MCP schema, or CLI artifact changes, use the guarded
`media-orchestrator` deployment script after confirming that no media job is
active. It checks the release bundle against the live Media Service before
staging those shared artifacts. Profile configuration files are also part of
the Hermes runtime input and participate in the guarded deployment's recreate
fingerprint.

## Official upstream

Hermes is not rebuilt or patched by this repository. Compose pulls
`${HERMES_IMAGE}` from the deployment's ignored root `.env` and falls back to
the reviewed pin:

```text
nousresearch/hermes-agent@sha256:efb82540aeb8ac21c58ecb4482bd3eb103ea617da2af2c61f12526ed68f6c2d9
```

Configuration, skills, plugins, and deterministic notifier support are mounted
into the container. Conversational media operations and Telegram callbacks use
the media-service MCP endpoint. The media CLI is a trusted-host operator tool
and is not mounted into either Hermes container. Watchtower is explicitly
disabled for both profile containers; their image changes only through the
guarded nightly update documented under [Automatic image updates](#automatic-image-updates)
or a manual digest change.

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

The Hermes containers share the official image but not state or credentials. Each has its own profile, config, SOUL, personal skills, memory, browser metadata, Telegram bot token, media client token, and health client token. Primary alone has a Vaultwarden broker and approval plugin. Profile sources are mounted read-only under `/etc/hermes-home`; the entrypoint installs shared and profile-local skills and plugins into the writable profile volume before the official bootstrap runs. Neither container receives the Docker socket.

Hermes services are excluded from Watchtower and always run an exact digest.
Image upgrades, including ones that raise the config schema, are automatic only
through `scripts/hermes-auto-update`: it runs the official bootstrap of the
candidate in disposable canaries, snapshots both profiles' volumes, requires
both agents to become healthy without migration backups or persisted runtime
secrets, and otherwise restores the previous image and data. A schema change is
applied by the image's own migration, and syncing the managed profile
`_config_version` and options in this repository is a follow-up that the update
announces. Image-only rollback and in-place downgrade after a database or MCP
contract change remain unsupported; roll back with the update's volume snapshot
or follow the fail-closed incident guidance in the health runbook.

Every start removes upstream migration backups (`config.yaml.bak-*`,
`config.yaml.corrupt.*.bak`, `.env.bak-*`) from the profile volume, because the
active config links to the bearer-bearing runtime file. The entrypoint runs the
image's boot migration (`docker_config_migrate.py`) itself, against a copy of
the sanitized base in a private tmpfs home, stores the migrated sanitized base,
rebuilds the runtime config from it and sets `HERMES_SKIP_CONFIG_MIGRATION=1`
for the upstream stage2 hook. The config merger keeps a newer
`_config_version` than the managed profile, so the migration runs once per
schema change rather than on every restart.

The root filesystem is read-only. `/run` is the only executable tmpfs because s6-overlay stages its init binary there; `/tmp` remains `noexec`. All Linux capabilities are dropped except the official bootstrap requirements. Hermes runs as UID/GID `10000:10000`. Before privileges are dropped, the entrypoint copies only the media, health, and browser-broker client tokens into a private `0400` runtime directory owned by that user. The copies live only in `/run` and disappear with the container. The health token is not exported to the Hermes process environment. The config merger keeps a sanitized persistent base at `/opt/data/config.base.yaml`, writes the bearer-bearing active config as `0600` on `/run` tmpfs, and leaves only a symlink at `/opt/data/config.yaml`. Container restarts rematerialize the runtime file; generation failures remove temporary/runtime outputs, so named-volume files and snapshots do not retain the bearer.

Both profiles discover the internal streamable-HTTP `health` MCP server at `health-service:8080/internal/mcp` through the external `health-internal` network. Each profile uses its own bearer token and owner default, while an explicitly named spouse may override that default. Hermes reuses the exact ignored token files owned by the embedded `health` stack; the health service must be available for first MCP discovery. The shared health skill specifies Russian user-facing text and native clarification choices, but these repository checks assert the skill contract rather than live Telegram behavior. Live Telegram acceptance and MCP discovery remain part of Task 14 after the service and credentials are available. Deployment remains the guarded manual flow.

Stable retry identity is live-deferred until the Hermes Telegram gateway is
verified to expose a source update/message identifier to the skill context. If
available, the skill derives a per-fact identity from that stable transport ID
plus a deterministic fact ordinal; it never passes the raw message ID or
invents `source_event_id`. Without it, only exact event-time deduplication
applies. The skill's preflight for a user-intended verbatim repeat is likewise
a contract assertion pending live Telegram acceptance in Task 14; it queries
recent full values and skips the write only for an exact match with no new time
or context.

The media service maps each MCP token server-side to its fixed owner. No
model-supplied owner field is accepted. The standalone `hermes-media` wrapper
remains available for trusted host operators, supplies its token from a private
file, clears caller-provided configuration, rejects identity and token flags,
and forces JSON output.

The Primary Vaultwarden session is isolated by secret scoping and network segmentation, not by file permissions: `primary_vaultwarden_session` is mounted only into `vaultwarden-broker-primary`, never into a Hermes container. The broker joins only Primary's private network and serves the generic metadata and approved browser-credential interfaces. `hermes-secondary` has no Vaultwarden broker, session secret, server configuration, or login skill. The Hermes-facing `vaultwarden-safe` client can return status, sync state, up to five item summaries, usernames, and URIs; passwords, notes, TOTP values, and complete item JSON never cross the Hermes boundary.

## Automatic image updates

`hermes-auto-update.timer` runs `scripts/hermes-auto-update` as root on the
Docker host at 02:30 `Europe/Sofia`: before the Lampac update (03:00), the image
retention observation (03:55) and Watchtower (04:00). It tracks the upstream
`stable` tag (`HERMES_UPDATE_TAG` overrides it) and:

1. finishes what an interrupted run left, right away through the unit's
   `ExecStopPost` (`RECOVER_ONLY=1`) or on the next night: a run killed during
   the snapshot only restarts the agents; one killed during apply is completed
   when both agents already run the candidate healthy and clean, and otherwise
   rolled back without marking the digest failed. An interrupted apply older
   than 12 hours, a failed rollback, unhealthy agents or agents on different
   images stop it with a Telegram alert;
2. asks Docker Hub for the tag's digest without pulling and does nothing when
   it is the running one or one that already failed here;
3. refuses, alerting once per reason, while a running agent's Compose
   config-hash differs from the current root Compose model, so unreviewed
   edits are never deployed by the update;
4. pulls the candidate and runs, per profile, a disposable canary: the
   candidate image with the repository entrypoint and read-only profile/script
   mounts, `--network none`, synthetic secrets, a copy of the live sanitized
   config base, `.env` and package directories, and no wiki. The official
   bootstrap and config migration must finish, the migrated schema must reach
   the image's latest version, and the canary data must hold no migration
   backup and no synthetic secret. Only such a verdict marks the digest failed;
   a failed pull, a canary timeout or a Docker error (exit 125–127) is retried
   the next night;
5. waits until both gateways report `active_agents: 0` in
   `gateway_state.json` for 3 consecutive minutes (a reply in progress counts;
   a user typing does not). The wait ends 20 minutes after the canaries and, for
   a run started before 03:30, at 03:30; a busy night is retried the next night
   and the third in a row is reported;
6. stops both agents and snapshots their read-write volumes (profile, memory,
   browser) without `tmp/`, `.cache/` and `home/.cache/`, refusing above 6 GiB
   or without twice that space free;
7. writes `HERMES_IMAGE=<candidate>` to the root `.env`, keeping its other
   lines, mode and owner, and recreates only `hermes-primary` and
   `hermes-secondary` with `--no-deps --no-build --pull never`;
8. requires both to become healthy and connected to Telegram (as written by
   the gateway of this container start) within 7 minutes, with no restart at
   all, and then scans each
   profile volume (except `tmp/`, a tmpfs that holds the terminal tool's
   environment snapshots and never reaches the disk) for migration backups and
   for the content of every mounted `/run/secrets/*` file.

On success the previous image is tagged `homelab/hermes-agent:rollback` so the
nightly `docker image prune` keeps it, and only the 3 newest generations stay
under `/var/lib/hermes-update`. A raised config schema is announced once in
Russian with the old and new version, for example «Hermes обновлён со сменой
схемы конфигурации 41→42: синхронизируй управляемый конфиг в репозитории». Any
failure after the snapshot stops the agents, moves the candidate-era volume
contents to `<generation>/displaced/`, restores the snapshot (live caches are
moved back), restores the previous `HERMES_IMAGE` value, recreates both agents
and reports the outcome. A failed digest is not retried until upstream moves
on or `failed_digest` is removed from `/var/lib/hermes-update/state.json`. A
failed rollback leaves `phase` set and blocks later runs until checked. Any
unexpected error is reported with its phase. A Docker or host error during
apply rolls back without marking the digest failed. A SIGTERM (the 2-hour
`TimeoutStartSec`, a shutdown) turns into a rollback, which
`TimeoutStopSec=30min` leaves time to finish. A restore refuses to run while an
agent is still running. The wiki bind mount is not part of
the snapshot, so a candidate's wiki writes survive a rollback; conversations
held between apply and rollback stay only in `displaced/`.

Reports go to the disk-watchdog's Telegram bot and chat. The state directory is
root-owned `0700`, outside Git, and holds private data: snapshots include the
profiles' persistent credentials. It must share a filesystem with the Docker
volumes. `DRY_RUN=1` only reports whether an update is due and whether the
agents are idle; it writes nothing. `CANARY_ONLY=1` pulls the candidate and
runs the canaries, then stops before touching the agents.

Install as root on the Docker host after deploying this checkout:

```sh
cd /home/iamstubborn/homelab/hermes
DRY_RUN=1 python3 scripts/hermes-auto-update
CANARY_ONLY=1 python3 scripts/hermes-auto-update
install -m 0644 hermes-auto-update.service hermes-auto-update.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now hermes-auto-update.timer
```

The guarded media-orchestrator deployment uses the same root `.env`, so it keeps
the selected digest. Removing the `HERMES_IMAGE` line returns to the reviewed
pin only while the config schema is unchanged; after a schema migration that is
an in-place downgrade, which is unsupported: restore the update's snapshot
instead.

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

Private guarded deployment requires explicit `HOMELAB_ROOT` and
`MEDIA_RELEASE_DIR` paths; it does not discover sibling checkouts. Promotion is
still blocked until the operator logs in to the private registry and supplies
real published image digests. Export, preflight, and this repository perform no
registry login, publishing, or deployment.

The preflight verifies this mounted artifact before containers are recreated.
No Hermes image build is required.

## Configuration

1. Keep the Vaultwarden server URL and login allowlist in ignored local files. Set `HERMES_VAULTWARDEN_SERVER_PATH` and `HERMES_VAULTWARDEN_ALLOWLIST_PATH` to those files. The tracked `.example` files are synthetic.
2. Create `.env` from `.env.example` and set the numeric Telegram user/chat IDs, media network name, private profile paths, and existing named volume names. During an existing deployment cutover, set `HERMES_EXISTING_VOLUMES=true` so Compose reuses those volumes.
3. Create each untracked file under `secrets/` from its `.example` counterpart, including `primary.vaultwarden_session`, `primary.vaultwarden_broker_token`, and the shared `tavily_api_key` and `exa_api_key`; keep ownership with deployment UID/GID `1000`, and use mode `0640`. The root bootstrap reads these mounted files and creates private, ephemeral runtime copies only for secrets needed after dropping to the image's unprivileged Hermes UID/GID `10000`.
4. Ensure the external media and `agent-tools` networks exist, then run `docker compose pull` and `docker compose up -d`.

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

Initialize or rotate only Primary's session from the Docker host with `./scripts/init-primary-vaultwarden`. The helper prompts through `bw`, writes the session directly to the untracked Docker secret, and never prints the session key.

## Notifications

Media notifications no longer pass through Hermes. Each profile has a separate `media-notifier` container on internal port `8644`; the port is not published on the Docker host. It validates the existing timestamped HMAC envelope, sends or edits the Telegram lifecycle card directly through Bot API, persists message IDs and presentation state in its own volume, and never invokes an LLM.

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
./scripts/check
```

The check covers use of the digest-pinned unmodified official image, the guarded
auto-update, config-migration backup cleanup, disabled
Hermes Watchtower updates, profile and secret isolation, notifier HMAC/state
behavior, mounted plugins and tools, Primary-only Vaultwarden login contracts,
wrapper redaction, ShellCheck, YAML lint, and rendered Compose validation.
