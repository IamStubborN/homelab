"""Persistent action storage for Telegram media callbacks."""

from __future__ import annotations

import fcntl
import asyncio
import hashlib
import json
import secrets
import threading
import time
from contextlib import asynccontextmanager, contextmanager
from dataclasses import asdict
from datetime import datetime
from pathlib import Path

from .media_models import SearchAction


_DEFAULT_MEDIA_ACTIONS_FILE = Path("/opt/data/telegram-media-actions.json")
_MAX_MEDIA_ACTIONS = 500
_MEDIA_ACTION_CLAIM_TTL_SECONDS = 5 * 60
_DEFAULT_MEDIA_NAVIGATION_FILE = Path("/opt/data/telegram-media-navigation.json")
_MAX_MEDIA_NAVIGATION_SESSIONS = 500
_MAX_MEDIA_NAVIGATION_DEPTH = 20
_MEDIA_NAVIGATION_TTL_SECONDS = 7 * 24 * 60 * 60
_DEFAULT_BUSINESS_ACTION_RECEIPTS_FILE = Path(
    "/opt/data/telegram-media-business-actions.json"
)
_MAX_BUSINESS_ACTION_RECEIPTS = 500
_BUSINESS_ACTION_CLAIM_TTL_SECONDS = 5 * 60
_PROCESS_CLAIM_OWNER = secrets.token_hex(16)
_EXECUTION_LOCK_SHARD_HEX_LENGTH = 3


