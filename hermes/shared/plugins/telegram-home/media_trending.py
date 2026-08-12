"""Pure renderers for TMDB Telegram cards."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from html import escape
from math import isfinite

from .media_browser import (
    MediaBrowserNavigation,
    media_browser_rows,
    media_carousel_navigation,
    media_page_navigation,
)


_CATEGORY_LABELS = {
    "all": "🔥 Тренды",
    "movie": "🎬 Фильмы",
    "tv": "📺 Сериалы",
}

_MONTHS_RU = (
    "",
    "января",
    "февраля",
    "марта",
    "апреля",
    "мая",
    "июня",
    "июля",
    "августа",
    "сентября",
    "октября",
    "ноября",
    "декабря",
)

_GENRES_RU = {
    "Action": "боевик",
    "Action & Adventure": "боевик и приключения",
    "Adventure": "приключения",
    "Animation": "мультфильм",
    "Боевик и Приключения": "боевик и приключения",
    "Comedy": "комедия",
    "Crime": "криминал",
    "Documentary": "документальный",
    "Drama": "драма",
    "Family": "семейный",
    "Fantasy": "фэнтези",
    "History": "исторический",
    "Horror": "ужасы",
    "Kids": "детский",
    "Music": "музыкальный",
    "Mystery": "детектив",
    "НФ и Фэнтези": "фантастика и фэнтези",
    "News": "новости",
    "Reality": "реалити-шоу",
    "Romance": "мелодрама",
    "Sci-Fi & Fantasy": "фантастика и фэнтези",
    "Science Fiction": "фантастика",
    "Soap": "мыльная опера",
    "Talk": "ток-шоу",
    "Thriller": "триллер",
    "TV Movie": "телефильм",
    "War": "военный",
    "War & Politics": "война и политика",
    "Western": "вестерн",
    "Боевик": "боевик",
    "Военный": "военный",
    "Детектив": "детектив",
    "Документальный": "документальный",
    "Драма": "драма",
    "История": "исторический",
    "Комедия": "комедия",
    "Криминал": "криминал",
    "Мелодрама": "мелодрама",
    "Мультфильм": "мультфильм",
    "Приключения": "приключения",
    "Семейный": "семейный",
    "Телефильм": "телефильм",
    "Триллер": "триллер",
    "Ужасы": "ужасы",
    "Фантастика": "фантастика",
    "Фэнтези": "фэнтези",
}

_COUNTRIES_RU = {
    "AR": "Аргентина",
    "Argentina": "Аргентина",
    "AT": "Австрия",
    "Austria": "Австрия",
    "AU": "Австралия",
    "Australia": "Австралия",
    "BE": "Бельгия",
    "Belgium": "Бельгия",
    "BG": "Болгария",
    "Bulgaria": "Болгария",
    "BR": "Бразилия",
    "Brazil": "Бразилия",
    "CA": "Канада",
    "Canada": "Канада",
    "CH": "Швейцария",
    "Switzerland": "Швейцария",
    "CL": "Чили",
    "Chile": "Чили",
    "CN": "Китай",
    "China": "Китай",
    "CO": "Колумбия",
    "Colombia": "Колумбия",
    "CZ": "Чехия",
    "Czech Republic": "Чехия",
    "Czechia": "Чехия",
    "DE": "Германия",
    "Germany": "Германия",
    "DK": "Дания",
    "Denmark": "Дания",
    "ES": "Испания",
    "Spain": "Испания",
    "FI": "Финляндия",
    "Finland": "Финляндия",
    "FR": "Франция",
    "France": "Франция",
    "GB": "Великобритания",
    "United Kingdom": "Великобритания",
    "GR": "Греция",
    "Greece": "Греция",
    "HK": "Гонконг",
    "Hong Kong": "Гонконг",
    "HU": "Венгрия",
    "Hungary": "Венгрия",
    "IE": "Ирландия",
    "Ireland": "Ирландия",
    "IL": "Израиль",
    "Israel": "Израиль",
    "IN": "Индия",
    "India": "Индия",
    "IS": "Исландия",
    "Iceland": "Исландия",
    "IT": "Италия",
    "Italy": "Италия",
    "JP": "Япония",
    "Japan": "Япония",
    "KR": "Южная Корея",
    "Republic of Korea": "Южная Корея",
    "South Korea": "Южная Корея",
    "KZ": "Казахстан",
    "Kazakhstan": "Казахстан",
    "MX": "Мексика",
    "Mexico": "Мексика",
    "NL": "Нидерланды",
    "Netherlands": "Нидерланды",
    "NO": "Норвегия",
    "Norway": "Норвегия",
    "NZ": "Новая Зеландия",
    "New Zealand": "Новая Зеландия",
    "PL": "Польша",
    "Poland": "Польша",
    "PT": "Португалия",
    "Portugal": "Португалия",
    "RO": "Румыния",
    "Romania": "Румыния",
    "RU": "Россия",
    "Russia": "Россия",
    "Russian Federation": "Россия",
    "SE": "Швеция",
    "Sweden": "Швеция",
    "SK": "Словакия",
    "Slovakia": "Словакия",
    "TR": "Турция",
    "Turkey": "Турция",
    "Türkiye": "Турция",
    "TW": "Тайвань",
    "Taiwan": "Тайвань",
    "UA": "Украина",
    "Ukraine": "Украина",
    "US": "США",
    "United States": "США",
    "United States of America": "США",
    "ZA": "ЮАР",
    "South Africa": "ЮАР",
}

_STATUS_RU = {
    "Canceled": ("🔴", "Отменён"),
    "Ended": ("⚪", "Завершён"),
    "In Production": ("🟡", "В производстве"),
    "Pilot": ("🟠", "Пилот"),
    "Planned": ("🟡", "Запланирован"),
    "Post Production": ("🟡", "Постпродакшен"),
    "Released": ("✅", "Вышел"),
    "Returning Series": ("🟢", "Продолжается"),
    "Rumored": ("🟠", "Слухи"),
}


@dataclass(frozen=True)
class TrendingButton:
    label: str
    callback_data: str | None = None
    url: str | None = None


@dataclass(frozen=True)
class TrendingCard:
    text: str
    photo_url: str | None
    buttons: tuple[tuple[TrendingButton, ...], ...]
    parse_mode: str | None = "HTML"


def _format_title_line(item: dict) -> str:
    icon = "🎬" if item.get("media_type") == "movie" else "📺"
    title = _html(_text(item.get("title"), 72) or "Без названия")
    year = f" ({item['year']})" if isinstance(item.get("year"), int) else ""
    rating = _rating(item.get("rating"))
    rating_text = f" ⭐{rating:.1f}" if rating is not None else ""
    return f"{icon} {title}{year}{rating_text}"


def render_trending_list(payload: dict) -> TrendingCard | None:
    category = payload.get("category")
    results = payload.get("results")
    page = payload.get("page")
    total_pages = payload.get("total_pages")
    if not _valid_page(category, results, page, total_pages):
        return None

    items = [item for item in results[:10] if isinstance(item, dict)]
    code = _category_code(category)
    nav = media_page_navigation(
        page,
        total_pages,
        make_button=_callback,
        callback_for=lambda target: f"mt:l:{code}:{target}:0:0",
        noop_callback="mp:noop",
    )
    if not items:
        return TrendingCard(
            f"{_CATEGORY_LABELS[category]}\n\nНа этой странице ничего не найдено.",
            None,
            media_browser_rows(
                navigation=nav,
                controls=(_category_row(category),),
                back=_callback("⬅️ Назад", "mn:b"),
            ),
        )

    lines = [_format_title_line(item) for item in items]

    buttons = media_browser_rows(
        navigation=nav,
        controls=(
            _category_row(category),
            (_callback("🖼 Карточки", f"mt:d:{code}:{page}:0:{_tmdb_id(items[0])}"),),
        ),
        back=_callback("⬅️ Назад", "mn:b"),
    )
    return TrendingCard("\n".join(lines)[:1024], _poster(items[0]), buttons)


def render_trending_details(payload: dict, index: int) -> TrendingCard | None:
    category = payload.get("category")
    results = payload.get("results")
    page = payload.get("page")
    if (
        category not in _CATEGORY_LABELS
        or not isinstance(results, list)
        or not isinstance(page, int)
        or isinstance(page, bool)
    ):
        return None
    items = [item for item in results[:10] if isinstance(item, dict)]
    if not items or index < 0 or index >= len(items):
        return None

    code = _category_code(category)
    item = items[index]
    routes = [
        f"mt:d:{code}:{page}:{position}:{_tmdb_id(value)}"
        for position, value in enumerate(items)
    ]
    nav = media_carousel_navigation(
        routes,
        index,
        make_button=_callback,
        callback_for=lambda route: route,
        noop_callback="mp:noop",
    )
    return _render_details_card(
        item,
        nav,
        _callback("⬅️ Назад", "mn:b"),
    )


def render_similar_list(payload: dict, origin_type: str, origin_id: int) -> TrendingCard | None:
    results = payload.get("results")
    page = payload.get("page")
    total_pages = payload.get("total_pages")
    if (
        origin_type not in {"movie", "tv"}
        or not isinstance(origin_id, int)
        or origin_id < 1
        or not isinstance(results, list)
        or not isinstance(page, int)
        or page < 1
        or not isinstance(total_pages, int)
        or total_pages < 1
    ):
        return None
    items = [item for item in results[:10] if isinstance(item, dict)]
    kind = _kind_code(origin_type)
    nav = media_page_navigation(
        page,
        total_pages,
        make_button=_callback,
        callback_for=lambda target: (
            f"mi:l:{kind}:{origin_id}:{target}:0:0"
        ),
        noop_callback="mp:noop",
    )
    if not items:
        return TrendingCard(
            "🎭 Похожие релизы\n\nПодходящих рекомендаций пока нет.",
            None,
            media_browser_rows(
                navigation=nav,
                back=_callback("⬅️ Назад", "mn:b"),
            ),
        )
    lines = [_format_title_line(item) for item in items]
    return TrendingCard(
        "\n".join(lines)[:1024],
        _poster(items[0]),
        media_browser_rows(
            navigation=nav,
            controls=((
                _callback(
                    "🖼 Карточки",
                    f"mi:d:{kind}:{origin_id}:{page}:0:{_tmdb_id(items[0])}",
                ),
            ),),
            back=_callback("⬅️ Назад", "mn:b"),
        ),
    )


def render_similar_details(
    payload: dict, origin_type: str, origin_id: int, index: int
) -> TrendingCard | None:
    results = payload.get("results")
    page = payload.get("page")
    if (
        origin_type not in {"movie", "tv"}
        or not isinstance(results, list)
        or not isinstance(page, int)
    ):
        return None
    items = [item for item in results[:10] if isinstance(item, dict)]
    if not items or index < 0 or index >= len(items):
        return None
    kind = _kind_code(origin_type)
    routes = [
        f"mi:d:{kind}:{origin_id}:{page}:{position}:{_tmdb_id(value)}"
        for position, value in enumerate(items)
    ]
    nav = media_carousel_navigation(
        routes,
        index,
        make_button=_callback,
        callback_for=lambda route: route,
        noop_callback="mp:noop",
    )
    return _render_details_card(
        items[index],
        nav,
        _callback("⬅️ Назад", "mn:b"),
    )


def render_direct_details(
    item: dict,
    *,
    navigation_routes: tuple[str, ...] = (),
    navigation_index: int = 0,
    back_callback: str = "mn:b",
) -> TrendingCard | None:
    if not isinstance(item, dict) or item.get("media_type") not in {"movie", "tv"}:
        return None
    navigation = (
        media_carousel_navigation(
            navigation_routes,
            navigation_index,
            make_button=_callback,
            callback_for=lambda route: route,
            noop_callback="mp:noop",
        )
        if navigation_routes
        else None
    )
    return _render_details_card(
        item,
        navigation,
        _callback("⬅️ Назад", back_callback),
    )


def category_from_code(code: str) -> str | None:
    return {"a": "all", "m": "movie", "t": "tv"}.get(code)


def kind_from_code(code: str) -> str | None:
    return {"m": "movie", "t": "tv"}.get(code)


def _render_details_card(
    item: dict,
    nav: MediaBrowserNavigation[TrendingButton] | None,
    back: TrendingButton,
) -> TrendingCard:
    title = _text(item.get("title"), 160) or "Без названия"
    original = _text(item.get("original_title"), 160)
    media_type = item.get("media_type")
    icon = "🎬" if media_type == "movie" else "📺"
    title_line = f"{icon} {_html(title)}"
    if original and original != title:
        title_line += f" / {_html(original)}"
    lines = [f"<b>{title_line}</b>"]

    info = []
    release_date = _text(item.get("release_date"), 32)
    release_year = None
    if release_date:
        try:
            release_year = date.fromisoformat(release_date).year
        except ValueError:
            pass
    year = item.get("year") if isinstance(item.get("year"), int) else release_year
    if isinstance(year, int):
        info.append(f"📅 {year}")
    if release_date:
        timing = _release_timing(release_date)
        if timing:
            info.append(_html(timing))
    if info:
        lines.append(" • ".join(info))

    rating = _rating(item.get("rating"))
    if rating is not None:
        lines.append(f"TMDb: {_rating_stars(rating)} {rating:.1f}/10")

    if media_type == "tv":
        season_count = _positive_int(item.get("season_count"))
        episode_count = _positive_int(item.get("episode_count"))
        episode_parts = []
        if season_count is not None:
            episode_parts.append(f"{season_count} {_plural_ru(season_count, 'сезон', 'сезона', 'сезонов')}")
        if episode_count is not None:
            episode_parts.append(f"{episode_count} {_plural_ru(episode_count, 'серия', 'серии', 'серий')}")
        if episode_parts:
            lines.append(f"📺 {' • '.join(episode_parts)}")

    links = []
    for icon_label, label, key in (
        ("🎬", "Трейлер", "trailer_url"),
        ("⭐", "TMDb", "tmdb_url"),
        ("⭐", "IMDb", "imdb_url"),
    ):
        url = _safe_url(item.get(key))
        if url:
            links.append(f'{icon_label} <a href="{escape(url, quote=True)}">{label}</a>')
    if links:
        lines.append(" | ".join(links))

    countries = _localized_values(item.get("countries"), 4, _COUNTRIES_RU)
    genres = _localized_values(item.get("genres"), 5, _GENRES_RU)
    status = _text(item.get("status"), 48)
    details = []
    if countries:
        details.append(f"🌍 {_html(', '.join(countries))}")
    if genres:
        genre_icon = "🎬" if media_type == "movie" else "📺"
        details.append(" • ".join(f"{genre_icon} {_html(genre)}" for genre in genres))
    if status in _STATUS_RU:
        status_icon, status_label = _STATUS_RU[status]
        details.append(f"{status_icon} {_html(status_label)}")
    next_episode = _next_episode(item.get("next_episode"))
    if media_type == "tv" and next_episode is not None:
        season, episode, air_date = next_episode
        details.append(
            f"🔔 Следующая серия: S{season:02d}E{episode:02d} · "
            f"{_html(_human_date(air_date))}"
        )

    overview = _text(item.get("overview"), 2_000)
    if overview:
        if details:
            details.append("")
        details.append(_html(_truncate(overview, 280)))
    if details:
        detail_text = "\n".join(details)
        lines.extend(("", f"<blockquote expandable>{detail_text}</blockquote>"))

    tmdb_id = _tmdb_id(item)
    kind_code = _kind_code(media_type)
    controls = []
    if tmdb_id > 0:
        controls.append(
            (_callback("🎭 Похожие", f"mi:l:{kind_code}:{tmdb_id}:1:0:0"),)
        )
        primary = []
        if media_type == "tv":
            primary.append(
                _callback("🔕 Отслеживание", f"mx:t:{kind_code}:{tmdb_id}:0")
            )
        primary.append(_callback("⬇️ Скачать", f"mx:w:{kind_code}:{tmdb_id}:0"))
        controls.append(tuple(primary))

    return TrendingCard(
        "\n".join(lines),
        _poster(item),
        media_browser_rows(navigation=nav, controls=controls, back=back),
    )


def _valid_page(category, results, page, total_pages) -> bool:
    return (
        category in _CATEGORY_LABELS
        and isinstance(results, list)
        and isinstance(page, int)
        and not isinstance(page, bool)
        and page >= 1
        and isinstance(total_pages, int)
        and not isinstance(total_pages, bool)
        and total_pages >= 1
    )


def _category_code(category: str) -> str:
    return {"all": "a", "movie": "m", "tv": "t"}[category]


def _kind_code(media_type: str) -> str:
    return "m" if media_type == "movie" else "t"


def _category_row(active: str) -> tuple[TrendingButton, ...]:
    return tuple(
        _callback(
            f"{'✅ ' if active == category else ''}{label}",
            "mp:noop" if active == category else f"mt:l:{_category_code(category)}:1:0:0",
        )
        for category, label in (("movie", "Фильмы"), ("tv", "Сериалы"), ("all", "Все"))
    )


def _callback(label: str, data: str) -> TrendingButton:
    return TrendingButton(label=label, callback_data=data)


def _poster(item: dict) -> str | None:
    value = _text(item.get("poster_url"), 2048)
    return value if value and value.startswith("https://") else None


def _tmdb_id(item: dict) -> int:
    value = item.get("tmdb_id")
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else 0


def _text_list(value, limit: int) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in (_text(item, 48) for item in value[:limit]) if item]


def _localized_values(value, limit: int, labels: dict[str, str]) -> list[str]:
    localized = []
    for item in _text_list(value, limit):
        label = labels.get(item)
        if label is not None and label not in localized:
            localized.append(label)
    return localized


def _safe_url(value) -> str | None:
    value = _text(value, 2048)
    return value if value and value.startswith("https://") else None


def _rating(value) -> float | None:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    rating = float(value)
    return rating if isfinite(rating) and rating > 0 else None


def _rating_stars(rating: float) -> str:
    stars = "⭐" * min(5, max(0, int(rating / 2)))
    if rating % 2 >= 1 and len(stars) < 5:
        stars += "½"
    return stars


def _release_timing(value: str) -> str | None:
    try:
        release = date.fromisoformat(value)
    except ValueError:
        return value
    delta = (release - date.today()).days
    if delta < 0:
        days = abs(delta)
        if days < 30:
            return f"Вышел {days} {_plural_ru(days, 'день', 'дня', 'дней')} назад"
        if days < 365:
            months = max(1, days // 30)
            return f"Вышел {months} {_plural_ru(months, 'месяц', 'месяца', 'месяцев')} назад"
        return f"{_MONTHS_RU[release.month]} {release.year}"
    if delta == 0:
        return "Выходит сегодня"
    if delta <= 7:
        return f"Через {delta} {_plural_ru(delta, 'день', 'дня', 'дней')}"
    if delta <= 30:
        weeks = max(1, delta // 7)
        return f"Через {weeks} {_plural_ru(weeks, 'неделю', 'недели', 'недель')}"
    return f"{release.day} {_MONTHS_RU[release.month]} {release.year}"


def _plural_ru(value: int, one: str, few: str, many: str) -> str:
    if value % 10 == 1 and value % 100 != 11:
        return one
    if value % 10 in {2, 3, 4} and value % 100 not in {12, 13, 14}:
        return few
    return many


def _positive_int(value) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool) and value > 0:
        return value
    return None


def _human_date(value: str) -> str:
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        return value
    return f"{parsed.day} {_MONTHS_RU[parsed.month]} {parsed.year}"


def _next_episode(value) -> tuple[int, int, str] | None:
    if not isinstance(value, dict):
        return None
    season = value.get("season")
    episode = _positive_int(value.get("episode"))
    air_date = _text(value.get("air_date"), 10)
    if (
        not isinstance(season, int)
        or isinstance(season, bool)
        or season < 0
        or episode is None
        or air_date is None
    ):
        return None
    try:
        date.fromisoformat(air_date)
    except ValueError:
        return None
    return season, episode, air_date


def _text(value, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    value = " ".join(value.split()).strip()
    return _truncate(value, limit) if value else None


def _truncate(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    if limit <= 1:
        return "…"[:limit]
    cropped = value[: limit - 1].rstrip()
    boundary = cropped.rfind(" ")
    if boundary >= limit // 2:
        cropped = cropped[:boundary]
    return f"{cropped.rstrip('.,;: -')}…"


def _html(value: str) -> str:
    return escape(value, quote=False)
