# T2 — Python MCP HTTP sidecar (primary-source findings)

Status: scout complete (read-only except this file)  
Date: 2026-08-19  
Audience: T4 Worker (Python health cashier). Do not treat this as implemented code.

Sources checked: official MCP Python SDK docs and GitHub, PyPI JSON, the Streamable HTTP spec, this repo's Hermes + health + vaultwarden-broker wiring. APIs below are quoted from those docs, not invented.

---

## Recommendation (one paragraph)

Build the health cashier as a **Starlette ASGI app** from official `mcp==2.0.0` (`MCPServer.streamable_http_app()`), served by **uvicorn**, mounted so the MCP endpoint is exactly `POST/GET/DELETE http://health-service:8080/internal/mcp`. Do **not** use the SDK's OAuth stack. Wrap only the MCP mount in a thin Starlette Bearer middleware that matches today's Rust parser and Hermes `Authorization: Bearer <token>`. Pin the image to official `python:3.12-slim-bookworm@sha256:…`, not `python:latest`. Keep tool names unchanged; dummy sketch below is the hosting shape only.

---

## 1. Official SDK: package, version, ASGI

| Item | Value |
|---|---|
| PyPI package | `mcp` |
| Current stable | **2.0.0** (released 2026-07-28). `pip install mcp` now installs 2.x. |
| Companion wire types | `mcp-types==2.0.0` (exact pin inside `mcp`) |
| Python | `>=3.10` |
| High-level server class | `from mcp.server import MCPServer` (**not** v1 `from mcp.server.fastmcp import FastMCP`) |
| Recommended ASGI app | `mcp.streamable_http_app(...)` → **Starlette** |
| ASGI server | **uvicorn** (SDK dependency; also what `mcp.run(transport="streamable-http")` uses) |
| Transports | stdio, Streamable HTTP, SSE (SSE superseded — do not build on it) |

### Official docs

- SDK home: <https://py.sdk.modelcontextprotocol.io/>
- GitHub: <https://github.com/modelcontextprotocol/python-sdk>
- PyPI: <https://pypi.org/project/mcp/2.0.0/>
- Get started: <https://py.sdk.modelcontextprotocol.io/get-started/>
- Running / Streamable HTTP options: <https://py.sdk.modelcontextprotocol.io/run/>
- **Mounting / ASGI (copy this page):** <https://py.sdk.modelcontextprotocol.io/run/asgi/>
- Deploy, Host allowlist, workers: <https://py.sdk.modelcontextprotocol.io/run/deploy/>
- What's new in v2: <https://py.sdk.modelcontextprotocol.io/whats-new/>
- v1→v2 migration: <https://py.sdk.modelcontextprotocol.io/migration/>
- v1 maintenance docs (only if forced off 2.x): <https://py.sdk.modelcontextprotocol.io/v1/>
- Spec Streamable HTTP 2025-11-25 (sessions, GET SSE, `Mcp-Session-Id`): <https://modelcontextprotocol.io/specification/2025-11-25/basic/transports>
- Spec Streamable HTTP 2026-07-28 (POST-only modern path, no sessions): <https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http>
- Canonical mount example in SDK: <https://github.com/modelcontextprotocol/python-sdk/blob/main/examples/stories/starlette_mount/server.py>

v2 is the current stable line and **serves both protocol eras** from one `streamable_http_app()`: a 2025-era client still does `initialize` + `Mcp-Session-Id`; a 2026-era client does not. Nothing to flip. Prefer 2.0.0 over staying on 1.x.

If T4 hits a Hermes incompatibility that cannot be fixed in hosting options, the documented v1 pin is `mcp>=1.29.0,<2` (latest 1.x on PyPI today is **1.29.0**; docs example is `mcp>=1.28,<2`). That is a fallback, not the default.

Do **not** install the `cli` extra in the image (`mcp[cli]` adds `mcp dev` / Inspector). Production needs the library only.

---

## 2. Pinned packages to put in `requirements.txt` / `uv.lock`

Checked via PyPI JSON on 2026-08-19.

**Direct (pin these):**

```text
mcp==2.0.0
uvicorn==0.52.4
starlette==1.6.0
sse-starlette==3.4.8
```

**Transitive, already constrained by `mcp==2.0.0` (do not override unless T4 needs a lockfile):**