class MediaActionStore:
    """Persistent bounded callback store for Telegram's 64-byte callback limit."""

    def __init__(
        self, path: Path, *, now=time.time, owner: str = _PROCESS_CLAIM_OWNER
    ):
        self._path = path
        self._now = now
        self._owner = owner
        self._lock = threading.Lock()

    def create(self, action: SearchAction) -> str:
        return self.create_many((action,))[0]

    def create_many(self, actions: tuple[SearchAction, ...]) -> list[str]:
        if not actions:
            return []
        with self._exclusive():
            values = self._load()
            now = self._now()
            self._purge(values, now)
            tokens = []
            for action in actions:
                token = self._new_token(values)
                values[token] = {
                    "action": asdict(action),
                    "consumed": False,
                    "created_at": now,
                }
                tokens.append(token)
            if not self._trim(values, now, protected=frozenset(tokens)):
                for token in tokens:
                    values.pop(token, None)
                raise RuntimeError("media action store is busy")
            self._write(values)
            return tokens

    def resolve(self, token: str) -> tuple[SearchAction, bool] | None:
        with self._exclusive():
            values = self._load()
            now = self._now()
            changed = self._purge(values, now)
            item = values.get(token)
            if changed:
                self._write(values)
            if not isinstance(item, dict):
                return None
            action = self._decode_action(item.get("action"))
            if action is None:
                return None
            return action, item.get("consumed") is True

    def consume(self, token: str) -> None:
        with self._exclusive():
            values = self._load()
            item = values.get(token)
            if (
                not isinstance(item, dict)
                or item.get("claim_owner") != self._owner
            ):
                return
            item["consumed"] = True
            item.pop("claimed_at", None)
            item.pop("claim_owner", None)
            self._write(values)

    def claim(self, token: str) -> tuple[SearchAction, str] | None:
        with self._exclusive():
            values = self._load()
            now = self._now()
            changed = self._purge(values, now)
            item = values.get(token)
            if not isinstance(item, dict):
                if changed:
                    self._write(values)
                return None
            action = self._decode_action(item.get("action"))
            if action is None:
                return None
            if item.get("consumed") is True:
                return action, "consumed"
            claimed_at = item.get("claimed_at")
            if (
                isinstance(claimed_at, (int, float))
                and (
                    item.get("claim_owner") == self._owner
                    or claimed_at + _MEDIA_ACTION_CLAIM_TTL_SECONDS > now
                )
            ):
                return action, "claimed"
            if self._execution_in_progress(token):
                return action, "claimed"
            item["claimed_at"] = now
            item["claim_owner"] = self._owner
            self._write(values)
            return action, "ready"

    @asynccontextmanager
    async def execution(self, token: str):
        async with self._execution_lock(token):
            with self._exclusive():
                values = self._load()
                item = values.get(token)
                owns_claim = (
                    isinstance(item, dict)
                    and item.get("consumed") is not True
                    and item.get("claim_owner") == self._owner
                )
                if owns_claim:
                    item["claimed_at"] = self._now()
                    self._write(values)
            yield owns_claim

    def release(self, token: str) -> None:
        with self._exclusive():
            values = self._load()
            item = values.get(token)
            if (
                not isinstance(item, dict)
                or item.get("consumed") is True
                or item.get("claim_owner") != self._owner
            ):
                return
            item.pop("claimed_at", None)
            item.pop("claim_owner", None)
            self._write(values)

    def restore_consumed(self, token: str) -> None:
        """Restore a consumed action when dispatch provably never started."""
        with self._exclusive():
            values = self._load()
            item = values.get(token)
            if not isinstance(item, dict) or item.get("consumed") is not True:
                return
            item["consumed"] = False
            self._write(values)

    @contextmanager
    def _exclusive(self):
        with self._lock:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            lock_path = self._path.with_name(f".{self._path.name}.lock")
            with lock_path.open("a", encoding="utf-8") as lock_file:
                lock_path.chmod(0o600)
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
                try:
                    yield
                finally:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)

    def _load(self) -> dict:
        try:
            value = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            return {}
        actions = value.get("actions") if isinstance(value, dict) else None
        return actions if isinstance(actions, dict) else {}

    def _write(self, values: dict) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._path.with_name(f".{self._path.name}.tmp")
        temporary.write_text(
            json.dumps(
                {"version": 1, "actions": values},
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            encoding="utf-8",
        )
        temporary.chmod(0o600)
        temporary.replace(self._path)

    def _execution_in_progress(self, key: str) -> bool:
        lock_path = self._execution_lock_path(key)
        with lock_path.open("a", encoding="utf-8") as lock_file:
            lock_path.chmod(0o600)
            try:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return True
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
            return False

    @asynccontextmanager
    async def _execution_lock(self, key: str):
        lock_path = self._execution_lock_path(key)
        with lock_path.open("a", encoding="utf-8") as lock_file:
            lock_path.chmod(0o600)
            while True:
                try:
                    fcntl.flock(
                        lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB
                    )
                    break
                except BlockingIOError:
                    await asyncio.sleep(0.01)
            try:
                yield
            finally:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)

    def _execution_lock_path(self, key: str) -> Path:
        shard = hashlib.sha256(key.encode("utf-8")).hexdigest()[
            :_EXECUTION_LOCK_SHARD_HEX_LENGTH
        ]
        return self._path.with_name(f".{self._path.name}.{shard}.execution.lock")

    @staticmethod
    def _new_token(values: dict) -> str:
        while True:
            token = secrets.token_urlsafe(12)
            if token not in values:
                return token

    @staticmethod
    def _decode_action(value) -> SearchAction | None:
        if not isinstance(value, dict):
            return None
        label = _bounded_text(value.get("label"), 80)
        kind = value.get("kind")
        payload = value.get("payload")
        expires_at = value.get("expires_at")
        if (
            label is None
            or kind not in {
                "download",
                "tracking-create",
                "tracking-enable-download",
                "tracking-manage",
                "tracking-back",
                "tracking-configure",
                "tracking-remove-prepare",
                "tracking-remove-confirm",
                "all-search-back",
                "combined-page",
                "continue",
                "provider-open",
                "job-open",
                "release-details",
                "release-page",
                "release-back",
                "rendered-page",
                "noop",
                "website",
            }
            or not isinstance(payload, dict)
            or not isinstance(expires_at, str)
        ):
            return None
        return SearchAction(label, kind, payload, expires_at)

    @staticmethod
    def _purge(values: dict, now: float) -> bool:
        expired = []
        for token, item in values.items():
            action = item.get("action") if isinstance(item, dict) else None
            expires_at = action.get("expires_at") if isinstance(action, dict) else None
            if _expiry_timestamp(expires_at) <= now:
                expired.append(token)
        for token in expired:
            values.pop(token, None)
        return bool(expired)

    def _trim(
        self,
        values: dict,
        now: float,
        *,
        protected: frozenset[str] = frozenset(),
    ) -> bool:
        overflow = len(values) - _MAX_MEDIA_ACTIONS
        if overflow <= 0:
            return True
        oldest = sorted(
            (
                token
                for token, item in values.items()
                if token not in protected
                and (
                    not isinstance(item, dict)
                    or item.get("consumed") is True
                    or not isinstance(item.get("claimed_at"), (int, float))
                    or (
                        item.get("claim_owner") != self._owner
                        and item["claimed_at"] + _MEDIA_ACTION_CLAIM_TTL_SECONDS
                        <= now
                    )
                )
            ),
            key=lambda token: (
                values[token].get("created_at", 0)
                if isinstance(values[token], dict)
                else 0
            ),
        )
        for token in oldest[:overflow]:
            values.pop(token, None)
        return len(values) <= _MAX_MEDIA_ACTIONS


