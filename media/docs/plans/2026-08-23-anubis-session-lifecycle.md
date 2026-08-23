# Rezka Anonymous Session and Anubis Lifecycle

Status: implementation plan
Date: 2026-08-23
Scope: private `media-orchestrator` application and its homelab deployment

## Context

The homelab runs `media-service` and a one-shot `download-runner` behind the
dedicated `gluetun-rezka` HTTP proxy. Both application containers mount the
same external encrypted session volume:

```text
media-orchestrator_rezka_session_encrypted
  /var/lib/media-orchestrator/session/session.bin
```

`gluetun-rezka-watcher` owns the VPN lifecycle. It normally reuses the current
egress session after a runner attempt and rotates the VPN only when the runner
requests a fresh session or the egress probe fails.

Rezka login credentials are out of scope. Normal search and download must stay
anonymous. The session store is an encrypted anonymous cookie jar, not a
Rezka username/password store.

Rezka currently presents an Anubis challenge. The deployed provider client can
misinterpret the challenge HTML as a title response, producing misleading
provider/parser errors.

## Goals

- Make Anubis handling explicit and reliable for anonymous Rezka traffic.
- Reuse the anonymous cookie jar across searches, downloads, and container
  restarts.
- Re-solve only the Anubis clearance when it is rejected or no longer valid.
- Coordinate the shared session store between `media-service` and
  `download-runner`.
- Keep challenge, cookie, and provider errors distinct and actionable.
- Preserve the existing VPN lifecycle and avoid changing IP during an active
  download.
- Keep all Rezka traffic inside the dedicated Gluetun namespace.

## Non-goals

- Do not add Rezka username/password authentication.
- Do not restore or expand the Vaultwarden login flow for routine media work.
- Do not route Rezka through FlareSolverr.
- Do not rotate `session.bin` on every search, download, or IP change.
- Do not select a different provider or silently fall back after a provider
  failure.

## Session model

Implement and document four separate concepts:

1. **API search session** — an ephemeral media-service search/continuation
   context. A new user search receives a new ID.
2. **Anonymous cookie jar** — persistent encrypted cookies shared by the
   media-service and runner processes. It is reused across operations.
3. **Anubis clearance** — the `techaro.lol-anubis-auth` cookie. It is stored in
   the encrypted jar, but can be invalidated independently of other cookies.
4. **VPN lease** — the current Gluetun egress/IP lifecycle. It is reused across
   jobs until the watcher receives an explicit fresh-session request.

The implementation must not call the anonymous cookie jar a login session.

## Provider transport

Add an Anubis-aware transport around the Rezka HTTP client in the private
`media-orchestrator` repository.

### Request flow

1. Load the encrypted cookie jar under a shared lock.
2. Send the request through `MEDIA_REZKA_PROXY_URL` with a stable, explicit
   User-Agent.
3. Detect an Anubis interstitial before passing the body to the Rezka parser.
   Detection must check the challenge markers, not only HTTP status.
4. For the supported `fast` algorithm, parse the challenge JSON and solve the
   SHA-256 proof of work.
5. Submit `id`, `response`, `nonce`, `redir`, and `elapsedTime` to the
   challenge endpoint using the same client, proxy, IP, and User-Agent.
6. Persist the returned clearance cookie atomically under the shared lock.
7. Retry the original request once. Bound retries and never loop indefinitely.
8. If the algorithm is unsupported, difficulty is excessive, or the solution
   is rejected, return a typed `AnubisChallenge` error.

Use the current upstream challenge markers and endpoint shape rather than
hard-coding a single Anubis version. Keep the implementation compatible with
the Rezka-specific flow already demonstrated by `go-hdrezka`.

### Optional browser fallback

Provide a narrow fallback interface for `preact`, `metarefresh`, unknown future
algorithms, or rejected native solutions. The fallback may use Chromium or
Playwright, but it must:

- run through the same Gluetun proxy and egress IP;
- use a persistent isolated browser context only for the challenge;
- return cookies to the encrypted jar without exposing them to media-service
  API responses, logs, Telegram, or Hermes;
- be disabled by default in CI and unavailable from public network routes.

Do not use the existing FlareSolverr service for this path.

## Session store and concurrency

- Keep the existing encrypted `session.bin` location and cookie-key mechanism.
- Use an inter-process lock or equivalent single-flight mechanism for reads,
  challenge solving, and writes.
