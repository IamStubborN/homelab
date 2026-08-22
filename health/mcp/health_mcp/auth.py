from __future__ import annotations

import hmac
import os
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path

from starlette.requests import Request
from starlette.responses import PlainTextResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from health_mcp.types import CashierError

MAX_BEARER_TOKEN_BYTES = 512


@dataclass(frozen=True)
class Identity:
    actor: str
    via: str
    default_person: str


_current_identity: ContextVar[Identity | None] = ContextVar("health_identity", default=None)


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


def current_identity() -> Identity:
    identity = _current_identity.get()
    if identity is None:
        raise CashierError("authenticated request context is unavailable")
    return identity


def _read_token(path: str) -> str:
    try:
        token = Path(path).read_text(encoding="utf-8").strip()
    except PermissionError as exc:
        raise SystemExit(f"unreadable health token file: {path}") from exc
    if not token or len(token.encode("utf-8")) > MAX_BEARER_TOKEN_BYTES:
        raise SystemExit(f"invalid health token file: {path}")
    if any(ord(ch) < 0x21 or ord(ch) > 0x7E for ch in token):
        raise SystemExit(f"invalid health token file: {path}")
    return token


def _is_supported_bearer_token(token: bytes) -> bool:
    return bool(token) and len(token) <= MAX_BEARER_TOKEN_BYTES and all(
        0x21 <= byte <= 0x7E for byte in token
    )


def _bearer_token(request: Request) -> str | None:
    values = request.headers.getlist("authorization")
    if len(values) != 1:
        return None
    raw = values[0].encode("utf-8")
    scheme, separator, token = raw.partition(b" ")
    if not separator or scheme.lower() != b"bearer" or not _is_supported_bearer_token(token):
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
