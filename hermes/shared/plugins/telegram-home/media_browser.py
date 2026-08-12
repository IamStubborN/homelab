"""Shared keyboard layout for Telegram media browser cards."""

from __future__ import annotations

from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from typing import Generic, TypeVar


Button = TypeVar("Button")
Route = TypeVar("Route")


@dataclass(frozen=True)
class MediaBrowserNavigation(Generic[Button]):
    buttons: tuple[Button, Button, Button]


def media_carousel_navigation(
    routes: Sequence[Route],
    index: int,
    *,
    make_button: Callable[[str, str], Button],
    callback_for: Callable[[Route], str],
    noop_callback: str,
    position_prefix: str = "",
) -> MediaBrowserNavigation[Button]:
    """Build non-wrapping carousel navigation with a disabled position."""
    if not routes:
        raise ValueError("carousel routes must not be empty")
    index = min(len(routes) - 1, max(0, index))
    previous = callback_for(routes[index - 1]) if index > 0 else noop_callback
    following = (
        callback_for(routes[index + 1])
        if index + 1 < len(routes)
        else noop_callback
    )
    return MediaBrowserNavigation((
        make_button("⬅️", previous),
        make_button(f"{position_prefix}{index + 1}/{len(routes)}", noop_callback),
        make_button("➡️", following),
    ))


def media_page_navigation(
    page: int,
    total_pages: int,
    *,
    make_button: Callable[[str, str], Button],
    callback_for: Callable[[int], str],
    noop_callback: str,
) -> MediaBrowserNavigation[Button]:
    """Build non-wrapping page navigation with a disabled position."""
    if total_pages < 1:
        raise ValueError("total_pages must be positive")
    page = min(total_pages, max(1, page))
    return MediaBrowserNavigation((
        make_button(
            "⬅️", callback_for(page - 1) if page > 1 else noop_callback
        ),
        make_button(f"{page}/{total_pages}", noop_callback),
        make_button(
            "➡️",
            callback_for(page + 1) if page < total_pages else noop_callback,
        ),
    ))


def media_browser_rows(
    *,
    back: Button,
    navigation: MediaBrowserNavigation[Button] | None = None,
    controls: Iterable[Sequence[Button]] = (),
    actions: Iterable[Button] = (),
    action_width: int = 3,
) -> tuple[tuple[Button, ...], ...]:
    """Build the stable media card shell: nav, controls, actions, then Back."""
    if action_width < 1:
        raise ValueError("action_width must be positive")
    rows: list[tuple[Button, ...]] = []
    if navigation is not None:
        rows.append(navigation.buttons)
    rows.extend(tuple(row) for row in controls if row)
    action_buttons = tuple(actions)
    rows.extend(
        tuple(action_buttons[index : index + action_width])
        for index in range(0, len(action_buttons), action_width)
    )
    rows.append((back,))
    return tuple(rows)