| Package | Constraint from `mcp 2.0.0` | Current PyPI (informational) |
|---|---|---|
| `mcp-types` | **exactly** `==2.0.0` | 2.0.0 |
| `starlette` | `>=0.27` (Py<3.14) | 1.6.0 |
| `uvicorn` | `>=0.31.1` | 0.52.4 |
| `sse-starlette` | `>=3.0.0` | 3.4.8 (itself wants `starlette>=0.49.1`) |
| `pydantic` | `>=2.12.0` | — |
| `anyio` | `>=4.9` (Py<3.14) | — |
| `httpx2` | `>=2.5.0` | — (v2 replaced `httpx`) |
| `python-multipart` | `>=0.0.9` | — |
| `jsonschema` | `>=4.20.0` | — |
| `pyjwt[crypto]` | `>=2.10.1` | — |
| `opentelemetry-api` | `>=1.28.0` | — |

`sse-starlette 3.4.8` requires `starlette>=0.49.1`, so do not pin an ancient Starlette just because `mcp` allows `>=0.27`.

Charts (`matplotlib`) and jsonl I/O are T4 product code, not MCP hosting. Do not add them to the sketch.

Prefer a lockfile (`uv lock` / `pip-compile`) so a rebuild cannot silently pick a new uvicorn.

---

## 3. How to serve Streamable HTTP (the APIs T4 must call)

Constructor describes **what** the server is. Transport options go on **`run()` / `streamable_http_app()`**, not `MCPServer(...)`. Passing `port=` to the constructor is a `TypeError` in v2.

