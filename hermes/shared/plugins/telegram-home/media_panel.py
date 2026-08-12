"""Pure Telegram media panel cards backed by MCP tools."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
from html import escape
import logging
import re
from typing import Iterable

from telegram import InlineKeyboardButton, InlineKeyboardMarkup

from .media_browser import (
    media_browser_rows,
    media_carousel_navigation,
    media_page_navigation,
)
from .media_commands import _command_payload, _render_trending_command
from .media_trending import render_direct_details


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class MediaPanelButton:
    label: str
    callback_data: str


@dataclass(frozen=True)
class MediaPanelCard:
    text: str
    buttons: tuple[tuple[MediaPanelButton, ...], ...]
    parse_mode: str = "HTML"
    photo_rating_key: str | None = None
    photo_url: str | None = None


_UUID = r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}"
_MEDIA_PANEL_CALLBACK_RE = re.compile(
    rf"^mp:(home|noop|plex|watching(?:-p:[1-9][0-9]?)?|"
    rf"watching-key:[0-9]+(?::[1-9][0-9]?)?|"
    rf"recent(?:-p:[1-9][0-9]?)?|recent-key:[0-9]+(?::[1-9][0-9]?)?|"
    rf"library|library-section:[1-9][0-9]*:[1-9][0-9]*|"
    rf"library-key:[1-9][0-9]*:[0-9]+:[1-9][0-9]*|"
    rf"storage|downloads(?:-[mt])?-p:[1-9][0-9]*|downloads|"
    rf"job:{_UUID}(?::[1-9][0-9]*(?::[mt])?)?|"
    rf"job-cancel:{_UUID}(?::[1-9][0-9]*(?::[mt])?)?|"
    rf"job-retry:{_UUID}(?::[1-9][0-9]*(?::[mt])?)?|"
    rf"tracking(?:-p:[1-9][0-9]*)?|tracking:{_UUID}(?::[1-9][0-9]*)?|"
    rf"tracking-check:{_UUID}(?::[1-9][0-9]*)?|"
    rf"tc:{_UUID}:[1-9][0-9]*:[0-9a-f]{{8}}|"
    rf"trending|best|best:[mt]:[rp]:[1-9][0-9]*|"
    rf"best-key:[mt]:[rp]:[1-9][0-9]*:[0-9]:[1-9][0-9]*|"
    rf"premieres|prem:[mt]:[nuoa]:[1-9][0-9]*|"
    rf"prem-key:[mt]:[nuoa]:[1-9][0-9]*:[0-9]:[1-9][0-9]*|"
    rf"genres|genres:[mt]|discover:[mt]:[1-9][0-9]*:[1-9][0-9]*|"
    rf"discover-key:[mt]:[1-9][0-9]*:[1-9][0-9]*:[0-9]:[1-9][0-9]*)$"
)

_PAGE_SIZE = 10
_DOWNLOADS_PAGE_SIZE = 5

_HOME_ROWS = (
    (("🔥 Тренды", "trending"), ("⭐ Лучшее", "best")),
    (("📅 Премьеры", "premieres"), ("🎭 По жанрам", "genres")),
    (("🔔 Подписки", "tracking"), ("⬇️ Загрузки", "downloads")),
)

_DISCOVERY_TOOLS = {
    "best": "mcp__media_admin__media_best",
    "premieres": "mcp__media_admin__media_premieres",
    "genres": "mcp__media_admin__media_genres",
    "discover": "mcp__media_admin__media_discover",
}

_LIVE_JOB_STATES = {
    "queued",
    "leased",
    "running",
    "cancel_requested",
    "publishing",
    "plex_pending",
}
_CANCELLABLE_JOB_STATES = {
    "queued",
    "leased",
    "running",
    "blocked_storage",
    "publishing",
    "plex_pending",
    "needs_action",
}
_RETRYABLE_JOB_STATES = {"blocked_storage", "partial", "failed", "needs_action"}

_STATE_LABELS = {
    "queued": "в очереди",
    "leased": "подготовка",
    "running": "выполняется",
    "cancel_requested": "отменяется",
    "blocked_storage": "не хватает места",
    "publishing": "публикация",
    "plex_pending": "ожидает Plex",
    "needs_action": "нужен выбор",
    "partial": "завершено частично",
    "completed": "готово",
    "failed": "ошибка",
    "cancelled": "отменено",
}

_STATE_ICONS = {
    "queued": "🕒",
    "leased": "⚙️",
    "running": "⬇️",
    "cancel_requested": "⏳",
    "blocked_storage": "💾",
    "publishing": "📂",
    "plex_pending": "📺",
    "needs_action": "⚠️",
    "partial": "⚠️",
    "completed": "✅",
    "failed": "❌",
    "cancelled": "⏹️",
}

_STAGE_LABELS = {
    "preparing": "подготовка",
    "downloading": "скачивание",
    "download": "скачивание",
    "transcoding": "обработка видео",
    "processing": "обработка медиа",
    "publishing": "публикация в Plex",
    "plex_scan": "обновление Plex",
    "torrent_submit": "передача торрента в загрузчик",
    "torrent_wait": "ожидание данных торрента",
    "plex_reconcile": "проверка публикации в Plex",
}


def _html(value: object, *, limit: int = 300) -> str:
    text = str(value or "").strip()
    if len(text) > limit:
        text = text[: max(0, limit - 1)].rstrip() + "…"
    return escape(text, quote=True)


def _button(label: str, route: str) -> MediaPanelButton:
    return MediaPanelButton(label, route)


def _button_label(value: object, *, limit: int = 48) -> str:
    text = str(value or "").strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _bounded_html(value: object, *, limit: int, escaped_limit: int) -> str:
    text = str(value or "").strip()
    if len(text) > limit:
        text = text[: max(0, limit - 1)].rstrip() + "…"
    while text and len(escape(text, quote=True)) > escaped_limit:
        text = text[:-1].rstrip()
    return escape(text or "…", quote=True)


def _provider_label(value: object) -> str:
    return {"rezka": "Rezka", "prowlarr": "Prowlarr"}.get(
        str(value or ""), "другой источник"
    )


def _section_buttons(_route: str) -> tuple[tuple[MediaPanelButton, ...], ...]:
    return media_browser_rows(back=_button("⬅️ Назад", "mp:plex"))


def _page(
    items: list[dict], page: int, page_size: int = _PAGE_SIZE
) -> tuple[list[dict], int, int]:
    total_pages = max(1, (len(items) + page_size - 1) // page_size)
    page = min(total_pages, max(1, page))
    start = (page - 1) * page_size
    return items[start : start + page_size], page, total_pages


def _list_buttons(
    route: str,
    page: int,
    total_pages: int,
    first_detail_route: str | None,
    parent: str = "home",
) -> tuple[tuple[MediaPanelButton, ...], ...]:
    navigation = None
    if total_pages > 1:
        navigation = media_page_navigation(
            page,
            total_pages,
            make_button=_button,
            callback_for=lambda target: f"mp:{route}-p:{target}",
            noop_callback="mp:noop",
        )
    controls = (
        ((_button("🖼 Карточки", f"mp:{first_detail_route}"),),)
        if first_detail_route
        else ()
    )
    return media_browser_rows(
        navigation=navigation,
        controls=controls,
        back=_button("⬅️ Назад", f"mp:{parent}"),
    )


def _carousel_buttons(
    routes: list[str],
    index: int,
    parent: str,
    actions: Iterable[MediaPanelButton] = (),
) -> tuple[tuple[MediaPanelButton, ...], ...]:
    if not routes:
        return media_browser_rows(back=_button("⬅️ Назад", f"mp:{parent}"))
    index = min(len(routes) - 1, max(0, index))
    navigation = media_carousel_navigation(
        routes,
        index,
        make_button=_button,
        callback_for=lambda route: f"mp:{route}",
        noop_callback="mp:noop",
    )
    return media_browser_rows(
        navigation=navigation,
        actions=actions,
        back=_button("⬅️ Назад", f"mp:{parent}"),
    )


def _card(
    text: str,
    buttons: tuple[tuple[MediaPanelButton, ...], ...],
    *,
    photo_rating_key: str | None = None,
    photo_url: str | None = None,
) -> MediaPanelCard:
    # All normal fields are bounded before interpolation. Never slice assembled
    # HTML because that could leave Telegram with an unclosed tag.
    if len(text) > 4096:
        text = "⚠️ <b>Карточка слишком большая</b>\n\nОткройте раздел ещё раз."
    return MediaPanelCard(
        text=text,
        buttons=buttons,
        photo_rating_key=photo_rating_key,
        photo_url=photo_url,
    )


def _metadata(payload: dict) -> list[dict]:
    compact_items = payload.get("items")
    if isinstance(compact_items, list):
        return [item for item in compact_items if isinstance(item, dict)]
    container = payload.get("MediaContainer")
    items = container.get("Metadata") if isinstance(container, dict) else None
    return [item for item in items or [] if isinstance(item, dict)] if isinstance(items, list) else []


def _title_for_plex_item(item: dict) -> str:
    kind = item.get("type")
    if kind == "episode":
        title = item.get("grandparentTitle") or item.get("title")
    elif kind == "season":
        title = item.get("parentTitle") or item.get("title")
    else:
        title = item.get("title")
    return str(title or "Без названия").strip()


def _episode_label(item: dict) -> str | None:
    if item.get("type") == "episode":
        season, episode = item.get("parentIndex"), item.get("index")
        if isinstance(season, int) and isinstance(episode, int):
            return f"S{season:02}E{episode:02}"
    if item.get("type") == "season" and isinstance(item.get("index"), int):
        return f"Сезон {item['index']}"
    return None


def _plex_player_name(value: object) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    name = value.strip()
    for suffix in (".local.iamstubborn.dev", ".local"):
        if name.lower().endswith(suffix):
            name = name[: -len(suffix)]
            break
    return name or None


def _plex_list_line(item: dict) -> str:
    icon = "🎬" if item.get("type") == "movie" else "📺"
    title = _html(_title_for_plex_item(item), limit=72)
    year = f" ({item['year']})" if isinstance(item.get("year"), int) else ""
    rating = item.get("rating")
    rating_text = (
        f" ⭐{float(rating):.1f}"
        if isinstance(rating, (int, float))
        and not isinstance(rating, bool)
        and rating > 0
        else ""
    )
    episode = _episode_label(item)
    episode_text = f" · {episode}" if episode and not year else ""
    return f"{icon} {title}{year}{episode_text}{rating_text}"


def _panel_from_trending(card, *, photo_rating_key: str | None) -> MediaPanelCard:
    buttons = tuple(
        tuple(
            MediaPanelButton(button.label, button.callback_data)
            for button in row
            if isinstance(button.callback_data, str)
        )
        for row in card.buttons
    )
    return _card(
        card.text,
        tuple(row for row in buttons if row),
        photo_rating_key=photo_rating_key,
        photo_url=card.photo_url,
    )


def _format_bytes(value: int) -> str:
    units = ("Б", "КиБ", "МиБ", "ГиБ", "ТиБ")
    amount = float(max(0, value))
    for unit in units:
        if amount < 1024 or unit == units[-1]:
            precision = 0 if unit in {"Б", "КиБ", "МиБ"} else 1
            return f"{amount:.{precision}f} {unit}"
        amount /= 1024
    return f"{amount:.1f} ТиБ"


def _format_duration(seconds: int) -> str:
    seconds = max(0, seconds)
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    if hours:
        return f"{hours} ч {minutes} мин"
    if minutes:
        return f"{minutes} мин {seconds} сек"
    return f"{seconds} сек"


def _plural_ru(value: int, one: str, few: str, many: str) -> str:
    if value % 10 == 1 and value % 100 != 11:
        return one
    if value % 10 in {2, 3, 4} and value % 100 not in {12, 13, 14}:
        return few
    return many


def _format_timestamp(value: object) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip().replace("Z", "+00:00")
    # PostgreSQL can serialize a zero offset as +00:00:00 through the MCP
    # transport, while datetime.fromisoformat expects +00:00.
    raw = re.sub(r"([+-]\d{2}:\d{2}):\d{2}$", r"\1", raw)
    raw = re.sub(r"^(\d{4}-\d{2}-\d{2}[ T])(\d):", r"\g<1>0\2:", raw)
    try:
        timestamp = datetime.fromisoformat(raw)
    except ValueError:
        return value.strip()
    suffix = ""
    if timestamp.tzinfo is not None:
        timestamp = timestamp.astimezone(timezone.utc)
        suffix = " UTC"
    return f"{timestamp:%d.%m.%Y, %H:%M}{suffix}"


def _usage_bar(percent: int) -> str:
    percent = min(100, max(0, percent))
    filled = min(10, max(0, round(percent / 10)))
    return "█" * filled + "░" * (10 - filled)


def _latest_episode(item: dict) -> str | None:
    episodes = item.get("known_episodes")
    if not isinstance(episodes, list):
        return None
    known = [
        (episode.get("season"), episode.get("episode"))
        for episode in episodes
        if isinstance(episode, dict)
        and isinstance(episode.get("season"), int)
        and isinstance(episode.get("episode"), int)
    ]
    if not known:
        return None
    season, episode = max(known)
    return f"S{season:02}E{episode:02}"


def _render_home() -> MediaPanelCard:
    rows = tuple(
        tuple(_button(label, f"mp:{route}") for label, route in row)
        for row in _HOME_ROWS
    )
    return _card(
        "🎬 <b>Медиа</b>\n\nВыберите раздел.",
        rows + ((_button("📺 Plex", "mp:plex"),),),
    )


def _render_plex() -> MediaPanelCard:
    return _card(
        "📺 <b>Plex</b>",
        media_browser_rows(
            actions=(
                _button("📺 Сейчас", "mp:watching"),
                _button("🆕 Новое", "mp:recent"),
                _button("🎞 Медиатека", "mp:library"),
                _button("💾 Хранилище", "mp:storage"),
            ),
            action_width=2,
            back=_button("⬅️ Назад", "mp:home"),
        ),
    )


def _media_type(code: str) -> str:
    return "movie" if code == "m" else "tv"


def _discovery_result_line(item: dict) -> str:
    icon = "🎬" if item.get("media_type") == "movie" else "📺"
    title = _html(item.get("title") or "Без названия", limit=72)
    year = f" ({item['year']})" if isinstance(item.get("year"), int) else ""
    rating = item.get("rating")
    rating_text = (
        f" ⭐{float(rating):.1f}"
        if isinstance(rating, (int, float))
        and not isinstance(rating, bool)
        and rating > 0
        else ""
    )
    return f"{icon} {title}{year}{rating_text}"


def _discovery_items(value: object, kind_code: str) -> list[dict]:
    if not isinstance(value, list):
        return []
    media_type = _media_type(kind_code)
    return [
        item
        for item in value[:10]
        if isinstance(item, dict)
        and item.get("media_type") == media_type
        and isinstance(item.get("tmdb_id"), int)
        and not isinstance(item.get("tmdb_id"), bool)
        and item["tmdb_id"] > 0
    ]


def _discovery_payload(
    ctx,
    family: str,
    kind_code: str,
    page: int,
    *,
    mode_code: str | None = None,
    genre_id: int | None = None,
) -> dict:
    arguments: dict[str, object] = {"media_type": _media_type(kind_code), "page": page}
    if family == "best":
        arguments["ranking"] = "popular" if mode_code == "p" else "top_rated"
    elif family == "premieres":
        feeds = {
            ("m", "n"): "now_playing",
            ("m", "u"): "upcoming",
            ("t", "o"): "on_the_air",
            ("t", "a"): "airing_today",
        }
        arguments["feed"] = feeds[(kind_code, mode_code)]
    elif family == "discover":
        arguments["genre_id"] = genre_id
    return _command_payload(ctx, _DISCOVERY_TOOLS[family], arguments)


def _discovery_filter_rows(
    family: str, kind_code: str, mode_code: str | None
) -> tuple[tuple[MediaPanelButton, ...], ...]:
    if family == "best":
        type_row = tuple(
            _button(
                f"{'✅ ' if code == kind_code else ''}{label}",
                "mp:noop" if code == kind_code else f"mp:best:{code}:{mode_code}:1",
            )
            for code, label in (("m", "Фильмы"), ("t", "Сериалы"))
        )
        rank_row = tuple(
            _button(
                f"{'✅ ' if code == mode_code else ''}{label}",
                "mp:noop" if code == mode_code else f"mp:best:{kind_code}:{code}:1",
            )
            for code, label in (("r", "Лучшее"), ("p", "Популярное"))
        )
        return (type_row, rank_row)
    valid_modes = (("n", "В кино"), ("u", "Скоро")) if kind_code == "m" else (
        ("o", "В эфире"),
        ("a", "Сегодня"),
    )
    type_row = tuple(
        _button(
            f"{'✅ ' if code == kind_code else ''}{label}",
            (
                "mp:noop"
                if code == kind_code
                else f"mp:prem:{code}:{'n' if code == 'm' else 'o'}:1"
            ),
        )
        for code, label in (("m", "Фильмы"), ("t", "Сериалы"))
    )
    feed_row = tuple(
        _button(
            f"{'✅ ' if code == mode_code else ''}{label}",
            "mp:noop" if code == mode_code else f"mp:prem:{kind_code}:{code}:1",
        )
        for code, label in valid_modes
    )
    return (type_row, feed_row)


def _discovery_list_buttons(
    family: str,
    kind_code: str,
    mode_code: str | None,
    page: int,
    total_pages: int,
    items: list[dict],
    *,
    genre_id: int | None = None,
) -> tuple[tuple[MediaPanelButton, ...], ...]:
    if family == "discover":
        list_route = f"discover:{kind_code}:{genre_id}"
        detail_prefix = f"discover-key:{kind_code}:{genre_id}"
        back_route = f"genres:{kind_code}"
        filters: tuple[tuple[MediaPanelButton, ...], ...] = ()
    else:
        route_prefix = "best" if family == "best" else "prem"
        list_route = f"{route_prefix}:{kind_code}:{mode_code}"
        detail_prefix = f"{route_prefix}-key:{kind_code}:{mode_code}"
        back_route = "home"
        filters = _discovery_filter_rows(family, kind_code, mode_code)
    navigation = None
    if total_pages > 1:
        navigation = media_page_navigation(
            page,
            total_pages,
            make_button=_button,
            callback_for=lambda target: f"mp:{list_route}:{target}",
            noop_callback="mp:noop",
        )
    controls = list(filters)
    if items:
        tmdb_id = items[0].get("tmdb_id")
        if isinstance(tmdb_id, int) and tmdb_id > 0:
            controls.append((
                _button("🖼 Карточки", f"mp:{detail_prefix}:{page}:0:{tmdb_id}"),
            ))
    return media_browser_rows(
        navigation=navigation,
        controls=controls,
        back=_button("⬅️ Назад", f"mp:{back_route}"),
    )


def _render_discovery_list(
    ctx,
    family: str,
    kind_code: str,
    mode_code: str | None,
    page: int,
    *,
    genre_id: int | None = None,
) -> MediaPanelCard:
    payload = _discovery_payload(
        ctx, family, kind_code, page, mode_code=mode_code, genre_id=genre_id
    )
    items = _discovery_items(payload.get("results"), kind_code)
    actual_page = payload.get("page")
    total_pages = payload.get("total_pages")
    page = actual_page if isinstance(actual_page, int) and actual_page > 0 else page
    total_pages = total_pages if isinstance(total_pages, int) and total_pages > 0 else 1
    if items:
        text = "\n".join(_discovery_result_line(item) for item in items)
    else:
        text = "Подходящих релизов пока нет."
    poster = items[0].get("poster_url") if items else None
    return _card(
        text,
        _discovery_list_buttons(
            family,
            kind_code,
            mode_code,
            page,
            total_pages,
            items,
            genre_id=genre_id,
        ),
        photo_url=poster if isinstance(poster, str) else None,
    )


def _render_discovery_detail(
    ctx,
    family: str,
    kind_code: str,
    mode_code: str | None,
    page: int,
    index: int,
    tmdb_id: int,
    *,
    genre_id: int | None = None,
) -> MediaPanelCard:
    payload = _discovery_payload(
        ctx, family, kind_code, page, mode_code=mode_code, genre_id=genre_id
    )
    items = _discovery_items(payload.get("results"), kind_code)
    if index >= len(items) or items[index].get("tmdb_id") != tmdb_id:
        return _card(
            "⚠️ <b>Карточка устарела</b>\n\nОткройте список заново.",
            ((
                _button(
                    "⬅️ Назад",
                    _discovery_back_route(
                        family, kind_code, mode_code, page, genre_id
                    ),
                ),
            ),),
        )
    details = _command_payload(
        ctx,
        "mcp__media_admin__media_details",
        {"media_type": _media_type(kind_code), "tmdb_id": tmdb_id},
    )
    item = {**items[index], **details}
    prefix = _discovery_detail_prefix(family, kind_code, mode_code, page, genre_id)
    detail_routes = [
        f"{prefix}:{position}:{value['tmdb_id']}"
        for position, value in enumerate(items)
    ]
    rendered = render_direct_details(
        item,
        navigation_routes=tuple(f"mp:{route}" for route in detail_routes),
        navigation_index=index,
        back_callback=_discovery_back_route(family, kind_code, mode_code, page, genre_id),
    )
    if rendered:
        return _panel_from_trending(rendered, photo_rating_key=None)
    return _card(
        _discovery_result_line(item),
        ((
            _button(
                "⬅️ Назад",
                _discovery_back_route(family, kind_code, mode_code, page, genre_id),
            ),
        ),),
        photo_url=(
            item.get("poster_url")
            if isinstance(item.get("poster_url"), str)
            else None
        ),
    )


def _discovery_back_route(
    family: str,
    kind_code: str,
    mode_code: str | None,
    page: int,
    genre_id: int | None,
) -> str:
    if family == "discover":
        return f"mp:discover:{kind_code}:{genre_id}:{page}"
    prefix = "best" if family == "best" else "prem"
    return f"mp:{prefix}:{kind_code}:{mode_code}:{page}"


def _discovery_detail_prefix(
    family: str,
    kind_code: str,
    mode_code: str | None,
    page: int,
    genre_id: int | None,
) -> str:
    if family == "discover":
        return f"discover-key:{kind_code}:{genre_id}:{page}"
    prefix = "best-key" if family == "best" else "prem-key"
    return f"{prefix}:{kind_code}:{mode_code}:{page}"


def _render_genres(ctx, kind_code: str = "m") -> MediaPanelCard:
    payload = _command_payload(
        ctx, _DISCOVERY_TOOLS["genres"], {"media_type": _media_type(kind_code)}
    )
    raw_genres = payload.get("genres")
    genres = (
        [genre for genre in raw_genres if isinstance(genre, dict)]
        if isinstance(raw_genres, list)
        else []
    )
    controls: tuple[tuple[MediaPanelButton, ...], ...] = (
        tuple(
            _button(
                f"{'✅ ' if code == kind_code else ''}{label}",
                "mp:noop" if code == kind_code else f"mp:genres:{code}",
            )
            for code, label in (("m", "Фильмы"), ("t", "Сериалы"))
        ),
    )
    genre_buttons = [
        _button(
            f"🎭 {_button_label(genre.get('name') or 'Жанр')}",
            f"mp:discover:{kind_code}:{genre['id']}:1",
        )
        for genre in genres
        if isinstance(genre.get("id"), int) and genre.get("id") > 0
    ]
    rows = media_browser_rows(
        controls=controls,
        actions=genre_buttons,
        action_width=2,
        back=_button("⬅️ Назад", "mp:home"),
    )
    text = "🎭 <b>По жанрам</b>\n\nВыберите жанр."
    return _card(text, rows)


def _watching_payload(ctx) -> list[dict]:
    payload = _command_payload(ctx, "mcp__media_admin__plex_now_playing", {})
    return _metadata(payload)


def _render_watching(ctx, page: int = 1) -> MediaPanelCard:
    items, page, total_pages = _page(_watching_payload(ctx), page)
    if not items:
        text = "📺 <b>Сейчас смотрят</b>\n\nВ Plex сейчас ничего не воспроизводится."
    else:
        lines = ["📺 <b>Сейчас смотрят</b>", ""]
        for item in items:
            title = _html(_title_for_plex_item(item), limit=120)
            episode = _episode_label(item)
            user = item.get("User")
            player = item.get("Player")
            details = []
            if episode:
                details.append(episode)
            if isinstance(user, dict) and user.get("title"):
                details.append(_html(user["title"], limit=60))
            if isinstance(player, dict):
                state = {"playing": "смотрит", "paused": "пауза", "buffering": "буферизация"}.get(player.get("state"))
                if state:
                    details.append(state)
            suffix = f" · {' · '.join(details)}" if details else ""
            lines.append(f"📺 {title}{suffix}")
        text = "\n".join(lines)
    rating_keys = [
        str(item.get("ratingKey"))
        for item in items
        if str(item.get("ratingKey") or "").isdigit()
    ]
    first_route = f"watching-key:{rating_keys[0]}:{page}" if rating_keys else None
    return _card(
        text,
        _list_buttons("watching", page, total_pages, first_route, "plex"),
        photo_rating_key=rating_keys[0] if rating_keys else None,
    )


def _render_watching_detail(ctx, rating_key: str, page: int = 1) -> MediaPanelCard:
    all_items = _watching_payload(ctx)
    items, page, _ = _page(all_items, page)
    item = next(
        (value for value in items if str(value.get("ratingKey") or "") == rating_key),
        None,
    )
    if item is None:
        return _card(
            "⚠️ <b>Просмотр завершён</b>\n\nОбновите список текущих просмотров.",
            ((_button("⬅️ Назад", f"mp:watching-p:{page}"),),),
        )
    title = _html(_title_for_plex_item(item), limit=180)
    lines = [f"📺 <b>{title}</b>"]
    episode = _episode_label(item)
    if episode:
        lines.append(f"🔔 {episode}")
    user = item.get("User")
    if isinstance(user, dict) and user.get("title"):
        lines.append(f"👤 Профиль Plex: <b>{_html(user['title'], limit=80)}</b>")
    player = item.get("Player")
    if isinstance(player, dict):
        state = {
            "playing": "воспроизводится",
            "paused": "пауза",
            "buffering": "буферизация",
        }.get(player.get("state"))
        if state:
            lines.append(f"▶️ {state}")
        player_name = _plex_player_name(player.get("title"))
        if player_name:
            lines.append(f"📺 Устройство: <b>{_html(player_name, limit=100)}</b>")
    routes = [
        f"watching-key:{value['ratingKey']}:{page}"
        for value in items
        if str(value.get("ratingKey") or "").isdigit()
    ]
    current = routes.index(f"watching-key:{rating_key}:{page}") if routes else 0
    return _card(
        "\n".join(lines),
        _carousel_buttons(routes, current, f"watching-p:{page}"),
        photo_rating_key=rating_key,
    )


def _recent_payload(
    ctx, focus_rating_key: str | None = None
) -> tuple[dict, list[dict]]:
    arguments: dict[str, int] = {"limit": 50}
    if focus_rating_key and focus_rating_key.isdigit():
        arguments["rating_key"] = int(focus_rating_key)
    payload = _command_payload(ctx, "mcp__media_admin__plex_recent", arguments)
    return payload, _metadata(payload)


def _render_recent(ctx, page: int = 1) -> MediaPanelCard:
    _, all_items = _recent_payload(ctx)
    items, page, total_pages = _page(all_items, page)
    if not items:
        return _card(
            "🆕 <b>Новое в Plex</b>\n\nНедавно добавленных материалов нет.",
            _list_buttons("recent", page, total_pages, None, "plex"),
        )
    lines = [_plex_list_line(item) for item in items]
    rating_keys = [
        str(item.get("ratingKey"))
        for item in items
        if str(item.get("ratingKey") or "").isdigit()
    ]
    first_route = f"recent-key:{rating_keys[0]}:{page}" if rating_keys else None
    return _card(
        "\n".join(lines),
        _list_buttons("recent", page, total_pages, first_route, "plex"),
        photo_rating_key=rating_keys[0] if rating_keys else None,
        photo_url=(
            items[0].get("poster_url")
            if isinstance(items[0].get("poster_url"), str)
            else None
        ),
    )


def _render_recent_detail(ctx, rating_key: str, page: int = 1) -> MediaPanelCard:
    _, recent_items = _recent_payload(ctx, rating_key)
    item = next(
        (
            dict(value)
            for value in recent_items
            if str(value.get("ratingKey") or "") == rating_key
        ),
        None,
    )
    if item is None:
        return _card(
            "⚠️ <b>Материал больше не доступен</b>\n\nОбновите список нового в Plex.",
            ((_button("⬅️ Назад", f"mp:recent-p:{page}"),),),
        )

    page_items, page, _ = _page(recent_items, page)
    routes = [
        f"recent-key:{value['ratingKey']}:{page}"
        for value in page_items
        if str(value.get("ratingKey") or "").isdigit()
    ]
    current_route = f"recent-key:{rating_key}:{page}"
    if current_route not in routes:
        routes.insert(0, current_route)
    current = routes.index(current_route) if current_route in routes else 0
    media_type = "movie" if item.get("type") == "movie" else "tv"
    direct_item = {
        **item,
        "media_type": item.get("media_type") or media_type,
        "title": item.get("title") or _title_for_plex_item(item),
        "original_title": item.get("original_title") or item.get("originalTitle"),
        "overview": item.get("overview") or item.get("summary"),
    }
    rendered = render_direct_details(
        direct_item,
        navigation_routes=tuple(f"mp:{route}" for route in routes),
        navigation_index=current,
        back_callback=f"mp:recent-p:{page}",
    )
    if rendered is not None:
        return _panel_from_trending(rendered, photo_rating_key=rating_key)
    return _card(
        _plex_list_line(item),
        _carousel_buttons(routes, current, f"recent-p:{page}"),
        photo_rating_key=rating_key,
    )


def _render_library(ctx) -> MediaPanelCard:
    payload = _command_payload(ctx, "mcp__media_admin__plex_library_summary", {})
    sections = payload.get("sections")
    sections = sections[:10] if isinstance(sections, list) else []
    lines = ["📚 <b>Библиотека Plex</b>", "", "Выберите раздел:"]
    labels = {"movie": "🎬 Фильмы", "show": "📺 Сериалы"}
    buttons: list[MediaPanelButton] = []
    for section in sections:
        if not isinstance(section, dict):
            continue
        title, count, section_key = (
            section.get("title"),
            section.get("item_count"),
            section.get("section_key"),
        )
        if (
            not isinstance(title, str)
            or not isinstance(count, int)
            or not isinstance(section_key, int)
            or section_key <= 0
        ):
            continue
        label = labels.get(section.get("type"), f"📁 {_html(title, limit=80)}")
        lines.append(f"{label}: <b>{count}</b>")
        buttons.append(
            _button(f"{label} · {count}", f"mp:library-section:{section_key}:1")
        )
    if len(lines) == 3:
        lines.append("Подключённые библиотеки не найдены.")
    rows = media_browser_rows(
        actions=buttons,
        action_width=2,
        back=_button("⬅️ Назад", "mp:plex"),
    )
    return _card("\n".join(lines), rows)


def _library_payload(
    ctx,
    section_key: int,
    page: int,
    focus_rating_key: str | None = None,
) -> tuple[dict, list[dict], int, int]:
    page = max(1, page)
    arguments: dict[str, int] = {
        "section_key": section_key,
        "start": (page - 1) * _PAGE_SIZE,
        "limit": _PAGE_SIZE,
    }
    if focus_rating_key and focus_rating_key.isdigit():
        arguments["rating_key"] = int(focus_rating_key)
    payload = _command_payload(ctx, "mcp__media_admin__plex_library_items", arguments)
    container = payload.get("MediaContainer")
    total = container.get("totalSize") if isinstance(container, dict) else None
    items = _metadata(payload)
    total_items = total if isinstance(total, int) and total >= 0 else len(items)
    total_pages = max(1, (total_items + _PAGE_SIZE - 1) // _PAGE_SIZE)
    page = min(page, total_pages)
    return payload, items, page, total_pages


def _library_list_buttons(
    section_key: int,
    page: int,
    total_pages: int,
    first_route: str | None,
) -> tuple[tuple[MediaPanelButton, ...], ...]:
    navigation = None
    if total_pages > 1:
        navigation = media_page_navigation(
            page,
            total_pages,
            make_button=_button,
            callback_for=lambda target: (
                f"mp:library-section:{section_key}:{target}"
            ),
            noop_callback="mp:noop",
        )
    controls = (
        ((_button("🖼 Карточки", f"mp:{first_route}"),),)
        if first_route
        else ()
    )
    return media_browser_rows(
        navigation=navigation,
        controls=controls,
        back=_button("⬅️ Назад", "mp:library"),
    )


def _render_library_section(ctx, section_key: int, page: int) -> MediaPanelCard:
    _, items, page, total_pages = _library_payload(ctx, section_key, page)
    if not items:
        return _card(
            "📚 <b>Раздел библиотеки пуст</b>",
            _library_list_buttons(section_key, page, total_pages, None),
        )
    routes = [
        f"library-key:{section_key}:{item['ratingKey']}:{page}"
        for item in items
        if str(item.get("ratingKey") or "").isdigit()
    ]
    return _card(
        "\n".join(_plex_list_line(item) for item in items),
        _library_list_buttons(
            section_key,
            page,
            total_pages,
            routes[0] if routes else None,
        ),
        photo_rating_key=(str(items[0].get("ratingKey")) if routes else None),
    )


def _render_library_detail(
    ctx,
    section_key: int,
    rating_key: str,
    page: int,
) -> MediaPanelCard:
    _, items, page, _ = _library_payload(ctx, section_key, page, rating_key)
    item = next(
        (dict(value) for value in items if str(value.get("ratingKey") or "") == rating_key),
        None,
    )
    if item is None:
        return _card(
            "⚠️ <b>Материал больше не доступен</b>\n\nВернитесь к списку библиотеки.",
            ((_button("⬅️ Назад", f"mp:library-section:{section_key}:{page}"),),),
        )
    routes = [
        f"library-key:{section_key}:{value['ratingKey']}:{page}"
        for value in items
        if str(value.get("ratingKey") or "").isdigit()
    ]
    current_route = f"library-key:{section_key}:{rating_key}:{page}"
    if current_route not in routes:
        routes.insert(0, current_route)
    current = routes.index(current_route)
    media_type = "movie" if item.get("type") == "movie" else "tv"
    rendered = render_direct_details(
        {
            **item,
            "media_type": item.get("media_type") or media_type,
            "title": item.get("title") or _title_for_plex_item(item),
            "original_title": item.get("original_title") or item.get("originalTitle"),
            "overview": item.get("overview") or item.get("summary"),
        },
        navigation_routes=tuple(f"mp:{route}" for route in routes),
        navigation_index=current,
        back_callback=f"mp:library-section:{section_key}:{page}",
    )
    if rendered is not None:
        return _panel_from_trending(rendered, photo_rating_key=rating_key)
    return _card(
        _plex_list_line(item),
        _carousel_buttons(routes, current, f"library-section:{section_key}:{page}"),
        photo_rating_key=rating_key,
    )


def _render_storage(ctx) -> MediaPanelCard:
    payload = _command_payload(ctx, "mcp__media_admin__media_storage_status", {})
    roots = payload.get("roots")
    roots = roots if isinstance(roots, list) else []
    grouped: dict[tuple[int, int], list[str]] = {}
    for root in roots:
        if not isinstance(root, dict):
            continue
        total, available = root.get("total_bytes"), root.get("available_bytes")
        if isinstance(total, int) and isinstance(available, int):
            paths = grouped.setdefault((total, available), [])
            path = root.get("path")
            if isinstance(path, str):
                paths.append(path.lower())
    lines = ["💾 <b>Хранилище</b>", ""]
    for index, ((total, available), paths) in enumerate(list(grouped.items())[:10], start=1):
        used_percent = round((total - available) * 100 / total) if total else 0
        root_count = max(1, len(paths))
        if any("usb" in path for path in paths):
            label = "USB-архив"
        elif any("internal" in path for path in paths):
            label = "Внутреннее хранилище"
        else:
            label = "Общее хранилище" if len(grouped) == 1 else f"Диск {index}"
        suffix = (
            f" · {root_count} "
            f"{_plural_ru(root_count, 'каталог', 'каталога', 'каталогов')}"
            if root_count > 1
            else ""
        )
        lines.extend(
            (
                f"<b>{label}</b>{suffix}",
                f"<code>{_usage_bar(used_percent)}</code> {used_percent}%",
                f"свободно {_format_bytes(available)} из {_format_bytes(total)} · занято {used_percent}%",
                "",
            )
        )
    if not grouped:
        lines.append("Данные о дисках недоступны.")
    return _card("\n".join(lines).rstrip(), _section_buttons("storage"))


_MAX_MCP_LIST_PAGES = 100


def _paged_payload(ctx, tool: str, key: str, view: str) -> list[dict]:
    items: list[dict] = []
    cursor = None
    seen_cursors: set[str] = set()
    for _ in range(_MAX_MCP_LIST_PAGES):
        arguments = {"limit": 50, "view": view}
        if cursor is not None:
            arguments["cursor"] = cursor
        payload = _command_payload(ctx, tool, arguments)
        page = payload.get(key)
        if isinstance(page, list):
            items.extend(item for item in page if isinstance(item, dict))
        next_cursor = payload.get("next_cursor")
        if not isinstance(next_cursor, str) or not next_cursor:
            return items
        if next_cursor in seen_cursors:
            raise ValueError("media tool returned a cyclic cursor")
        seen_cursors.add(next_cursor)
        cursor = next_cursor
    raise ValueError("media tool pagination limit exceeded")


def _jobs_payload(ctx) -> list[dict]:
    return _paged_payload(
        ctx, "mcp__media_admin__media_jobs_list", "jobs", "card"
    )


def _job_media_label(job: dict) -> str | None:
    season = job.get("season")
    episode = job.get("episode")
    if isinstance(season, int) and isinstance(episode, int):
        return f"S{season:02}E{episode:02}"
    if isinstance(season, int):
        count = job.get("episode_count")
        return (
            f"Сезон {season} · {count} "
            f"{_plural_ru(count, 'серия', 'серии', 'серий')}"
            if isinstance(count, int) and count > 0
            else f"Сезон {season}"
        )
    return None


def _job_list_media_label(job: dict) -> str | None:
    season = job.get("season")
    episode = job.get("episode")
    if isinstance(season, int) and isinstance(episode, int):
        return f"S{season:02}E{episode:02}"
    if isinstance(season, int):
        count = job.get("episode_count")
        return (
            f"S{season} · {count} эп."
            if isinstance(count, int) and count > 0
            else f"S{season}"
        )
    return None


def _job_list_provider_icon(job: dict) -> str:
    return "🌐" if job.get("provider") == "rezka" else "🧲"


def _job_list_media_icon(job: dict) -> str:
    media_kind = job.get("media_kind")
    if media_kind == "movie":
        return "🎬"
    if media_kind in {"series", "tv", "show"}:
        return "📺"
    if any(isinstance(job.get(key), int) for key in ("season", "episode", "episode_count")):
        return "📺"
    return "🎬"


def _translation_label(job: dict) -> str | None:
    translation = job.get("translation")
    if isinstance(translation, str) and translation.strip():
        return f"🎙 {translation.strip()}"
    if job.get("provider") == "prowlarr":
        return "🎙 Озвучки в релизе"
    return None


def _legacy_rezka_alias_title(title: str) -> str:
    """Collapse old Rezka job titles that predate persisted library_title."""
    aliases = title.split(" / ")
    if len(aliases) < 2:
        return title
    parsed_aliases: list[tuple[str, str]] = []
    for alias in aliases:
        base, separator, suffix = alias.rpartition(": ")
        if not separator or not base.strip() or not suffix.strip():
            return title
        parsed_aliases.append((base.strip(), suffix.strip()))
    normalized_suffix = parsed_aliases[0][1].casefold()
    if any(
        suffix.casefold() != normalized_suffix
        for _, suffix in parsed_aliases[1:]
    ):
        return title
    return aliases[-1].strip()


def _job_filter_code(job: dict) -> str:
    return "t" if _job_list_media_icon(job) == "📺" else "m"


def _filtered_jobs(jobs: list[dict], filter_code: str) -> list[dict]:
    if filter_code not in {"m", "t"}:
        return jobs
    return [job for job in jobs if _job_filter_code(job) == filter_code]


def _downloads_route(filter_code: str, page: int) -> str:
    return (
        f"downloads-{filter_code}-p:{page}"
        if filter_code in {"m", "t"}
        else f"downloads-p:{page}"
    )


def _job_route(prefix: str, job_id: str, page: int, filter_code: str) -> str:
    suffix = f":{filter_code}" if filter_code in {"m", "t"} else ""
    return f"{prefix}:{job_id}:{page}{suffix}"


def _downloads_filter_rows(
    filter_code: str,
) -> tuple[tuple[MediaPanelButton, ...], ...]:
    return (tuple(
        _button(
            f"{'✅ ' if code == filter_code else ''}{label}",
            "mp:noop" if code == filter_code else f"mp:{_downloads_route(code, 1)}",
        )
        for code, label in (
            ("a", "Все"),
            ("m", "🎬 Фильмы"),
            ("t", "📺 Сериалы"),
        )
    ),)


def _job_title(job: dict) -> str:
    title = job.get("library_title") or job.get("title")
    if isinstance(title, str) and title.strip():
        title = title.strip()
        return (
            title
            if isinstance(job.get("library_title"), str)
            and job["library_title"].strip()
            else (
                _legacy_rezka_alias_title(title)
                if job.get("provider") == "rezka"
                else title
            )
        )
    return (
        "Загрузка из Rezka"
        if job.get("provider") == "rezka"
        else "Торрент-загрузка"
    )


def _job_list_line(job: dict, *, compact: bool = False) -> str:
    state = str(job.get("state") or "")
    icon = _STATE_ICONS.get(state, "📦")
    title = (
        escape(_job_title(job)[:28].rstrip(), quote=True)
        if compact
        else escape(_job_title(job), quote=True)
    )
    progress = job.get("progress")
    percent = progress.get("progress_percent") if isinstance(progress, dict) else None
    provider = _provider_label(job.get("provider"))
    translation_label = _translation_label(job) if not compact else None
    media_label = _job_list_media_label(job)
    details = [
        value
        for value in (
            provider,
            None if compact else translation_label,
            None if compact or media_label is None else f"📺 {media_label}",
            (
                None
                if compact or not isinstance(percent, int)
                else f"📊 {min(100, max(0, percent))}%"
            ),
        )
        if value
    ]
    metadata = " · ".join(details)
    return (
        f"{icon} {_job_list_media_icon(job)} {title}\n"
        f"{_job_list_provider_icon(job)} {escape(metadata, quote=True)}"
    )


def _sorted_jobs(ctx) -> list[dict]:
    jobs = _jobs_payload(ctx)
    # The API already returns newest first. Only move genuinely live work to
    # the front; stale failures and storage blocks remain in history order.
    return [job for job in jobs if job.get("state") in _LIVE_JOB_STATES] + [
        job for job in jobs if job.get("state") not in _LIVE_JOB_STATES
    ]


def _downloads_buttons(
    filter_code: str,
    page: int,
    total_pages: int,
    first_detail_route: str | None,
) -> tuple[tuple[MediaPanelButton, ...], ...]:
    navigation = None
    if total_pages > 1:
        navigation = media_page_navigation(
            page,
            total_pages,
            make_button=_button,
            callback_for=lambda target: f"mp:{_downloads_route(filter_code, target)}",
            noop_callback="mp:noop",
        )
    controls = list(_downloads_filter_rows(filter_code))
    if first_detail_route:
        controls.append((_button("🖼 Карточки", f"mp:{first_detail_route}"),))
    return media_browser_rows(
        navigation=navigation,
        controls=controls,
        back=_button("⬅️ Назад", "mp:home"),
    )


def _render_downloads(
    ctx, page: int = 1, filter_code: str = "a"
) -> MediaPanelCard:
    queue = _command_payload(ctx, "mcp__media_admin__media_queue_status", {})
    all_jobs = _sorted_jobs(ctx)
    jobs = _filtered_jobs(all_jobs, filter_code)
    queued = queue.get("queued") if isinstance(queue.get("queued"), int) else 0
    active = queue.get("active") is True
    runner = "Занят" if active else "Готов"
    live_count = sum(job.get("state") in _LIVE_JOB_STATES for job in all_jobs)
    lines = [
        "⬇️ <b>Загрузки</b>",
        "",
        f"{'🟢' if not active and queued == 0 else '🟡'} <b>{runner}</b> · "
        f"▶️ {live_count} · 🕒 {queued}",
    ]
    visible_jobs, page, total_pages = _page(jobs, page, _DOWNLOADS_PAGE_SIZE)
    if visible_jobs:
        lines.append("")
        lines.append("\n\n".join(_job_list_line(job) for job in visible_jobs))
        if len("\n".join(lines)) > 1024:
            lines = lines[:4] + [
                "\n\n".join(
                    _job_list_line(job, compact=True) for job in visible_jobs
                )
            ]
    else:
        empty_copy = (
            "В этом фильтре задач нет."
            if filter_code in {"m", "t"}
            else "Задач пока нет."
        )
        lines.extend(("", empty_copy))
    job_ids = [
        str(job.get("id"))
        for job in visible_jobs
        if isinstance(job.get("id"), str) and job.get("id")
    ]
    first_route = (
        _job_route("job", job_ids[0], page, filter_code) if job_ids else None
    )
    return _card(
        "\n".join(lines),
        _downloads_buttons(filter_code, page, total_pages, first_route),
        photo_url=(
            visible_jobs[0].get("poster_url")
            if visible_jobs and isinstance(visible_jobs[0].get("poster_url"), str)
            else None
        ),
    )


def _render_job_detail(
    ctx,
    job_id: str,
    page: int = 1,
    filter_code: str = "a",
    *,
    state_override: str | None = None,
) -> MediaPanelCard:
    payload = _command_payload(ctx, "mcp__media_admin__media_job_get", {"job_id": job_id})
    return _render_job_payload(
        ctx,
        payload,
        job_id,
        page,
        filter_code,
        state_override=state_override,
    )


def _render_job_payload(
    ctx,
    payload: dict,
    job_id: str,
    page: int,
    filter_code: str = "a",
    *,
    state_override: str | None = None,
) -> MediaPanelCard:
    state = state_override or str(payload.get("state") or "")
    provider = _provider_label(payload.get("provider"))
    stage = str(payload.get("current_stage") or "")
    lines = [
        f"{_STATE_ICONS.get(state, '📦')} <b>{_html(_job_title(payload), limit=180)}</b>",
        "",
        f"📌 Состояние: <b>{_STATE_LABELS.get(state, 'обработка')}</b>",
        f"{_job_list_provider_icon(payload)} Источник: <b>{provider}</b>",
    ]
    media_label = _job_media_label(payload)
    if media_label:
        lines.append(
            f"{_job_list_media_icon(payload)} Выбрано: "
            f"<b>{_html(media_label, limit=80)}</b>"
        )
    translation_label = _translation_label(payload)
    if translation_label:
        lines.append(f"{_html(translation_label, limit=120)}")
    if stage:
        lines.append(
            f"🔄 Этап: <b>{_html(_STAGE_LABELS.get(stage, 'обработка'), limit=80)}</b>"
        )
    progress = payload.get("progress")
    if isinstance(progress, dict):
        percent = progress.get("progress_percent")
        downloaded, total = progress.get("downloaded_bytes"), progress.get("total_bytes")
        speed, eta = progress.get("download_speed_bps"), progress.get("eta_seconds")
        seeds = progress.get("seeds")
        if isinstance(percent, int):
            lines.append(f"📦 Прогресс: <b>{min(100, max(0, percent))}%</b>")
        if isinstance(downloaded, int):
            amount = _format_bytes(downloaded)
            if isinstance(total, int) and total > 0:
                amount += f" из {_format_bytes(total)}"
            lines.append(f"💾 Скачано: <b>{amount}</b>")
        if isinstance(speed, int) and speed >= 0:
            lines.append(f"🚀 Скорость: <b>{_format_bytes(speed)}/с</b>")
        if isinstance(eta, int) and eta >= 0:
            lines.append(f"⏳ Осталось: <b>{_format_duration(eta)}</b>")
        if isinstance(seeds, int) and seeds >= 0:
            lines.append(f"🌱 Раздающих: <b>{seeds}</b>")
    if state == "blocked_storage":
        lines.extend(
            ("", "💾 Недостаточно свободного места. Освободите диск и повторите загрузку.")
        )
    elif state == "failed":
        lines.extend(("", "Не удалось завершить загрузку. Её можно безопасно повторить."))
    elif state == "partial":
        lines.extend(
            ("", "Видео готово не полностью. Повтор загрузит только недостающие части.")
        )
    actions = []
    if state in _CANCELLABLE_JOB_STATES:
        actions.append(_button(
            "✖️ Отменить",
            f"mp:{_job_route('job-cancel', job_id, page, filter_code)}",
        ))
    elif state in _RETRYABLE_JOB_STATES:
        actions.append(_button(
            "🔁 Повторить",
            f"mp:{_job_route('job-retry', job_id, page, filter_code)}",
        ))
    jobs = _filtered_jobs(
        _sorted_jobs(ctx) if ctx is not None else [], filter_code
    )
    jobs, page, _ = _page(jobs, page, _DOWNLOADS_PAGE_SIZE)
    routes = [
        _job_route("job", str(job["id"]), page, filter_code)
        for job in jobs
        if isinstance(job.get("id"), str) and job.get("id")
    ]
    current_route = _job_route("job", job_id, page, filter_code)
    if current_route not in routes:
        routes.insert(0, current_route)
    current = routes.index(current_route) if current_route in routes else 0
    return _card(
        "\n".join(lines),
        _carousel_buttons(
            routes,
            current,
            _downloads_route(filter_code, page),
            actions,
        ),
        photo_url=payload.get("poster_url") if isinstance(payload.get("poster_url"), str) else None,
    )


def render_job_cancelling_card(
    ctx, job_id: str, page: int = 1, filter_code: str = "a"
) -> MediaPanelCard:
    """Render the regular job card with an immediate optimistic cancel state."""
    return _render_job_detail(
        ctx,
        job_id,
        page,
        filter_code,
        state_override="cancel_requested",
    )


def _job_card_overlay(
    detail: MediaPanelCard,
    heading: str,
    *,
    footer: str | None = None,
    buttons: tuple[tuple[MediaPanelButton, ...], ...] | None = None,
    state_label: str | None = None,
) -> MediaPanelCard:
    detail_text = detail.text
    if state_label is not None:
        detail_text = re.sub(
            r"📌 Состояние: <b>[^<]*</b>",
            f"📌 Состояние: <b>{_html(state_label, limit=80)}</b>",
            detail_text,
            count=1,
        )
        if detail_text.startswith("⏳ "):
            detail_text = f"⚠️ {detail_text[2:]}"
    parts = [heading, detail_text]
    if footer:
        parts.append(footer)
    return _card(
        "\n\n".join(parts),
        buttons if buttons is not None else detail.buttons,
        photo_rating_key=detail.photo_rating_key,
        photo_url=detail.photo_url,
    )


def render_job_cancel_error_card(
    ctx,
    job_id: str,
    page: int,
    message: str,
    filter_code: str = "a",
) -> MediaPanelCard:
    """Render a cancel error over the authoritative full job card."""
    detail = (
        _render_job_detail(ctx, job_id, page, filter_code)
        if ctx is not None
        else _render_job_payload(
            None,
            {"id": job_id, "state": "cancel_requested", "title": "Загрузка"},
            job_id,
            page,
            filter_code,
        )
    )
    return _job_card_overlay(
        detail,
        f"⚠️ <b>{_html(message, limit=180)}</b>",
        state_label="ошибка отмены" if ctx is None else None,
    )


def render_job_cancel_error_from_card(
    detail: MediaPanelCard, message: str
) -> MediaPanelCard:
    """Preserve the last full job shell if an authoritative refresh fails."""
    return _job_card_overlay(
        detail,
        f"⚠️ <b>{_html(message, limit=180)}</b>",
        state_label="ошибка отмены",
    )


def _business_action_generation(payload: dict) -> str | None:
    lifecycle_cycle = payload.get("lifecycle_cycle")
    if (
        not isinstance(lifecycle_cycle, int)
        or isinstance(lifecycle_cycle, bool)
        or lifecycle_cycle < 1
    ):
        return None
    return hashlib.blake2s(
        str(lifecycle_cycle).encode("ascii"), digest_size=4
    ).hexdigest()


def _business_action_callback(action: str, job_id: str, payload: dict) -> str:
    generation = _business_action_generation(payload)
    if generation is None:
        return f"ma:{action}:{job_id}"
    return f"ma:{action}:{job_id}:{generation}"


def _render_job_cancel_confirmation(
    ctx, job_id: str, page: int = 1, filter_code: str = "a"
) -> MediaPanelCard:
    payload = _command_payload(ctx, "mcp__media_admin__media_job_get", {"job_id": job_id})
    state = str(payload.get("state") or "")
    detail = _render_job_payload(ctx, payload, job_id, page, filter_code)
    if state not in _CANCELLABLE_JOB_STATES:
        return _job_card_overlay(
            detail,
            "ℹ️ <b>Отмена уже недоступна</b>",
            footer="Состояние загрузки изменилось.",
        )
    confirm_route = f"mp:{_job_route('job-cancel', job_id, page, filter_code)}"
    buttons = tuple(
        (
            _button(
                "↩️ К задаче",
                f"mp:{_job_route('job', job_id, page, filter_code)}",
            ),
            _button(
                "✖️ Отменить",
                _business_action_callback("cancel", job_id, payload),
            ),
        )
        if any(button.callback_data == confirm_route for button in row)
        else row
        for row in detail.buttons
    )
    return _job_card_overlay(
        detail,
        "⚠️ <b>Отменить загрузку?</b>",
        footer="Временные файлы удалятся позже.",
        buttons=buttons,
    )


def _render_job_retry_confirmation(
    ctx, job_id: str, page: int = 1, filter_code: str = "a"
) -> MediaPanelCard:
    payload = _command_payload(ctx, "mcp__media_admin__media_job_get", {"job_id": job_id})
    state = str(payload.get("state") or "")
    detail = _render_job_payload(ctx, payload, job_id, page, filter_code)
    if state not in _RETRYABLE_JOB_STATES:
        return _job_card_overlay(
            detail,
            "ℹ️ <b>Повтор уже недоступен</b>",
            footer="Состояние загрузки изменилось.",
        )
    confirm_route = f"mp:{_job_route('job-retry', job_id, page, filter_code)}"
    buttons = tuple(
        (
            _button(
                "↩️ К задаче",
                f"mp:{_job_route('job', job_id, page, filter_code)}",
            ),
            _button(
                "🔁 Повторить",
                _business_action_callback("retry", job_id, payload),
            ),
        )
        if any(button.callback_data == confirm_route for button in row)
        else row
        for row in detail.buttons
    )
    return _job_card_overlay(
        detail,
        "🔁 <b>Повторить загрузку?</b>",
        footer="Будет создана новая попытка; предыдущая останется в истории.",
        buttons=buttons,
    )


def _tracking_payload(ctx) -> list[dict]:
    return _paged_payload(
        ctx, "mcp__media_admin__media_tracking_list", "tracking", "card"
    )


def _render_tracking(ctx, page: int = 1) -> MediaPanelCard:
    items, page, total_pages = _page(_tracking_payload(ctx), page)
    lines = ["🔔 <b>Подписки</b>", ""]
    for item in items:
        title = _bounded_html(
            item.get("title") or "Без названия", limit=80, escaped_limit=56
        )
        latest = _latest_episode(item)
        suffix = f" · {latest}" if latest else ""
        autodownload = isinstance(item.get("download"), dict)
        mode = "авто" if autodownload else "уведомления"
        scope = "семейная" if item.get("scope") == "family" else "личная"
        lines.append(
            f"{'⬇️' if autodownload else '🔔'} <b>{title}</b>{suffix} · {mode} · {scope}"
        )
    if len("\n".join(lines)) > 1024:
        lines = ["🔔 <b>Подписки</b>", ""] + [
            f"{'⬇️' if isinstance(item.get('download'), dict) else '🔔'} "
            f"<b>{_bounded_html(item.get('title') or 'Без названия', limit=60, escaped_limit=52)}</b>"
            for item in items
        ]
    if not items:
        lines.append("Активных подписок нет.")
    tracking_ids = [
        str(item.get("id"))
        for item in items
        if isinstance(item.get("id"), str) and item.get("id")
    ]
    first_route = f"tracking:{tracking_ids[0]}:{page}" if tracking_ids else None
    return _card(
        "\n".join(lines),
        _list_buttons("tracking", page, total_pages, first_route),
        photo_url=(
            items[0].get("poster_url")
            if items and isinstance(items[0].get("poster_url"), str)
            else None
        ),
    )


def _tracking_check_revision(item: dict) -> str:
    state = repr((
        item.get("last_checked_at"),
        item.get("check_status"),
    ))
    return hashlib.blake2s(state.encode("utf-8"), digest_size=4).hexdigest()


def _render_tracking_detail(
    ctx,
    tracking_id: str,
    page: int = 1,
    *,
    check_scheduled: bool = False,
) -> MediaPanelCard:
    all_items = _tracking_payload(ctx)
    item = next((value for value in all_items if value.get("id") == tracking_id), None)
    if item is None:
        return _card(
            "⚠️ <b>Подписка не найдена</b>\n\nВозможно, она была изменена или удалена.",
            ((_button("⬅️ Назад", f"mp:tracking-p:{page}"),),),
        )
    title = _html(item.get("title") or "Без названия", limit=180)
    latest = _latest_episode(item) or "пока неизвестна"
    scope = "семейная" if item.get("scope") == "family" else "личная"
    autodownload = isinstance(item.get("download"), dict)
    provider = _provider_label(item.get("provider"))
    translation = item.get("translation")
    raw_status = item.get("check_status")
    status = {
        "never": "ещё не проверялась",
        "no_new_episode": "новых серий нет",
        "awaiting_source": "ожидает появления в источнике",
        "episode_found": "найдена новая серия",
        "download_queued": "загрузка добавлена в очередь",
        "release_error": "не удалось проверить расписание",
        "source_error": "источник временно недоступен",
    }.get(raw_status, "статус недоступен")
    lines = [
        f"🔔 <b>{title}</b>",
        "",
        f"📺 Последняя известная: <b>{latest}</b>",
        f"👥 Область: <b>{scope}</b>",
        f"{'⬇️' if autodownload else '🔔'} Режим: <b>{'скачивать новые серии' if autodownload else 'только уведомлять'}</b>",
    ]
    if autodownload:
        lines.append(f"🌐 Источник загрузки: <b>{provider}</b>")
    if (
        autodownload
        and isinstance(translation, str)
        and translation.strip()
        and translation != "release-calendar"
    ):
        lines.append(f"🎙 Озвучка: <b>{_html(translation, limit=120)}</b>")
    if check_scheduled:
        lines.append("⏳ Статус: <b>проверка запланирована</b>")
    else:
        status_icon = "✅" if raw_status in {
            "never",
            "no_new_episode",
            "awaiting_source",
            "episode_found",
            "download_queued",
            "release_error",
            "source_error",
        } else "⚠️"
        lines.append(
            f"{status_icon} Проверка: <b>{_html(status, limit=100)}</b>"
        )
    next_check = _format_timestamp(item.get("next_check_at"))
    if next_check:
        lines.append(f"🕒 Следующая: <b>{_html(next_check, limit=80)}</b>")
    target_index = next(
        index for index, value in enumerate(all_items) if value.get("id") == tracking_id
    )
    page = target_index // _PAGE_SIZE + 1
    items, page, _ = _page(all_items, page)
    routes = [
        f"tracking:{value['id']}:{page}"
        for value in items
        if isinstance(value.get("id"), str) and value.get("id")
    ]
    current_route = f"tracking:{tracking_id}:{page}"
    current = routes.index(current_route) if current_route in routes else 0
    check_button = (
        _button("⏳ Проверка запланирована", "mp:noop")
        if check_scheduled
        else _button(
            "🔄 Проверить",
            f"mp:tc:{tracking_id}:{page}:{_tracking_check_revision(item)}",
        )
    )
    return _card(
        "\n".join(lines),
        _carousel_buttons(
            routes,
            current,
            f"tracking-p:{page}",
            (check_button,),
        ),
        photo_url=item.get("poster_url") if isinstance(item.get("poster_url"), str) else None,
    )


def render_tracking_scheduled_card(
    ctx, tracking_id: str, page: int = 1
) -> MediaPanelCard:
    try:
        return _render_tracking_detail(
            ctx, tracking_id, page, check_scheduled=True
        )
    except (TypeError, ValueError, RuntimeError, OSError, TimeoutError):
        logger.exception("Failed to refresh scheduled tracking card")
        return _card(
            "⏳ <b>Проверка запланирована</b>\n\nРезультат появится в карточке подписки.",
            (
                (_button("⏳ Проверка запланирована", "mp:noop"),),
                (_button("⬅️ Назад", f"mp:tracking-p:{page}"),),
            ),
        )


def render_tracking_check_failure_card(
    tracking_id: str, page: int, retry_callback: str | None = None
) -> MediaPanelCard:
    actions = (
        ((_button("🔄 Повторить", retry_callback),),)
        if retry_callback is not None
        else ()
    )
    return _card(
        "⚠️ <b>Не удалось подтвердить запуск проверки</b>\n\nПроверьте подписку позже.",
        actions
        + (
            (_button("⬅️ Назад", f"mp:tracking-p:{page}"),),
        ),
    )


def _error_parent(route: str) -> str:
    if route.startswith(("job:", "job-cancel:", "job-retry:")):
        parts = route.split(":")
        page = int(parts[2]) if len(parts) > 2 else 1
        filter_code = parts[3] if len(parts) > 3 else "a"
        return _downloads_route(filter_code, page)
    if route.startswith("library-key:"):
        _, section_key, _, page = route.split(":")
        return f"library-section:{section_key}:{page}"
    if route.startswith("library-section:"):
        return "library"
    if route in {"library", "storage", "watching", "recent"} or route.startswith(
        ("watching-p:", "recent-p:")
    ):
        return "plex"
    if route.startswith("watching-key:"):
        parts = route.split(":")
        return f"watching-p:{parts[2] if len(parts) > 2 else 1}"
    if route.startswith("recent-key:"):
        parts = route.split(":")
        return f"recent-p:{parts[2] if len(parts) > 2 else 1}"
    if route.startswith(("tracking:", "tracking-check:")):
        parts = route.split(":")
        return f"tracking-p:{parts[2] if len(parts) > 2 else 1}"
    if route.startswith("best-key:"):
        _, kind, mode, page, _, _ = route.split(":")
        return f"best:{kind}:{mode}:{page}"
    if route.startswith("prem-key:"):
        _, kind, mode, page, _, _ = route.split(":")
        return f"prem:{kind}:{mode}:{page}"
    if route.startswith("discover-key:"):
        _, kind, genre, page, _, _ = route.split(":")
        return f"discover:{kind}:{genre}:{page}"
    if route.startswith("discover:"):
        return f"genres:{route.split(':')[1]}"
    return "home"


def _render_route_error(route: str) -> MediaPanelCard:
    return _card(
        "⚠️ <b>Раздел временно недоступен</b>\n\nПопробуйте ещё раз.",
        media_browser_rows(
            actions=(_button("🔄 Повторить", f"mp:{route}"),),
            back=_button("⬅️ Назад", f"mp:{_error_parent(route)}"),
        ),
    )


def render_media_panel_card(ctx, route: str) -> MediaPanelCard:
    """Render one deterministic media panel route without Telegram side effects."""
    try:
        if route == "home":
            return _render_home()
        if route == "noop":
            return _render_home()
        if route == "plex":
            return _render_plex()
        if route == "best":
            return _render_discovery_list(ctx, "best", "m", "r", 1)
        if route.startswith("best:"):
            _, kind_code, mode_code, page = route.split(":")
            return _render_discovery_list(
                ctx, "best", kind_code, mode_code, int(page)
            )
        if route.startswith("best-key:"):
            _, kind_code, mode_code, page, index, tmdb_id = route.split(":")
            return _render_discovery_detail(
                ctx,
                "best",
                kind_code,
                mode_code,
                int(page),
                int(index),
                int(tmdb_id),
            )
        if route == "premieres":
            return _render_discovery_list(ctx, "premieres", "m", "n", 1)
        if route.startswith("prem:"):
            _, kind_code, mode_code, page = route.split(":")
            return _render_discovery_list(
                ctx, "premieres", kind_code, mode_code, int(page)
            )
        if route.startswith("prem-key:"):
            _, kind_code, mode_code, page, index, tmdb_id = route.split(":")
            return _render_discovery_detail(
                ctx,
                "premieres",
                kind_code,
                mode_code,
                int(page),
                int(index),
                int(tmdb_id),
            )
        if route == "genres":
            return _render_genres(ctx)
        if route.startswith("genres:"):
            return _render_genres(ctx, route.rsplit(":", 1)[1])
        if route.startswith("discover:"):
            _, kind_code, genre_id, page = route.split(":")
            return _render_discovery_list(
                ctx,
                "discover",
                kind_code,
                None,
                int(page),
                genre_id=int(genre_id),
            )
        if route.startswith("discover-key:"):
            _, kind_code, genre_id, page, index, tmdb_id = route.split(":")
            return _render_discovery_detail(
                ctx,
                "discover",
                kind_code,
                None,
                int(page),
                int(index),
                int(tmdb_id),
                genre_id=int(genre_id),
            )
        if route == "watching" or route.startswith("watching-p:"):
            page = int(route.rsplit(":", 1)[1]) if ":" in route else 1
            return _render_watching(ctx, page)
        if route.startswith("watching-key:"):
            parts = route.split(":")
            return _render_watching_detail(
                ctx,
                parts[1],
                int(parts[2]) if len(parts) > 2 else 1,
            )
        if route == "recent" or route.startswith("recent-p:"):
            page = int(route.rsplit(":", 1)[1]) if ":" in route else 1
            return _render_recent(ctx, page)
        if route.startswith("recent-key:"):
            parts = route.split(":")
            return _render_recent_detail(
                ctx,
                parts[1],
                int(parts[2]) if len(parts) > 2 else 1,
            )
        if route == "library":
            return _render_library(ctx)
        if route.startswith("library-section:"):
            _, section_key, page = route.split(":")
            return _render_library_section(ctx, int(section_key), int(page))
        if route.startswith("library-key:"):
            _, section_key, rating_key, page = route.split(":")
            return _render_library_detail(
                ctx, int(section_key), rating_key, int(page)
            )
        if route == "storage":
            return _render_storage(ctx)
        if route == "downloads":
            return _render_downloads(ctx)
        downloads_match = re.fullmatch(
            r"downloads(?:-([mt]))?-p:([1-9][0-9]*)", route
        )
        if downloads_match is not None:
            return _render_downloads(
                ctx,
                int(downloads_match.group(2)),
                downloads_match.group(1) or "a",
            )
        if route.startswith("job:"):
            parts = route.split(":")
            return _render_job_detail(
                ctx,
                parts[1],
                int(parts[2]) if len(parts) > 2 else 1,
                parts[3] if len(parts) > 3 else "a",
            )
        if route.startswith("job-cancel:"):
            parts = route.split(":")
            return _render_job_cancel_confirmation(
                ctx,
                parts[1],
                int(parts[2]) if len(parts) > 2 else 1,
                parts[3] if len(parts) > 3 else "a",
            )
        if route.startswith("job-retry:"):
            parts = route.split(":")
            return _render_job_retry_confirmation(
                ctx,
                parts[1],
                int(parts[2]) if len(parts) > 2 else 1,
                parts[3] if len(parts) > 3 else "a",
            )
        if route == "tracking" or route.startswith("tracking-p:"):
            page = int(route.rsplit(":", 1)[1]) if ":" in route else 1
            return _render_tracking(ctx, page)
        if route.startswith("tracking:"):
            parts = route.split(":")
            return _render_tracking_detail(
                ctx,
                parts[1],
                int(parts[2]) if len(parts) > 2 else 1,
            )
        if route.startswith("tracking-check:"):
            parts = route.split(":")
            return render_tracking_scheduled_card(
                ctx, parts[1], int(parts[2]) if len(parts) > 2 else 1
            )
    except (AttributeError, TypeError, ValueError, RuntimeError, OSError, TimeoutError):
        logger.exception("Failed to render media panel route %s", route)
    return _render_route_error(route)


def _markup_from_card(card: MediaPanelCard) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [
            [InlineKeyboardButton(button.label, callback_data=button.callback_data) for button in row]
            for row in card.buttons
        ]
    )


def _media_panel_markup(section: str) -> InlineKeyboardMarkup:
    """Compatibility markup for the existing callback handler."""
    if section == "home":
        return _markup_from_card(_render_home())
    return _markup_from_card(
        _card("", ((_button("⬅️ Меню", "mp:home"),),))
    )


def _media_panel_home() -> str:
    """Compatibility text for the existing /media command."""
    return "🎬 Медиа\n\nВыберите раздел."


def _render_media_panel_section(ctx, section: str) -> str:
    """Compatibility text renderer used until callbacks adopt MediaPanelCard."""
    if section == "trending":
        return _render_trending_command(ctx, "", "all")
    card = render_media_panel_card(ctx, section)
    return re.sub(r"</?(?:b|i|code|blockquote)(?: expandable)?>", "", card.text)
