"""Telegram media callback contracts and MCP operation builders."""

from __future__ import annotations

import json
import re
import uuid

from telegram.error import TelegramError


_CALLBACK_RE = re.compile(
    r"ma:(cancel|retry|retry-missing|resume-storage|details|search-alternative):"
    r"([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})"
    r"(?::([0-9a-f]{8}))?\Z"
)
_SOURCE_CHOICE_CALLBACK_RE = re.compile(
    r"ms:(a|r|p):"
    r"([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}):"
    r"(0|[1-9][0-9]{0,9}):([1-9][0-9]{0,9})\Z"
)
_SOURCE_BACK_CALLBACK_RE = re.compile(
    r"ms:b:"
    r"([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}):"
    r"(0|[1-9][0-9]{0,9}):([1-9][0-9]{0,9})\Z"
)
_DOWNLOAD_ACTION_CALLBACK_RE = re.compile(r"md:([A-Za-z0-9_-]{12,24})\Z")
_PRESENTATION_CALLBACK_RE = re.compile(
    r"hm:(e|b|c|x):"
    r"([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\Z"
)
_PRESENTATION_COMMANDS = {
    "e": "expand",
    "b": "collapse",
    "c": "confirm-cancel",
    "x": "dismiss-cancel",
}
_BARE_INTERNAL_ID_RE = re.compile(
    r"(?:Job\s+)?[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}"
)


def _is_expired_callback_query(error: TelegramError) -> bool:
    return "query is too old" in str(error).lower()


async def _answer_claimed_callback(query, release, **kwargs) -> bool:
    try:
        await query.answer(**kwargs)
    except TelegramError:
        release()
        return False
    except BaseException:
        release()
        raise
    return True


def _created_job_id(output: bytes) -> str | None:
    try:
        payload = json.loads(output.decode("utf-8"))
        value = payload.get("id") if isinstance(payload, dict) else None
        parsed = uuid.UUID(value) if isinstance(value, str) else None
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError, AttributeError):
        return None
    return str(parsed) if parsed is not None and str(parsed) == value else None


def _media_mcp_operation(
    action: str,
    job_id: str,
    expected_lifecycle_cycle: int | None = None,
) -> tuple[str, dict] | None:
    arguments = {"job_id": job_id}
    if (
        isinstance(expected_lifecycle_cycle, int)
        and not isinstance(expected_lifecycle_cycle, bool)
        and expected_lifecycle_cycle >= 1
    ):
        arguments["expected_lifecycle_cycle"] = expected_lifecycle_cycle
    if action == "cancel":
        return ("mcp__media_admin__media_job_cancel", arguments)
    if action in {"retry", "retry-missing", "resume-storage"}:
        return ("mcp__media_admin__media_job_retry", arguments)
    if action == "details":
        return ("mcp__media_admin__media_job_get", {"job_id": job_id})
    if action == "search-alternative":
        return ("mcp__media_admin__media_job_alternatives", {"job_id": job_id})
    return None
