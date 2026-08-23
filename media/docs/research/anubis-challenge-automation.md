# Automating Anubis Challenges for the Rezka Client

Research date: 2026-08-23

## Findings

Anubis presents a challenge when the request looks browser-like and issues a
signed `techaro.lol-anubis-auth` cookie after a successful solve. The cookie is
bound to challenge metadata and expires after one week. See the upstream
description in [How Anubis works](https://github.com/TecharoHQ/anubis/blob/main/docs/docs/design/how-anubis-works.mdx).

For the `fast` proof-of-work method, a client can solve the challenge without a
browser: parse the JSON in `#anubis_challenge`, find a decimal nonce for which
`SHA-256(randomData + nonce)` has the required leading zero nibbles, then call
`/.within.website/x/cmd/anubis/api/pass-challenge` with `id`, `response`,
`nonce`, `redir`, and `elapsedTime`. The upstream browser implementation shows
the same request sequence in [main.ts](https://github.com/TecharoHQ/anubis/blob/main/web/js/main.ts).

This is already demonstrated in a Rezka-specific Go client: [go-hdrezka's
Anubis implementation](https://github.com/n0madic/go-hdrezka/blob/master/anubis.go)
keeps one HTTP client and cookie jar, solves the proof of work, submits the
pass request, and retries the original page.

## Practical options

1. **Native solver in media-orchestrator (recommended).** Add an Anubis-aware
   HTTP transport around the Rezka client. Persist the Anubis cookie alongside
   the encrypted Rezka session, keep the same VPN egress IP and User-Agent for
   challenge, pass request, and subsequent title/stream requests, and detect
   `#anubis_challenge` before parsing a page as a Rezka title. Handle unknown
   algorithms and excessive difficulty as explicit provider errors.

2. **Native solver with browser fallback.** Use the native path for `fast`
   challenges and fall back to Chromium/Playwright for `preact`, `metarefresh`,
   future algorithms, or rejected solutions. The community
   [anubis-fetch](https://github.com/fzakaria/anubis-fetch) project documents
   this pattern and reports roughly 0.6 seconds for the native path versus
   roughly 2 seconds with a browser fallback.

3. **Dedicated challenge sidecar.** A small Go or Rust sidecar can own the
   cookie jar and return a solved session to the downloader. This keeps
   browser/runtime dependencies out of `download-runner`, but it must share the
   Rezka VPN network namespace and must never rotate the VPN between solving and
   the first authenticated request.

## Important limitations

- Changing the VPN IP alone does not solve Anubis. The challenge must be solved
  and its cookie retained; Anubis can also apply IP/request-metadata checks.
- FlareSolverr is documented as a Cloudflare/DDoS-GUARD solver, not an Anubis
  integration. It should not be assumed to solve the direct Rezka path.
- The client must not parse a challenge HTML document as a Rezka title. Doing
  so can produce misleading provider/parser errors such as duplicate
  translation identities.
- Automation should be used only where the site and account terms permit it;
  solving the challenge does not grant permission to bypass other access or
  rate limits.

## Recommendation for this homelab

Implement option 2: a native `fast` solver in the Rezka HTTP client with a
headless-browser fallback. Keep all traffic inside `gluetun-rezka`, persist the
Anubis cookie in the existing encrypted session volume, add a challenge
detector before the Rezka parser, and expose a distinct `AnubisChallenge`
provider error. Do not route this through the existing FlareSolverr service.

