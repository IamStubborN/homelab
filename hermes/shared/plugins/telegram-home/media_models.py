"""Immutable models for Telegram media search cards."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class SearchAction:
    label: str
    kind: str
    payload: dict[str, Any]
    expires_at: str


@dataclass(frozen=True)
class RenderedSearchPart:
    text: str
    actions: tuple[SearchAction, ...]
    photo_url: str | None = None


@dataclass(frozen=True)
class RenderedSearch:
    text: str
    actions: tuple[SearchAction, ...]
    parts: tuple[RenderedSearchPart, ...]
