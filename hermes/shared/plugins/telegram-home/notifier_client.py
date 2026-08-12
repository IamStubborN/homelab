"""Signed control client for the local media notifier."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path


_DEFAULT_CONTROL_URL = "http://media-notifier:8644"
_DEFAULT_SECRET_FILE = "/run/secrets/webhook_hmac"
_COMMANDS = frozenset({"expand", "collapse", "confirm-cancel", "dismiss-cancel"})


class NotifierControlError(RuntimeError):
    """Base class for expected notifier control failures."""


class NotifierControlStaleError(NotifierControlError):
    """The Telegram card no longer matches the notifier state."""


class NotifierControlUnavailableError(NotifierControlError):
    """The notifier could not accept a control request."""


class NotifierControlClient:
    def __init__(
        self,
        control_url: str | None = None,
        secret_file: str | Path | None = None,
    ) -> None:
        configured_url = control_url or os.environ.get(
            "MEDIA_NOTIFIER_CONTROL_URL", _DEFAULT_CONTROL_URL
        )
        parsed = urllib.parse.urlsplit(configured_url)
        if (
            parsed.scheme != "http"
            or not parsed.netloc
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("MEDIA_NOTIFIER_CONTROL_URL must be an internal HTTP URL")
        self._control_url = configured_url.rstrip("/") + "/control/card"
        path = Path(
            secret_file
            or os.environ.get("WEBHOOK_SECRET_FILE", _DEFAULT_SECRET_FILE)
        )
        try:
            self._secret = path.read_bytes().strip()
        except OSError as error:
            raise NotifierControlUnavailableError(
                "notifier control secret is unavailable"
            ) from error
        if not self._secret:
            raise ValueError("WEBHOOK_SECRET_FILE must not be empty")

    def control(self, command: str, job_id: str, message_id: str) -> None:
        if command not in _COMMANDS:
            raise ValueError("unsupported notifier presentation command")
        if (
            not isinstance(job_id, str)
            or not isinstance(message_id, str)
            or not message_id.isdigit()
        ):
            raise ValueError("notifier control payload is invalid")
        body = json.dumps(
            {"command": command, "job_id": job_id, "message_id": message_id},
            separators=(",", ":"),
        ).encode("utf-8")
        timestamp = str(int(time.time()))
        signature = hmac.new(
            self._secret,
            timestamp.encode("ascii") + b"." + body,
            hashlib.sha256,
        ).hexdigest()
        request = urllib.request.Request(
            self._control_url,
            data=body,
            headers={
                "Content-Type": "application/json",
                "X-Webhook-Timestamp": timestamp,
                "X-Webhook-Signature-V2": signature,
                "X-Request-ID": str(uuid.uuid4()),
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                if not 200 <= response.status < 300:
                    self._raise_for_status(response.status)
        except urllib.error.HTTPError as error:
            self._raise_for_status(error.code)
        except OSError as error:
            raise NotifierControlUnavailableError("notifier control request failed") from error

    @staticmethod
    def _raise_for_status(status: int) -> None:
        if status in {404, 409}:
            raise NotifierControlStaleError("notifier card is stale")
        raise NotifierControlUnavailableError("notifier control request failed")