- Write a new encrypted snapshot to a temporary file, `fsync` as appropriate,
  and atomically rename it into place.
- Keep the previous snapshot until the new snapshot is fully written.
- Never log cookie names with values, JWTs, challenge payloads, or raw response
  bodies.
- Preserve unrelated anonymous cookies when replacing Anubis clearance.
- Make a corrupt or undecryptable snapshot a typed storage error; do not delete
  it automatically. Move it to a timestamped quarantine path only through an
  explicit recovery action.

## VPN/IP lifecycle

### Normal operation

- New searches and downloads reuse the current VPN lease and cookie jar.
- Runner completion with lifecycle `ready` starts the next attempt without
  rotating the VPN.
- No IP rotation is allowed during an active download.

### Explicit fresh-session request

1. Mark the runner lifecycle as `rotating` and gate new Rezka work.
2. Let the watcher rotate `gluetun-rezka` and wait for a healthy new egress.
3. Run a challenge-aware Rezka probe, not a status-only HTTP probe.
4. Keep the existing anonymous jar and try the existing Anubis cookie once.
5. If Anubis rejects it, remove only the Anubis cookie, solve a fresh challenge
   on the new IP, and persist the result.
6. Mark lifecycle `ready` and start the runner.
7. On repeated failure, mark lifecycle `blocked` and keep queued work gated.

### Unexpected IP change

If a download loses its VPN lease or the egress changes unexpectedly, fail the
attempt safely and make it retryable. Do not continue a partially authenticated
request with an unknown IP/cookie relationship.

## Health and error handling

Replace the current probe semantics with explicit outcomes:

- `RezkaReachable` — provider content was received and was not an Anubis page.
- `AnubisChallengeRequired` — challenge detected and not yet solved.
- `AnubisChallengeFailed` — solver or pass endpoint rejected the solution.
- `RezkaProviderRejected` — provider returned a real access denial after
  challenge handling.
- `RezkaParserInvalid` — a genuine provider page failed parsing.
- `SessionStoreError` — encrypted jar could not be read or written.

The watcher should treat a challenge page as not ready. Media-service should
surface a provider-specific diagnostic while keeping secrets and raw HTML out
of user-facing output.

## Tests

Add tests in the private application repository:

- deterministic proof-of-work test vectors;
- challenge HTML detection before Rezka parsing;
- pass-challenge URL construction and cookie capture;
- unsupported algorithm, high difficulty, timeout, and rejected-solution
  handling;
- encrypted jar round-trip and atomic replacement;
- concurrent media-service/runner refresh with single-flight behavior;
- reuse of the jar across two searches and two downloads;
- IP change where the existing Anubis cookie is accepted;
- IP change where the Anubis cookie is rejected and only that cookie is
  replaced;
- no IP rotation during an active download;
- watcher probe rejects challenge HTML;
- corrupt snapshot is retained and reported, not silently destroyed.

Use a local mock Anubis/Rezka server for CI. A real Rezka/VPN smoke test must be
manual and must not be required for the normal test suite.

## Deployment and rollback

1. Implement and test in `/home/operator/Projects/media-orchestrator`.
2. Build the private release contract and run its preflight checks.
3. Update the homelab release reference only to the resulting immutable image
   digest.
4. Render Compose and validate the shared volume, proxy, secrets, and watcher
   configuration.
5. Deploy only `media-postgres`, `media-service`, `gluetun-rezka`,
   `download-runner`, and `gluetun-rezka-watcher` through the guarded media
   deployment procedure.
6. Verify a search, a selected download, a runner restart, and an explicit VPN
   rotation without exposing cookies.
7. Roll back by restoring the previous immutable application image references;
   do not delete the encrypted session volume.

## Acceptance criteria

- A second search reuses the existing anonymous jar and does not invoke a new
  challenge when the clearance is valid.
- A second download reuses the jar and current VPN lease.
- A fresh IP does not force a complete `session.bin` reset.
- A rejected Anubis cookie is replaced without losing unrelated cookies.
- A challenge page never reaches the Rezka title parser.
- The watcher does not report a challenge page as healthy.
- No Rezka username, password, Vaultwarden credential, cookie value, or raw
  challenge data appears in logs or API responses.
- An active download is never intentionally interrupted by routine VPN
  rotation.