Documented Streamable HTTP kwargs (from <https://py.sdk.modelcontextprotocol.io/run/>):

| Kwarg | Default | Health cashier |
|---|---|---|
| `host` | `127.0.0.1` | **Must not use the default.** Docker needs `0.0.0.0`. `host=` on `streamable_http_app()` does **not** listen; it only affects DNS-rebinding defaults. Listening is uvicorn's job. |
| `port` | `8000` | `8080` to keep `HEALTH_LISTEN_ADDR` / Hermes URL |
| `streamable_http_path` | `/mcp` | **Must change.** Hermes URL is `/internal/mcp` |
| `json_response` | `False` (SSE per POST) | **`True`** — matches current Rust `StreamableHttpServerConfig.with_json_response(true)` and the health HTTP tests that parse a JSON `tools/list` body |
| `stateless_http` | `False` | Leave **False**. This flag is legacy-only (2025-era). Hermes is a URL+headers MCP client; treat it as 2025-era until proven otherwise. One process + in-memory sessions is enough. |
| `max_request_body_size` | 4 MiB | Keep default (v2 returns HTTP 413 before parse) |
| `transport_security` | localhost allowlist auto-armed | **Must set.** See §6 |

### Mounting (required, because we need `/healthz` + Bearer + a non-default path)

From <https://py.sdk.modelcontextprotocol.io/run/asgi/>:

1. `mcp.streamable_http_app()` returns a Starlette app with one MCP route (default `/mcp`) plus a lifespan that starts `mcp.session_manager`.
2. **A mounted sub-app's lifespan never runs.** Parent Starlette **must** `async with mcp.session_manager.run()`. First request otherwise: `RuntimeError: Task group is not initialized. Make sure to use run()`.
3. Call `streamable_http_app()` at import/build time so `mcp.session_manager` exists before the lifespan uses it.
4. To make the public path the mount prefix, set `streamable_http_path="/"`.
5. `@mcp.custom_route()` handlers are **never authenticated**, even when the rest of the server is. That is the documented health-check seam. Prefer a **parent** `/healthz` instead so Bearer middleware cannot accidentally cover it.

Two equivalent path layouts; pick one and test with `POST /internal/mcp`:

```text
Mount("/internal/mcp", app=mcp.streamable_http_app(streamable_http_path="/", ...))
# or
Mount("/internal", app=mcp.streamable_http_app(streamable_http_path="/mcp", ...))
```

Do **not** `mcp.run(transport="streamable-http")` in Compose: it binds 127.0.0.1:8000 `/mcp` with no Bearer and no `/healthz`.

---

## 4. Hermes contract this sidecar must keep

From `hermes/profiles/andrii/config/config.yaml` (Valentyna is identical except the token file):

```yaml
mcp_servers:
  health:
    url: ${HEALTH_MCP_URL}
    lazy: true
    headers:
      Authorization: "Bearer ${HEALTH_API_TOKEN_FILE}"
    tools:
      resources: false
      prompts: false
```

Compose (`hermes/compose.yaml`):

```text
HEALTH_MCP_URL: http://health-service:8080/internal/mcp
```

`hermes/scripts/merge_hermes_config.py` rewrites that placeholder to `Authorization: Bearer <token>` from the mounted secret file. The wire header Hermes will send is therefore exactly:

```http
Authorization: Bearer <token-bytes>
```

No OAuth. No `WWW-Authenticate` dance. Token charset already enforced on the Hermes side: visible ASCII `0x21–0x7E`, non-empty, max 512 chars (same rules as Rust `health-service` `auth.rs`).

Keep:

- Container name `health-service`
- Path `/internal/mcp`
- Unauthenticated `GET /healthz` → `200` body `ok` (Rust tests and Docker healthcheck)
- Two secret files: `HEALTH_TOKEN_FILE_ANDRII`, `HEALTH_TOKEN_FILE_VALENTYNA`
- Token → `(actor, via, default_person)` as in current `TokenMap`

Tool **names** stay: `add_measurement`, `correct_measurement`, `add_meal`, `add_symptom`, `add_sleep_record`, `add_medication`, `stop_medication`, `add_condition`, `add_allergy`, `add_lab_result`, `query_health_data`, `generate_chart`. The sketch uses one dummy tool only.

---

## 5. Auth: do not use the SDK OAuth path

Official SDK auth is **OAuth 2.1** (`AuthSettings`, `TokenVerifier`, `RequireAuthMiddleware`, protected-resource metadata, `WWW-Authenticate`). That is the wrong shape for Hermes. A `StaticTokenVerifier` sample still requires `issuer_url` / `resource_server_url` and emits OAuth errors.

**Do not** pass `auth=` / `token_verifier=` to `MCPServer` for this service.

**Do** put a thin Starlette/ASGI middleware **around the MCP mount only**, same idea as today's Axum `authenticate` in `health/service/crates/health-service/src/mcp.rs`:

- Require a single `Authorization` header
- Scheme `Bearer` (case-insensitive)
- Token: non-empty, ≤512 bytes, bytes in `0x21..=0x7E`
- Constant-time compare against the two file-backed tokens (`hmac.compare_digest`)
- Unknown / missing / duplicate headers / `Basic` → **401** body `unauthorized`, never echo the secret
- On success, stash identity on `request.state` (or a `ContextVar`). Tools must **not** re-parse `Authorization`.

SDK `Context.headers` is documented as client-supplied and **must not** be treated as identity (`ctx.headers` docstring at <https://py.sdk.modelcontextprotocol.io/api/mcp/server/mcpserver/context/>). Identity is whatever the middleware already verified.

`@mcp.custom_route("/healthz")` would also skip auth, but a parent route is clearer: middleware never sees `/healthz`.

---

## 6. Image pin (homelab strategy)

### What this repo actually does today

| Sidecar | Image | Digest? | Copy? |
|---|---|---|---|
| `vaultwarden-broker-andrii` | `python:latest` | no | **Shape only** (user 10000, read_only, cap_drop, tmpfs, secrets, urllib healthcheck). **Do not copy the tag.** Plan §1.2 forbids `python:latest`. |
| `media-notifier-*` | `python:latest` | no | same anti-pattern |
| `search-ladder` | `ghcr.io/iamstubborn/search-ladder:latest` | no, Watchtower on | not a model for health |
| `health-postgres` | `postgres:17.5-alpine@sha256:6567bca8…` | yes | **yes — tag + digest** |
| `hindsight` | `ghcr.io/vectorize-io/hindsight:0.9.0@sha256:…` | yes | yes |
| current `health-service` Dockerfile | `rust:1.97.0-bookworm@sha256:…` + `debian:bookworm-slim@sha256:…` | yes | yes, for pin style |
| Hermes agent | `nousresearch/hermes-agent@sha256:…` | digest-only | overkill here; keep a human-readable tag **and** digest |

vaultwarden-broker is a stdlib `ThreadingHTTPServer` bind-mounted into `python:latest`. Health cashier has PyPI deps (mcp, uvicorn, later matplotlib). **Bake a small Dockerfile**; do not bind-mount the app into a floating `python:latest`.

### Recommend

Official image (not `python:latest`):

```text
python:3.12-slim-bookworm@sha256:a116514e19457bcb7af7efe9c3dd0b9b71e85b317694e7882a1c52aa15a78134
```

- Tag `3.12-slim-bookworm` is the Debian Bookworm variant of CPython 3.12 (in range for `mcp`, smaller than full `python:3.12`).
- The digest above is Docker Hub's **multi-arch index** digest for that tag, last_updated 2026-08-13 (`amd64` image digest `sha256:356b0d18…`, `arm64` `sha256:fa161ca9…`). Compose should pin the **index** digest so Docker picks the right arch.
- **T4 must re-inspect at implement time** — Hub tags move:

```bash
docker buildx imagetools inspect python:3.12-slim-bookworm --format '{{.Manifest.Digest}}'
```

Compose:

```yaml
image: python:3.12-slim-bookworm@sha256:<inspected>
# or build: and FROM the same pin in health/mcp/Dockerfile
labels:
  com.centurylinklabs.watchtower.enable: "false"
```

Keep current lockdown: `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, `read_only: true`, `tmpfs` for `/tmp`, `expose: ["8080"]`, `health-internal` only, Watchtower **off**.

UID: current Rust health image is **10001:10001**; Hermes and vaultwarden-broker are **10000:10000**. Wiki writes need to match Hermes (plan §1.3). T3 owns the uid map; T4 should not invent a third uid.

Suggested healthcheck (stdlib, no curl in slim):

```yaml
healthcheck:
  test:
    - CMD
    - python3
    - -c
    - "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=3).read()"
```

`Host: 127.0.0.1` on that probe is why `127.0.0.1` / `localhost` stay on the MCP allowlist even though Hermes uses `health-service:8080`. `/healthz` itself should sit **outside** transport-security.

---

## 7. Gotchas (path, sessions, GET vs POST)

### Path prefix

- SDK default is `/mcp`. Hermes is `/internal/mcp`. A server that “works in Inspector” on `:8000/mcp` is a Hermes flag day.
- `Mount("/")` matches **every** path; own routes must be listed **before** it.
- Trailing slash: clients POST to `/internal/mcp` with no slash. After changing `streamable_http_path`, curl that exact path.

### Host allowlist (this will bite on first `up`)

With no `transport_security=`, `streamable_http_app()` arms DNS-rebinding protection for localhost only. Any other `Host` (including `health-service:8080`) is **HTTP 421** `"Invalid Host header"` **before** MCP or auth. That 421 is plain text, not JSON-RPC; the client sees a generic transport error; the hostname is only in the **server** log.

Allowlist both bare and `:*` forms (SDK matches exact strings; `"host:*"` is the port wildcard):

```python
TransportSecuritySettings(
    allowed_hosts=[
        "health-service",
        "health-service:*",
        "localhost",
        "localhost:*",
        "127.0.0.1",
        "127.0.0.1:*",
    ],
)
```

Origin is optional for non-browser clients (absent Origin is allowed). Hermes is server-to-server and should not send `Origin`. Do not disable `enable_dns_rebinding_protection` unless a proxy already owns `Host`.

Passing `host="0.0.0.0"` does **not** allowlist Docker DNS names; it only turns off the localhost default and then accepts **every** Host. Always pass an explicit allowlist.

Current Rust already allowlists `health-service`, `health-service:{port}`, localhost, 127.0.0.1. Mirror that.

### GET vs POST vs DELETE

| Protocol | POST | GET | DELETE | Session header |
|---|---|---|---|---|
| 2025-03-26 … 2025-11-25 | JSON-RPC; response JSON **or** SSE | optional standalone SSE | end session | `Mcp-Session-Id` on init + later requests |
| 2026-07-28 | JSON-RPC; JSON or request-scoped SSE | **not** a session stream (405 is OK) | unused | **none** |

v2 serves **both**. Do not return 405 on GET unless T4 has proven Hermes never GETs. `json_response=True` only changes **POST** (one JSON body, no per-request SSE). 2025 GET SSE / session DELETE still exist on the legacy leg.

Clients **MUST** send `Accept: application/json, text/event-stream` on POST. Current Rust tests already do. Hermes HTTP MCP client is expected to; if a homegrown curl test omits it, the SDK may reject the request.

POST `Content-Type` must start with `application/json` or transport security returns **400**.

### Session headers

- Header name is `Mcp-Session-Id` (HTTP names are case-insensitive).
- 2025: if the server mints a session id, the client must echo it; unknown id → 404 “Session not found”.
- 2026: no session; ignore an inbound `Mcp-Session-Id`.
- Parent lifespan **must** run `mcp.session_manager.run()` even with `json_response=True`.
- One uvicorn worker is enough. `--workers 4` plus 2025 sessions needs stickiness. Do not scale out.

### `json_response=True` cost

Documented: a tool that calls back into the client mid-request (`ctx.elicit()`, sampling) raises `NoBackChannelError` on that POST, and in-flight progress/log notifications are dropped. Health tools are request/response jsonl writes — this matches today's Rust service. Do not use elicitation in cashier tools.

### Other

- Do not declare MCP resources/prompts; Hermes already sets `tools.resources: false` / `prompts: false`.
- v2 `def` tools run on a worker thread (event-loop safe). `fcntl` locks in a `def` tool are fine; do not hold them across `await` in an `async def`.
- OpenTelemetry middleware is on by default in v2; no exporter means no cost. Leave it.
- `httpx2` (not `httpx`) is the SDK HTTP client. The **server** does not need to import it.
- Do not fork the SDK.

---

## 8. Minimal server sketch (T4 can copy)

Hosting only: healthcheck, token map, one dummy tool, Streamable HTTP at `/internal/mcp`. Not the cashier.

```python
"""health/mcp/server.py — hosting sketch for T4. Not the jsonl cashier."""

from __future__ import annotations

import hmac
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.requests import Request
from starlette.responses import PlainTextResponse, Response
from starlette.routing import Mount, Route
from starlette.types import ASGIApp, Receive, Scope, Send

from mcp.server import MCPServer
from mcp.server.mcpserver import Context
from mcp.server.transport_security import TransportSecuritySettings

MAX_BEARER_TOKEN_BYTES = 512
LISTEN_HOST = os.environ.get("HEALTH_LISTEN_HOST", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("HEALTH_LISTEN_PORT", "8080"))

mcp = MCPServer("health")
_current_identity: ContextVar[Identity | None] = ContextVar("health_identity", default=None)


@dataclass(frozen=True)
class Identity:
    actor: str
    via: str
    default_person: str


class TokenMap:
    def __init__(self, andrii: str, valentyna: str) -> None:
        if not andrii or not valentyna:
            raise SystemExit("health API token file is empty")
        if hmac.compare_digest(andrii, valentyna):
            raise SystemExit("health API tokens must differ")
        self._andrii = andrii
        self._valentyna = valentyna

    @classmethod
    def from_env(cls) -> TokenMap:
        return cls(
            _read_token(os.environ["HEALTH_TOKEN_FILE_ANDRII"]),
            _read_token(os.environ["HEALTH_TOKEN_FILE_VALENTYNA"]),
        )

    def resolve(self, token: str) -> Identity | None:
        if hmac.compare_digest(token, self._andrii):
            return Identity("andrii", "hermes_andrii", "andrii")
        if hmac.compare_digest(token, self._valentyna):
            return Identity("valentyna", "hermes_valentyna", "valentyna")
        return None


def _read_token(path: str) -> str:
    token = Path(path).read_text(encoding="utf-8").strip()
    if not token or len(token.encode()) > MAX_BEARER_TOKEN_BYTES:
        raise SystemExit(f"invalid health token file: {path}")
    if any(ord(ch) < 0x21 or ord(ch) > 0x7E for ch in token):
        raise SystemExit(f"invalid health token file: {path}")
    return token


def _is_supported_bearer_token(token: bytes) -> bool:
    return bool(token) and len(token) <= MAX_BEARER_TOKEN_BYTES and all(0x21 <= b <= 0x7E for b in token)


def _bearer_token(request: Request) -> str | None:
    values = request.headers.getlist("authorization")
    if len(values) != 1:
        return None
    raw = values[0].encode("utf-8")
    try:
        scheme, _, token = raw.partition(b" ")
    except Exception:
        return None
    if not scheme.lower() == b"bearer" or not _is_supported_bearer_token(token):
        return None
    return token.decode("ascii")


class BearerAuthMiddleware:
    """Hermes-compatible Authorization: Bearer <token>. Not SDK OAuth."""

    def __init__(self, app: ASGIApp, tokens: TokenMap) -> None:
        self.app = app
        self.tokens = tokens

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request = Request(scope, receive)
        token = _bearer_token(request)
        identity = self.tokens.resolve(token) if token else None
        if identity is None:
            response = PlainTextResponse("unauthorized", status_code=401)
            await response(scope, receive, send)
            return
        scope.setdefault("state", {})
        request.state.identity = identity
        ctx_token = _current_identity.set(identity)
        try:
            await self.app(scope, receive, send)
        finally:
            _current_identity.reset(ctx_token)


@mcp.tool()
def ping(ctx: Context) -> str:
    """Dummy tool for hosting tests. T4 replaces this with the cashier tools."""
    identity = _current_identity.get()
    actor = identity.actor if identity else "unknown"
    return f"ok:{actor}"


async def healthz(_request: Request) -> Response:
    return PlainTextResponse("ok")


def build_app(tokens: TokenMap | None = None) -> Starlette:
    tokens = tokens or TokenMap.from_env()
    security = TransportSecuritySettings(
        allowed_hosts=[
            "health-service",
            "health-service:*",
            "localhost",
            "localhost:*",
            "127.0.0.1",
            "127.0.0.1:*",
        ],
    )
    mcp_app = mcp.streamable_http_app(
        streamable_http_path="/",
        json_response=True,
        transport_security=security,
        host="0.0.0.0",
    )

    @asynccontextmanager
    async def lifespan(_app: Starlette) -> AsyncIterator[None]:
        async with mcp.session_manager.run():
            yield

    return Starlette(
        routes=[
            Route("/healthz", healthz, methods=["GET"]),
            Mount(
                "/internal/mcp",
                app=mcp_app,
                middleware=[Middleware(BearerAuthMiddleware, tokens=tokens)],
            ),
        ],
        lifespan=lifespan,
    )


app = build_app() if os.environ.get("HEALTH_TOKEN_FILE_ANDRII") else None
# Tests construct build_app(TokenMap(...)) without env. Compose always sets the files.


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "server:app",
        host=LISTEN_HOST,
        port=LISTEN_PORT,
        factory=False,
    )
```

Compose command once the module path is real:

```text
uvicorn health_mcp.server:app --host 0.0.0.0 --port 8080
```

Smoke (from another container on `health-internal`):

```bash
curl -fsS http://health-service:8080/healthz
# 401
curl -s -o /dev/null -w '%{http_code}' -X POST http://health-service:8080/internal/mcp \
  -H 'Host: health-service:8080' -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream'
# 200 JSON tools/list including ping, with a real Bearer
curl -fsS -X POST http://health-service:8080/internal/mcp \
  -H 'Host: health-service:8080' \
  -H 'Authorization: Bearer …' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

If the Host header is wrong: **421**, not 401. Fix the allowlist before debugging auth.

Starlette `Mount(..., middleware=)` is valid in current Starlette; if a version rejects per-mount middleware, wrap `mcp_app` with `BearerAuthMiddleware(mcp_app, tokens)` and `Mount("/internal/mcp", app=wrapped)` instead. Do **not** put Bearer on `/healthz`.

---

## 9. Suggested Dockerfile / Compose shape (not implemented)

```dockerfile
FROM python:3.12-slim-bookworm@sha256:a116514e19457bcb7af7efe9c3dd0b9b71e85b317694e7882a1c52aa15a78134
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . /app
USER 10000:10000
EXPOSE 8080
CMD ["uvicorn", "health_mcp.server:app", "--host", "0.0.0.0", "--port", "8080"]
```

Keep secret mounts and env names from `health/compose.yml` (`HEALTH_TOKEN_FILE_*`, listen 8080). Drop postgres env. Fail closed if token files or wiki path are missing (wiki path is T4, not this sketch).

---

## 10. What T4 should not do

- Do not implement the jsonl cashier in this scout's sketch; replace `ping` with the §1.4 tools.
- Do not reintroduce Postgres, SQLite, or the Rust binary.
- Do not use `python:latest`, unpinned `mcp`, or `mcp.run()` as the production entrypoint.
- Do not enable SDK OAuth / `AuthSettings`.
- Do not change Hermes `mcp_servers.health.url` unless the new listen path is updated in the **same** task (plan prefers keeping `/internal/mcp`).
- Do not scale uvicorn workers.

Done: concrete packages (`mcp==2.0.0`, `uvicorn==0.52.4`, `starlette==1.6.0`, `sse-starlette==3.4.8`) and a minimal server sketch the Worker can copy.