class MediaNavigationStore:
    """Persistent browser-like history for an edited Telegram message."""

    def __init__(self, path: Path, *, now=time.time):
        self._path = path
        self._now = now
        self._lock = threading.Lock()

    def current(self, key: str) -> str | None:
        with self._exclusive():
            values = self._load()
            changed = self._purge(values, self._now())
            item = values.get(key)
            if changed:
                self._write(values)
            return self._route(item.get("current")) if isinstance(item, dict) else None

    def has_back(self, key: str, *, prefix: str | None = None) -> bool:
        with self._exclusive():
            values = self._load()
            changed = self._purge(values, self._now())
            item = values.get(key)
            back = item.get("back") if isinstance(item, dict) else None
            result = isinstance(back, list) and any(
                (normalized := self._route(route)) is not None
                and (prefix is None or normalized.startswith(prefix))
                for route in back
            )
            if changed:
                self._write(values)
            return result

    def visit(
        self,
        key: str,
        route: str,
        *,
        fallback: str | None = None,
        replace: bool = False,
    ) -> None:
        route = self._route(route)
        fallback = self._route(fallback)
        if route is None:
            return
        with self._exclusive():
            values = self._load()
            now = self._now()
            self._purge(values, now)
            item = values.get(key)
            if not isinstance(item, dict):
                item = {"current": None, "back": []}
            current = self._route(item.get("current"))
            back = [
                value
                for value in item.get("back", [])
                if self._route(value) is not None
            ] if isinstance(item.get("back"), list) else []
            parent = current or fallback
            if not replace and parent is not None and parent != route:
                if not back or back[-1] != parent:
                    back.append(parent)
            item.update({
                "current": route,
                "back": back[-_MAX_MEDIA_NAVIGATION_DEPTH:],
                "updated_at": now,
            })
            values[key] = item
            self._trim(values)
            self._write(values)

    def reset(self, key: str, route: str) -> None:
        route = self._route(route)
        if route is None:
            return
        with self._exclusive():
            values = self._load()
            now = self._now()
            self._purge(values, now)
            values[key] = {
                "current": route,
                "back": [],
                "updated_at": now,
            }
            self._trim(values)
            self._write(values)

    def back(self, key: str) -> str | None:
        with self._exclusive():
            values = self._load()
            now = self._now()
            self._purge(values, now)
            item = values.get(key)
            if not isinstance(item, dict) or not isinstance(item.get("back"), list):
                return None
            back = [
                value for value in item["back"] if self._route(value) is not None
            ]
            if not back:
                return None
            route = back.pop()
            item.update({"current": route, "back": back, "updated_at": now})
            self._write(values)
            return route

    @contextmanager
    def _exclusive(self):
        with self._lock:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            lock_path = self._path.with_name(f".{self._path.name}.lock")
            with lock_path.open("a", encoding="utf-8") as lock_file:
                lock_path.chmod(0o600)
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
                try:
                    yield
                finally:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)

    def _load(self) -> dict:
        try:
            value = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            return {}
        sessions = value.get("sessions") if isinstance(value, dict) else None
        return sessions if isinstance(sessions, dict) else {}

    def _write(self, values: dict) -> None:
        temporary = self._path.with_name(f".{self._path.name}.tmp")
        temporary.write_text(
            json.dumps(
                {"version": 1, "sessions": values},
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            encoding="utf-8",
        )
        temporary.chmod(0o600)
        temporary.replace(self._path)

    @staticmethod
    def _route(value) -> str | None:
        if not isinstance(value, str) or not 1 <= len(value) <= 64:
            return None
        return value if value.startswith(("mt:", "mi:", "mx:", "mp:")) else None

    @staticmethod
    def _purge(values: dict, now: float) -> bool:
        expired = [
            key
            for key, item in values.items()
            if not isinstance(item, dict)
            or not isinstance(item.get("updated_at"), (int, float))
            or item["updated_at"] + _MEDIA_NAVIGATION_TTL_SECONDS <= now
        ]
        for key in expired:
            values.pop(key, None)
        return bool(expired)

    @staticmethod
    def _trim(values: dict) -> None:
        overflow = len(values) - _MAX_MEDIA_NAVIGATION_SESSIONS
        if overflow <= 0:
            return
        oldest = sorted(
            values,
            key=lambda key: (
                values[key].get("updated_at", 0)
                if isinstance(values[key], dict)
                else 0
            ),
        )
        for key in oldest[:overflow]:
            values.pop(key, None)


class BusinessActionReceiptStore:
    """Persistent deduplication receipts for direct media-service callbacks."""

    def __init__(
        self, path: Path, *, now=time.time, owner: str = _PROCESS_CLAIM_OWNER
    ):
        self._path = path
        self._now = now
        self._owner = owner
        self._lock = threading.Lock()

    def claim(self, callback_data: str, message_id: str | int) -> str:
        key = self._key(callback_data, message_id)
        with self._exclusive():
            receipts = self._load()
            now = self._now()
            self._purge_expired_claims(receipts, now)
            receipt = receipts.get(key)
            if isinstance(receipt, dict) and receipt.get("state") in {
                "claimed",
                "consumed",
            }:
                return receipt["state"]
            if self._execution_in_progress(key):
                return "claimed"
            self._trim(receipts, maximum=_MAX_BUSINESS_ACTION_RECEIPTS - 1)
            if len(receipts) >= _MAX_BUSINESS_ACTION_RECEIPTS:
                return "busy"
            receipts[key] = {
                "state": "claimed",
                "created_at": now,
                "claim_owner": self._owner,
            }
            self._write(receipts)
            return "ready"

    @asynccontextmanager
    async def execution(self, callback_data: str, message_id: str | int):
        key = self._key(callback_data, message_id)
        async with self._execution_lock(key):
            with self._exclusive():
                receipts = self._load()
                receipt = receipts.get(key)
                owns_claim = (
                    isinstance(receipt, dict)
                    and receipt.get("state") == "claimed"
                    and receipt.get("claim_owner") == self._owner
                )
                if owns_claim:
                    receipt["created_at"] = self._now()
                    self._write(receipts)
            yield owns_claim

    def consume(self, callback_data: str, message_id: str | int) -> None:
        key = self._key(callback_data, message_id)
        with self._exclusive():
            receipts = self._load()
            receipt = receipts.get(key)
            if (
                not isinstance(receipt, dict)
                or receipt.get("state") != "claimed"
                or receipt.get("claim_owner") != self._owner
            ):
                return
            receipt["state"] = "consumed"
            receipt.pop("claim_owner", None)
            self._write(receipts)

    def release(self, callback_data: str, message_id: str | int) -> None:
        key = self._key(callback_data, message_id)
        with self._exclusive():
            receipts = self._load()
            receipt = receipts.get(key)
            if (
                not isinstance(receipt, dict)
                or receipt.get("state") != "claimed"
                or receipt.get("claim_owner") != self._owner
            ):
                return
            receipts.pop(key, None)
            self._write(receipts)

    def restore_consumed(self, callback_data: str, message_id: str | int) -> None:
        """Remove a consumed receipt when dispatch provably never started."""
        key = self._key(callback_data, message_id)
        with self._exclusive():
            receipts = self._load()
            receipt = receipts.get(key)
            if not isinstance(receipt, dict) or receipt.get("state") != "consumed":
                return
            receipts.pop(key, None)
            self._write(receipts)

    @contextmanager
    def _exclusive(self):
        with self._lock:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            lock_path = self._path.with_name(f".{self._path.name}.lock")
            with lock_path.open("a", encoding="utf-8") as lock_file:
                lock_path.chmod(0o600)
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
                try:
                    yield
                finally:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)

    def _load(self) -> dict:
        try:
            value = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            return {}
        receipts = value.get("receipts") if isinstance(value, dict) else None
        return receipts if isinstance(receipts, dict) else {}

    def _write(self, receipts: dict) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._path.with_name(f".{self._path.name}.tmp")
        temporary.write_text(
            json.dumps(
                {"version": 1, "receipts": receipts},
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            encoding="utf-8",
        )
        temporary.chmod(0o600)
        temporary.replace(self._path)

    def _execution_in_progress(self, key: str) -> bool:
        lock_path = self._execution_lock_path(key)
        with lock_path.open("a", encoding="utf-8") as lock_file:
            lock_path.chmod(0o600)
            try:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return True
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
            return False

    @asynccontextmanager
    async def _execution_lock(self, key: str):
        lock_path = self._execution_lock_path(key)
        with lock_path.open("a", encoding="utf-8") as lock_file:
            lock_path.chmod(0o600)
            while True:
                try:
                    fcntl.flock(
                        lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB
                    )
                    break
                except BlockingIOError:
                    await asyncio.sleep(0.01)
            try:
                yield
            finally:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)

    def _execution_lock_path(self, key: str) -> Path:
        shard = hashlib.sha256(key.encode("utf-8")).hexdigest()[
            :_EXECUTION_LOCK_SHARD_HEX_LENGTH
        ]
        return self._path.with_name(f".{self._path.name}.{shard}.execution.lock")

    @staticmethod
    def _key(callback_data: str, message_id: str | int) -> str:
        if (
            not isinstance(callback_data, str)
            or not callback_data
            or len(callback_data.encode("utf-8")) > 64
        ):
            raise ValueError("callback data is invalid")
        value = str(message_id)
        if not value.isdigit() or len(value) > 32:
            raise ValueError("message id is invalid")
        return f"{callback_data}:{value}"

    def _purge_expired_claims(self, receipts: dict, now: float) -> None:
        expired = [
            key
            for key, receipt in receipts.items()
            if isinstance(receipt, dict)
            and receipt.get("state") == "claimed"
            and receipt.get("claim_owner") != self._owner
            and (
                not isinstance(receipt.get("created_at"), (int, float))
                or receipt["created_at"] + _BUSINESS_ACTION_CLAIM_TTL_SECONDS <= now
            )
        ]
        for key in expired:
            receipts.pop(key, None)

    @staticmethod
    def _trim(
        receipts: dict, *, maximum: int = _MAX_BUSINESS_ACTION_RECEIPTS
    ) -> None:
        overflow = len(receipts) - maximum
        if overflow <= 0:
            return
        oldest = sorted(
            (
                key
                for key, receipt in receipts.items()
                if isinstance(receipt, dict) and receipt.get("state") == "consumed"
            ),
            key=lambda key: (
                receipts[key].get("created_at", 0)
                if isinstance(receipts[key], dict)
                else 0
            ),
        )
        for key in oldest[:overflow]:
            receipts.pop(key, None)


def _bounded_text(value, limit: int = 160) -> str | None:
    if not isinstance(value, str):
        return None
    text = "".join(character for character in value if character.isprintable()).strip()
    if not text:
        return None
    return text[:limit]


def _expiry_timestamp(value) -> float:
    if not isinstance(value, str):
        return 0
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return 0
    try:
        return parsed.timestamp()
    except (OverflowError, OSError):
        return 0
