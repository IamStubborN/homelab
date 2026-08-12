"""Pure parsing and rendering helpers for Telegram media search cards."""

from __future__ import annotations

import json
import math
import re
import time
from datetime import datetime

from .media_models import RenderedSearch, RenderedSearchPart, SearchAction


_MAX_SEARCH_CARD_TEXT = 3800
_MAX_SEARCH_CARD_ACTIONS = 20
_MAX_SOURCE_RESULTS = 10
_UNIFIED_PAGE_SIZE = 5
_TRANSLATION_ALIAS_RE = re.compile(
    r"^(?P<label>[^()]*)\(\s*(?P<alias>[A-Za-z][A-Za-z0-9 .&+/_'-]*)\s*\)$"
)
_VERIFIED_TRANSLATION_ALIASES = {
    ("лостфильм", "lostfilm"): "LostFilm",
    ("колдфильм", "coldfilm"): "Coldfilm",
    ("яскьер", "jaskier"): "Jaskier",
    ("ньюстудио", "newstudio"): "NewStudio",
    ("кероб", "kerobtv"): "KerobTV",
    ("октопус", "octopus/ultradox"): "Octopus/Ultradox",
}


def _serialize_search_action(action: SearchAction) -> dict:
    return {
        "label": action.label,
        "kind": action.kind,
        "payload": action.payload,
        "expires_at": action.expires_at,
    }


def _deserialize_search_action(value: object) -> SearchAction | None:
    if not isinstance(value, dict):
        return None
    label = value.get("label")
    kind = value.get("kind")
    payload = value.get("payload")
    expires_at = value.get("expires_at")
    if (
        not isinstance(label, str)
        or not isinstance(kind, str)
        or not isinstance(payload, dict)
        or not isinstance(expires_at, str)
    ):
        return None
    return SearchAction(label, kind, payload, expires_at)


def _serialize_search_parts(parts: tuple[RenderedSearchPart, ...]) -> list[dict]:
    return [
        {
            "text": part.text,
            "photo_url": part.photo_url,
            "actions": [_serialize_search_action(action) for action in part.actions],
        }
        for part in parts
    ]


def _deserialize_search_parts(value: object) -> tuple[RenderedSearchPart, ...] | None:
    if not isinstance(value, list) or not value:
        return None
    parts = []
    for item in value:
        if not isinstance(item, dict) or not isinstance(item.get("text"), str):
            return None
        photo_url = item.get("photo_url")
        if photo_url is not None and not isinstance(photo_url, str):
            return None
        raw_actions = item.get("actions")
        if not isinstance(raw_actions, list):
            return None
        actions = tuple(
            action
            for raw_action in raw_actions
            if (action := _deserialize_search_action(raw_action)) is not None
        )
        if len(actions) != len(raw_actions):
            return None
        parts.append(RenderedSearchPart(item["text"], actions, photo_url))
    return tuple(parts)

def _decode_search_page(output: bytes, source: str) -> dict | None:
    try:
        value = json.loads(output.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if (
        not isinstance(value, dict)
        or value.get("source") != source
        or not isinstance(value.get("results"), list)
    ):
        return None
    return value


def _media_error_code(output: bytes) -> str | None:
    try:
        value = json.loads(output.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict):
        return None
    error = value.get("error")
    if isinstance(error, dict):
        error = error.get("code")
    if not isinstance(error, str):
        error = value.get("error_code")
    return error.strip().lower() if isinstance(error, str) and error.strip() else None


def _sanitize_details(output: bytes) -> str:
    try:
        value = json.loads(output.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return "Не удалось получить технические сведения."
    if not isinstance(value, dict):
        return "Не удалось получить технические сведения."
    lines = ["Технические сведения"]
    for key, label in (
        ("id", "Задача"),
        ("state", "Статус"),
        ("attempt_count", "Попытка"),
        ("error_code", "Код"),
    ):
        item = value.get(key)
        if isinstance(item, (str, int)) and not isinstance(item, bool):
            lines.append(f"{label}: {item}")
    return "\n".join(lines) if len(lines) > 1 else "Не удалось получить технические сведения."


def _bounded_text(value, limit: int = 160) -> str | None:
    if not isinstance(value, str):
        return None
    text = "".join(character for character in value if character.isprintable()).strip()
    if not text:
        return None
    return text[:limit]


def _opaque_text(value, limit: int) -> str | None:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or len(value) > limit
        or not all(character.isprintable() for character in value)
    ):
        return None
    return value


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


def _format_size(value) -> str | None:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        return None
    units = ("Б", "КиБ", "МиБ", "ГиБ", "ТиБ")
    amount = float(value)
    unit = units[0]
    for unit in units:
        if amount < 1024 or unit == units[-1]:
            break
        amount /= 1024
    return f"{amount:.1f} {unit}" if unit != "Б" else f"{value} {unit}"


def _render_alternative_search(output: bytes) -> str | None:
    try:
        value = json.loads(output.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict) or not isinstance(value.get("results"), list):
        return None
    source = _bounded_text(value.get("source"), 16)
    if source not in {"rezka", "prowlarr"}:
        return None
    provider = "Rezka" if source == "rezka" else "Prowlarr"
    lines = [f"🔎 Другой источник: {provider}"]
    results = value["results"][:5]
    if not results:
        return f"{lines[0]}\n\nПодходящих вариантов пока нет."
    for index, result in enumerate(results, start=1):
        if not isinstance(result, dict):
            return None
        title = _bounded_text(result.get("title"))
        if title is None:
            return None
        details = []
        year = result.get("year")
        if (
            isinstance(year, int)
            and not isinstance(year, bool)
            and 1888 <= year <= 3000
        ):
            details.append(str(year))
        size = _format_size(result.get("size_bytes"))
        if size is not None:
            details.append(size)
        seeders = result.get("seeders")
        if isinstance(seeders, int) and not isinstance(seeders, bool) and seeders >= 0:
            details.append(f"{seeders} сидов")
        translations = result.get("translations")
        if isinstance(translations, list):
            details.append(_voiceover_count(min(len(translations), 999)))
        suffix = f" · {', '.join(details)}" if details else ""
        lines.append(f"{index}. {title}{suffix}")
    lines.append("\nНапиши номер варианта, чтобы продолжить.")
    if isinstance(value.get("continuation"), str) and value["continuation"]:
        lines.append("Можно также попросить показать ещё.")
    return "\n".join(lines)


def _render_source_search(
    output: bytes,
    expected_source: str,
    season: int,
    episode: int,
    source_back_action: SearchAction | None = None,
    *,
    carousel: bool = True,
    combined_context: dict | None = None,
    result_limit: int | None = _MAX_SOURCE_RESULTS,
    tracking_context: dict | None = None,
    direct_back: bool = False,
) -> RenderedSearch | None:
    try:
        value = json.loads(output.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if (
        not isinstance(value, dict)
        or value.get("source") != expected_source
        or expected_source not in {"rezka", "prowlarr"}
    ):
        return None
    session_id = _opaque_text(value.get("session_id"), 128)
    expires_at = value.get("expires_at")
    results = value.get("results")
    if (
        session_id is None
        or not isinstance(expires_at, str)
        or _expiry_timestamp(expires_at) <= time.time()
        or not isinstance(results, list)
    ):
        return None
    provider = "Rezka" if expected_source == "rezka" else "Prowlarr"
    heading = _search_heading(provider, season, episode)
    photo_url = None
    blocks = []
    visible_results = results if result_limit is None else results[:result_limit]
    if not visible_results:
        blocks.append((["Подходящих вариантов пока нет."], [SearchAction(
            label="",
            kind="search-context",
            payload={
                "source": expected_source,
                "search_page": value,
                "season": season,
                "episode": episode,
                "source_back": _source_back_payload(source_back_action),
                "combined_context": combined_context,
            },
            expires_at=expires_at,
        )]))
    for result_index, result in enumerate(visible_results, start=1):
        if not isinstance(result, dict) or result.get("source") != expected_source:
            return None
        title = _bounded_text(result.get("title"))
        result_id = _opaque_text(result.get("result_id"), 1024)
        if title is None or result_id is None:
            return None
        if photo_url is None:
            photo_url = _thumbnail_url(result)
        if expected_source == "rezka":
            rendered = _render_rezka_result(
                result,
                result_index,
                session_id,
                result_id,
                title,
                expires_at,
                season,
                episode,
            )
        else:
            rendered = _render_prowlarr_result(
                result,
                result_index,
                session_id,
                result_id,
                title,
                expires_at,
                season,
                episode,
            )
        if rendered is None:
            return None
        result_lines, result_actions = rendered
        for action in result_actions:
            action.payload["search_page"] = value
            action.payload["source_back"] = _source_back_payload(source_back_action)
            choice_set_id = _opaque_text(value.get("choice_set_id"), 128)
            if choice_set_id is not None:
                action.payload["choice_set_id"] = choice_set_id
            if combined_context is not None:
                action.payload["combined_context"] = combined_context
            if tracking_context is not None:
                action.payload["tracking_context"] = tracking_context
            if direct_back:
                action.payload["direct_back"] = True
        blocks.extend(_split_search_result(result_lines, result_actions))

    if visible_results and carousel:
        first_result = visible_results[0]
        if not isinstance(first_result, dict):
            return None
        first_action = _release_details_action(
            source=expected_source,
            result=first_result,
            result_index=1,
            session_id=session_id,
            result_id=first_result["result_id"],
            title=first_result["title"],
            expires_at=expires_at,
            season=season,
            episode=episode,
        )
        first_action.payload["search_page"] = value
        first_action.payload["source_back"] = _source_back_payload(source_back_action)
        if combined_context is not None:
            first_action.payload["combined_context"] = combined_context
        if tracking_context is not None:
            first_action.payload["tracking_context"] = tracking_context
        if direct_back:
            first_action.payload["direct_back"] = True
        rendered = _render_release_details(
            first_action.payload,
            search_page=value,
            source_back_action=source_back_action,
        )
        choice_set_id = _opaque_text(value.get("choice_set_id"), 128)
        if rendered is not None and choice_set_id is not None:
            for action in rendered.actions:
                action.payload["choice_set_id"] = choice_set_id
        return rendered

    continuation = _opaque_text(value.get("continuation"), 4096)
    continuation_action = None
    if continuation is not None:
        continuation_payload = {
            "source": expected_source,
            "continuation": continuation,
            "season": season,
            "episode": episode,
            "source_back": _source_back_payload(source_back_action),
            "combined_context": combined_context,
        }
        if tracking_context is not None:
            continuation_payload["tracking_context"] = tracking_context
        continuation_action = SearchAction(
            label=f"Ещё {provider}",
            kind="continue",
            payload=continuation_payload,
            expires_at=expires_at,
        )
    parts = _pack_search_parts(heading, blocks, continuation_action, photo_url)
    if source_back_action is not None:
        last = parts[-1]
        if len(last.actions) < _MAX_SEARCH_CARD_ACTIONS:
            parts = (*parts[:-1], RenderedSearchPart(
                last.text,
                (*last.actions, source_back_action),
                last.photo_url,
            ))
        else:
            parts = (*parts, RenderedSearchPart(
                f"{heading}\n\n⬅️ Можно вернуться к выбору источника.",
                (source_back_action,),
                photo_url,
            ))
    actions = tuple(action for part in parts for action in part.actions)
    return RenderedSearch(
        "\n\n".join(part.text for part in parts),
        actions,
        parts,
    )


def _render_source_overview(
    pages: dict[str, dict],
    title: str,
    season: int,
    episode: int,
    provider_back_action: SearchAction,
    overview_back_action: SearchAction | None = None,
) -> RenderedSearch | None:
    """Render one provider chooser before provider-specific search results."""
    available = []
    actions = []
    for source, provider in (("rezka", "Rezka"), ("prowlarr", "Prowlarr")):
        page = pages.get(source)
        results = page.get("results") if isinstance(page, dict) else None
        expires_at = page.get("expires_at") if isinstance(page, dict) else None
        if (
            not isinstance(results, list)
            or not results
            or not isinstance(expires_at, str)
            or _expiry_timestamp(expires_at) <= time.time()
        ):
            continue
        visible_count = min(len(results), _MAX_SOURCE_RESULTS)
        available.append(
            f"• {'🌐' if source == 'rezka' else '🧲'} {provider}: {_variant_count(visible_count)}"
        )
        actions.append(
            SearchAction(
                label=f"{provider} · {visible_count}",
                kind="provider-open",
                payload={
                    "source": source,
                    "search_page": page,
                    "season": season,
                    "episode": episode,
                    "source_back": _source_back_payload(provider_back_action),
                },
                expires_at=expires_at,
            )
        )
    if not actions:
        return None
    lines = ["🔎 Выберите источник", "", f"{'📺' if season > 0 else '🎬'} {title}"]
    if season > 0:
        lines.append(f"📺 Сезон {season}")
    if episode > 0:
        lines.append(f"🔔 Серия {episode}")
    lines.extend(("", *available, "", "Выберите источник."))
    if overview_back_action is not None:
        actions.append(overview_back_action)
    text = "\n".join(lines)
    part = RenderedSearchPart(text, tuple(actions))
    return RenderedSearch(text, tuple(actions), (part,))


def _combine_source_results(
    searches: list[RenderedSearch],
    failed_providers: list[str],
    *,
    page: int = 0,
) -> RenderedSearch | None:
    if not searches:
        return None
    search_pages = []
    page_identities = set()
    for search in searches:
        for action in search.actions:
            search_page = action.payload.get("search_page")
            if not isinstance(search_page, dict):
                continue
            identity = (search_page.get("source"), search_page.get("session_id"))
            if identity in page_identities:
                continue
            page_identities.add(identity)
            search_pages.append(search_page)
    empty_providers = [
        "Rezka" if source == "rezka" else "Prowlarr"
        for source, results in (
            (search_page.get("source"), search_page.get("results"))
            for search_page in search_pages
        )
        if source in {"rezka", "prowlarr"} and results == []
    ]
    combined_context: dict[str, object] = {
        "search_pages": search_pages,
        "failed_providers": list(failed_providers),
    }
    release_actions: list[SearchAction] = []
    continuation_actions: list[SearchAction] = []
    global_back_action: SearchAction | None = None
    release_identities: set[tuple[object, object, object]] = set()
    continuation_identities: set[tuple[object, object]] = set()

    for search in searches:
        for action in search.actions:
            if action.kind in {"source-back", "navigation-back"}:
                if global_back_action is None:
                    global_back_action = action
                continue
            if action.kind == "continue":
                identity = (
                    action.payload.get("source"),
                    action.payload.get("continuation"),
                )
                if identity in continuation_identities:
                    continue
                continuation_identities.add(identity)
                continuation_actions.append(SearchAction(
                    label=action.label,
                    kind=action.kind,
                    payload={
                        **action.payload,
                        "combined_context": combined_context,
                    },
                    expires_at=action.expires_at,
                ))
                continue
            if action.kind != "release-details":
                continue
            identity = (
                action.payload.get("source"),
                action.payload.get("session_id"),
                action.payload.get("result_id"),
            )
            if identity in release_identities:
                continue
            release_identities.add(identity)
            release_actions.append(action)

    if global_back_action is not None:
        combined_context["back_action"] = _source_back_payload(global_back_action)

    context_action = release_actions[0] if release_actions else (
        continuation_actions[0] if continuation_actions else None
    )
    combined_context["season"] = (
        context_action.payload.get("season") if context_action else 0
    )
    combined_context["episode"] = (
        context_action.payload.get("episode") if context_action else 0
    )

    # A one-provider override opens its existing release carousel directly.
    # Unified rendering is reserved for the ordinary two-provider search.
    if len(searches) == 1 and not failed_providers and not release_actions:
        return searches[0]

    # Fuse both provider rankings into one normalized [0, 1] score. Provider
    # rank remains the strongest signal; explicit match, release preference,
    # and availability metadata refine it across sources. Stable identity
    # fields break ties, so pagination cannot reorder between renders.
    source_order = {"rezka": 0, "prowlarr": 1}
    release_actions.sort(key=lambda action: (
        -_unified_result_score(action),
        source_order.get(action.payload.get("source"), 2),
        str(action.payload.get("result_id", "")),
    ))

    carousel_results = []
    for action in release_actions:
        payload = action.payload
        result = payload.get("result")
        source = payload.get("source")
        session_id = payload.get("session_id")
        if (
            not isinstance(result, dict)
            or source not in {"rezka", "prowlarr"}
            or not isinstance(session_id, str)
        ):
            continue
        enriched = dict(result)
        enriched["_choice_source"] = source
        enriched["_choice_session_id"] = session_id
        choice_set_id = payload.get("choice_set_id")
        if isinstance(choice_set_id, str):
            enriched["_choice_set_id"] = choice_set_id
        carousel_results.append(enriched)
    carousel_page = None
    if carousel_results:
        first = release_actions[0].payload
        carousel_page = {
            "api_version": "v1",
            "source": first.get("source"),
            "session_id": first.get("session_id"),
            "expires_at": release_actions[0].expires_at,
            "results": carousel_results,
        }

    page_count = max(1, math.ceil(len(release_actions) / _UNIFIED_PAGE_SIZE))
    page = min(max(page, 0), page_count - 1)
    start = page * _UNIFIED_PAGE_SIZE
    visible_actions = release_actions[start : start + _UNIFIED_PAGE_SIZE]
    blocks: list[tuple[list[str], list[SearchAction]]] = []
    for unified_index, action in enumerate(visible_actions, start=start + 1):
        block = _unified_result_block(action, unified_index)
        if block is None:
            continue
        lines, _normalized_action = block
        blocks.append((lines, []))

    footer_lines: list[str] = []
    if not release_actions:
        footer_lines.append("Подходящих вариантов пока нет.")
    footer_lines.extend(
        f"ℹ️ {provider}: подходящих вариантов нет."
        for provider in empty_providers
    )
    footer_lines.extend(
        f"⚠️ {provider} временно недоступен."
        for provider in failed_providers
    )
    footer_actions: list[SearchAction] = []
    expires_at = (
        visible_actions[0].expires_at
        if visible_actions
        else release_actions[0].expires_at if release_actions else "2099-12-31T23:59:59Z"
    )
    footer_actions.append(
        SearchAction(
            label="⬅️",
            kind="combined-page" if page > 0 else "noop",
            payload=(
                {"combined_context": combined_context, "page": page - 1}
                if page > 0
                else {}
            ),
            expires_at=expires_at,
        )
    )
    footer_actions.append(SearchAction(
        label=f"{page + 1}/{page_count}",
        kind="noop",
        payload={},
        expires_at=expires_at,
    ))
    footer_actions.append(
        SearchAction(
            label="➡️",
            kind="combined-page" if page + 1 < page_count else "noop",
            payload=(
                {"combined_context": combined_context, "page": page + 1}
                if page + 1 < page_count
                else {}
            ),
            expires_at=expires_at,
        )
    )
    if page + 1 >= page_count:
        footer_actions.extend(SearchAction(
            label=action.label,
            kind=action.kind,
            payload={**action.payload, "combined_page": page},
            expires_at=action.expires_at,
        ) for action in continuation_actions)
    if visible_actions and carousel_page is not None:
        first_visible = visible_actions[0]
        footer_actions.append(SearchAction(
            label="🖼 Карточки",
            kind="release-details",
            payload={
                **first_visible.payload,
                "result_index": start + 1,
                "search_page": carousel_page,
                "combined_context": combined_context,
                "combined_page": page,
            },
            expires_at=first_visible.expires_at,
        ))
    if global_back_action is not None:
        footer_actions.append(global_back_action)
    if footer_lines or footer_actions:
        blocks.append((footer_lines, footer_actions))

    season = context_action.payload.get("season") if context_action else 0
    episode = context_action.payload.get("episode") if context_action else 0
    heading = _unified_search_heading(season, episode)
    photo_url = next(
        (
            thumbnail
            for action in release_actions
            if isinstance(action.payload.get("result"), dict)
            and (thumbnail := _thumbnail_url(action.payload["result"])) is not None
        ),
        None,
    )
    packed = list(_pack_search_parts(heading, blocks, None, photo_url))
    all_actions = tuple(action for part in packed for action in part.actions)
    return RenderedSearch(
        "\n\n".join(part.text for part in packed),
        all_actions,
        tuple(packed),
    )


def _unified_result_score(action: SearchAction) -> float:
    """Return a deterministic provider-neutral relevance score in [0, 1]."""
    payload = action.payload
    result = payload.get("result")
    source = payload.get("source")
    if not isinstance(result, dict) or source not in {"rezka", "prowlarr"}:
        return 0.0
    result_index = payload.get("result_index")
    rank = (
        result_index
        if isinstance(result_index, int)
        and not isinstance(result_index, bool)
        and result_index > 0
        else _MAX_SOURCE_RESULTS + 1
    )
    rank_score = 1.0 / rank
    match_score = 0.0
    preference_score = 0.0
    readiness_score = 0.0

    if source == "prowlarr":
        ranking = result.get("ranking")
        if isinstance(ranking, dict):
            exact_title = ranking.get("exact_title") is True
            exact_season = ranking.get("exact_season") is True
            requested_season = payload.get("season")
            match_score = (0.7 if exact_title else 0.0) + (
                0.3
                if exact_season
                and isinstance(requested_season, int)
                and requested_season > 0
                else 0.0
            )
            preferences = [
                ranking.get(key)
                for key in (
                    "quality_preference",
                    "language_preference",
                    "codec_preference",
                    "release_group_preference",
                )
            ]
            normalized = [
                min(value, 4) / 4
                for value in preferences
                if isinstance(value, int) and not isinstance(value, bool) and value >= 0
            ]
            if normalized:
                preference_score = sum(normalized) / len(normalized)
        seeders = result.get("seeders")
        if isinstance(seeders, int) and not isinstance(seeders, bool) and seeders > 0:
            readiness_score = min(math.log1p(seeders) / math.log(101), 1.0)
    else:
        match_score = _rezka_scope_match(result, payload)
        translations = result.get("translations")
        if isinstance(translations, list) and translations:
            readiness_score = min(len(translations) / 10, 1.0)

    return round(
        min(
            1.0,
            0.55 * rank_score
            + 0.25 * match_score
            + 0.12 * preference_score
            + 0.08 * readiness_score,
        ),
        6,
    )


def _rezka_scope_match(result: dict, payload: dict) -> float:
    season = payload.get("season")
    episode = payload.get("episode")
    if not isinstance(season, int) or isinstance(season, bool) or season < 1:
        return 0.5
    availability = result.get("availability")
    seasons = availability.get("seasons") if isinstance(availability, dict) else None
    if not isinstance(seasons, list):
        return 0.5
    for item in seasons:
        if not isinstance(item, dict) or item.get("season") != season:
            continue
        episodes = item.get("episodes")
        if isinstance(episode, int) and not isinstance(episode, bool) and episode > 0:
            return 1.0 if isinstance(episodes, list) and episode in episodes else 0.0
        return 1.0
    return 0.0


def _unified_search_heading(season: object, episode: object) -> str:
    if not isinstance(season, int) or isinstance(season, bool) or season < 1:
        return "🔎 Варианты"
    if not isinstance(episode, int) or isinstance(episode, bool) or episode < 1:
        return f"🔎 Варианты · сезон {season}"
    return f"🔎 Варианты · S{season:02}E{episode:02}"


def _unified_result_block(
    action: SearchAction,
    unified_index: int,
) -> tuple[list[str], SearchAction] | None:
    payload = action.payload
    source = payload.get("source")
    result = payload.get("result")
    title = _bounded_text(payload.get("title"), 500)
    if (
        source not in {"rezka", "prowlarr"}
        or not isinstance(result, dict)
        or title is None
    ):
        return None

    provider = "Rezka" if source == "rezka" else "Prowlarr"
    metadata = [provider]
    if source == "rezka":
        year = result.get("year")
        if isinstance(year, int) and not isinstance(year, bool) and 1888 <= year <= 3000:
            metadata.append(str(year))
        translations = result.get("translations")
        if isinstance(translations, list):
            metadata.append(_voiceover_count(len(translations)))
    else:
        size = _format_size(result.get("size_bytes"))
        if size is not None:
            metadata.append(size)
        seeders = result.get("seeders")
        if isinstance(seeders, int) and not isinstance(seeders, bool) and seeders >= 0:
            metadata.append(f"{seeders} сидов")

    normalized_action = SearchAction(
        label=str(unified_index),
        kind=action.kind,
        payload={**payload, "unified_index": unified_index},
        expires_at=action.expires_at,
    )
    return (
        [f"{unified_index}. {_button_label(title, limit=56)}", f"   {' · '.join(metadata)}"],
        normalized_action,
    )


def _variant_count(count: int) -> str:
    remainder = count % 100
    if 11 <= remainder <= 14:
        noun = "вариантов"
    elif count % 10 == 1:
        noun = "вариант"
    elif count % 10 in {2, 3, 4}:
        noun = "варианта"
    else:
        noun = "вариантов"
    return f"{count} {noun}"


def _voiceover_count(count: int) -> str:
    remainder = count % 100
    if 11 <= remainder <= 14:
        noun = "озвучек"
    elif count % 10 == 1:
        noun = "озвучка"
    elif count % 10 in {2, 3, 4}:
        noun = "озвучки"
    else:
        noun = "озвучек"
    return f"{count} {noun}"


def _split_search_result(
    lines: list[str], actions: list[SearchAction]
) -> list[tuple[list[str], list[SearchAction]]]:
    normalized = [line.lstrip("\n") for line in lines]
    if len(actions) <= _MAX_SEARCH_CARD_ACTIONS:
        return [(normalized, actions)]
    prefix = normalized[:2]
    detail_lines = normalized[2:]
    blocks = []
    for offset in range(0, len(actions), _MAX_SEARCH_CARD_ACTIONS):
        chunk = actions[offset : offset + _MAX_SEARCH_CARD_ACTIONS]
        chunk_lines = detail_lines[offset : offset + len(chunk)]
        label = (
            prefix[1]
            if offset == 0
            else f"   Озвучки {offset + 1}–{offset + len(chunk)}:"
        )
        blocks.append(([prefix[0], label, *chunk_lines], chunk))
    return blocks


def _pack_search_parts(
    heading: str,
    blocks: list[tuple[list[str], list[SearchAction]]],
    continuation: SearchAction | None,
    photo_url: str | None = None,
) -> tuple[RenderedSearchPart, ...]:
    parts = []
    current_blocks = []
    current_actions = []
    text_limit = 1000 if photo_url else _MAX_SEARCH_CARD_TEXT

    def flush() -> None:
        if not current_blocks:
            return
        text = f"{heading}\n\n" + "\n".join(
            "\n".join(block) for block in current_blocks
        )
        parts.append(RenderedSearchPart(text, tuple(current_actions), photo_url))
        current_blocks.clear()
        current_actions.clear()

    for block_lines, block_actions in blocks:
        candidate_blocks = [*current_blocks, block_lines]
        candidate_text = f"{heading}\n\n" + "\n".join(
            "\n".join(block) for block in candidate_blocks
        )
        if current_blocks and (
            len(candidate_text) > text_limit
            or len(current_actions) + len(block_actions) > _MAX_SEARCH_CARD_ACTIONS
        ):
            flush()
        current_blocks.append(block_lines)
        current_actions.extend(block_actions)
    flush()
    if not parts:
        parts.append(RenderedSearchPart(heading, (), photo_url))
    if continuation is not None:
        last = parts[-1]
        if len(last.actions) < _MAX_SEARCH_CARD_ACTIONS:
            parts[-1] = RenderedSearchPart(
                last.text,
                (*last.actions, continuation),
                last.photo_url,
            )
        else:
            parts.append(
                RenderedSearchPart(
                    f"{heading}\n\n➡️ Доступны дополнительные результаты.",
                    (continuation,),
                    photo_url,
                )
            )
    return tuple(parts)


def _render_rezka_result(
    result: dict,
    result_index: int,
    session_id: str,
    result_id: str,
    title: str,
    expires_at: str,
    season: int,
    episode: int,
) -> tuple[list[str], list[SearchAction]] | None:
    details = []
    year = result.get("year")
    if isinstance(year, int) and not isinstance(year, bool) and 1888 <= year <= 3000:
        details.append(str(year))
    episode_range = _rezka_episode_range(result.get("availability"), season)
    if episode_range is not None:
        details.append(f"общий диапазон {episode_range}")
    display_title = _button_label(title, limit=46)
    translations = result.get("translations")
    if not isinstance(translations, list):
        return None
    valid_translations = [
        translation
        for translation in translations
        if isinstance(translation, dict)
        and isinstance(translation.get("id"), int)
        and not isinstance(translation.get("id"), bool)
        and translation.get("id") >= 0
        and _bounded_text(translation.get("name"), 120) is not None
    ]
    if translations and len(valid_translations) != len(translations):
        return None
    details.append(
        f"🎙 {_voiceover_count(len(valid_translations))}"
        if valid_translations
        else "🎙 нет"
    )
    suffix = f" · {' · '.join(details)}" if details else ""
    lines = [f"\n{result_index}. {display_title}{suffix}"]
    return lines, [_release_details_action(
        source="rezka",
        result=result,
        result_index=result_index,
        session_id=session_id,
        result_id=result_id,
        title=title,
        expires_at=expires_at,
        season=season,
        episode=episode,
    )]


def _render_prowlarr_result(
    result: dict,
    result_index: int,
    session_id: str,
    result_id: str,
    title: str,
    expires_at: str,
    season: int,
    episode: int,
) -> tuple[list[str], list[SearchAction]]:
    details = []
    size = _format_size(result.get("size_bytes"))
    if size is not None:
        details.append(size)
    seeders = result.get("seeders")
    if isinstance(seeders, int) and not isinstance(seeders, bool) and seeders >= 0:
        details.append(f"{seeders} сидов")
    display_title = _button_label(title, limit=46)
    suffix = f" · {' · '.join(details)}" if details else ""
    lines = [f"\n{result_index}. {display_title}{suffix}"]
    return lines, [_release_details_action(
        source="prowlarr",
        result=result,
        result_index=result_index,
        session_id=session_id,
        result_id=result_id,
        title=title,
        expires_at=expires_at,
        season=season,
        episode=episode,
    )]


def _release_details_action(
    *,
    source: str,
    result: dict,
    result_index: int,
    session_id: str,
    result_id: str,
    title: str,
    expires_at: str,
    season: int,
    episode: int,
) -> SearchAction:
    return SearchAction(
        label=f"🔎 {result_index}",
        kind="release-details",
        payload={
            "source": source,
            "session_id": session_id,
            "result_id": result_id,
            "result_index": result_index,
            "result": result,
            "season": season,
            "episode": episode,
            "title": title,
        },
        expires_at=expires_at,
    )


def _render_release_details(
    payload: dict,
    *,
    search_page: dict | None = None,
    source_back_action: SearchAction | None = None,
) -> RenderedSearch | None:
    source = payload.get("source")
    result = payload.get("result")
    title = _bounded_text(payload.get("title"), 500)
    session_id = _opaque_text(payload.get("session_id"), 128)
    choice_set_id = _opaque_text(payload.get("choice_set_id"), 128)
    result_id = _opaque_text(payload.get("result_id"), 1024)
    season = payload.get("season")
    episode = payload.get("episode")
    expires_at = search_page.get("expires_at") if isinstance(search_page, dict) else None
    if (
        source not in {"rezka", "prowlarr"}
        or not isinstance(result, dict)
        or title is None
        or session_id is None
        or result_id is None
        or not isinstance(season, int)
        or isinstance(season, bool)
        or season < 0
        or not isinstance(episode, int)
        or isinstance(episode, bool)
        or episode < 0
        or not isinstance(expires_at, str)
    ):
        return None
    photo_url = _thumbnail_url(result)

    provider = "Rezka" if source == "rezka" else "Prowlarr"
    result_index = payload.get("result_index")
    lines = [f"{'📺' if season > 0 else '🎬'} {title}"]
    lines.append(f"{'🌐' if source == 'rezka' else '🧲'} {provider}")
    if season > 0:
        lines.append(
            f"🆕 S{season:02d}E{episode:02d}"
            if episode > 0
            else f"📚 S{season:02d}"
        )
    detail_lines: list[str] = []
    download_actions: list[SearchAction] = []
    if source == "rezka":
        tracking_context = payload.get("tracking_context")
        provider_media_ref = _rezka_provider_media_ref(result_id)
        tracking_mode = isinstance(tracking_context, dict)
        if tracking_mode and provider_media_ref is None:
            return None
        year = result.get("year")
        if isinstance(year, int) and not isinstance(year, bool) and 1888 <= year <= 3000:
            detail_lines.append(f"📅 {year}")
        episode_range = _rezka_episode_range(result.get("availability"), season)
        if episode_range is not None:
            detail_lines.append(
                f"📺 Общий диапазон {episode_range} · доступность зависит от озвучки"
            )
        translations = result.get("translations")
        if not isinstance(translations, list):
            return None
        translations = [
            translation
            for translation in translations
            if isinstance(translation, dict)
            and (
                "premium" not in translation
                or translation.get("premium") is False
            )
        ]
        if season > 0:
            translations = [
                translation
                for translation in translations
                if isinstance(translation, dict)
                and (
                    (available := _translation_available_episodes(translation, season))
                    is None
                    or (episode > 0 and episode in available)
                    or (episode == 0 and bool(available))
                )
            ]
        translation_index = payload.get("translation_index", 1)
        if (
            not isinstance(translation_index, int)
            or isinstance(translation_index, bool)
            or translation_index < 1
        ):
            return None
        if not translations:
            detail_lines.append("⚠️ Озвучек нет")
        else:
            if translation_index > len(translations):
                return None
            translation = translations[translation_index - 1]
            translation_id = translation.get("id")
            translation_name = _bounded_text(translation.get("name"), 120)
            if (
                not isinstance(translation_id, int)
                or isinstance(translation_id, bool)
                or translation_id < 0
                or translation_name is None
            ):
                return None
            display_translation_name = _translation_display_name(translation_name)
            detail_lines.append(f"🎙 {display_translation_name}")
            episode_count = _translation_episode_count(translation, season)
            availability_label = _episode_count_label(episode_count)
            metadata = []
            if availability_label is not None:
                metadata.append(f"📺 {availability_label}")
            metadata.extend(f"⚠️ {flag}" for flag in _translation_flags(translation))
            if metadata:
                detail_lines.append(" · ".join(metadata))

            base_payload = {
                **payload,
                "search_page": search_page,
                "source_back": _source_back_payload(source_back_action),
            }

            def translation_action(index: int, label: str) -> SearchAction:
                return SearchAction(
                    label=label,
                    kind="release-page",
                    payload={**base_payload, "translation_index": index},
                    expires_at=expires_at,
                )

            def translation_noop(label: str) -> SearchAction:
                return SearchAction(label, "noop", {}, expires_at)

            download_actions.extend((
                translation_action(translation_index - 1, "⬅️")
                if translation_index > 1
                else translation_noop("⬅️"),
                translation_noop(f"🎙 {translation_index}/{len(translations)}"),
                translation_action(translation_index + 1, "➡️")
                if translation_index < len(translations)
                else translation_noop("➡️"),
            ))
            action_kind = (
                "tracking-enable-download"
                if tracking_mode and tracking_context.get("mode") == "configure"
                else "tracking-create"
                if tracking_mode
                else "download"
            )
            download_actions.append(SearchAction(
                label=(
                    "✅ Выбрать"
                    if tracking_mode
                    else "✅ В загрузках"
                    if isinstance(payload.get("downloaded_job_id"), str)
                    else "⬇️ Скачать"
                ),
                kind=(
                    "job-open"
                    if not tracking_mode
                    and isinstance(payload.get("downloaded_job_id"), str)
                    else action_kind
                ),
                payload={
                    "source": "rezka",
                    "session_id": session_id,
                    "choice_set_id": choice_set_id,
                    "result_id": result_id,
                    "translation_id": translation_id,
                    "season": season,
                    "episode": episode,
                    "title": title,
                    "translation": translation_name,
                    "available_episode_count": episode_count,
                    "source_back": _source_back_payload(source_back_action),
                    "full_width": True,
                    **(
                        {
                            "job_id": payload["downloaded_job_id"],
                            "source_back": _source_back_payload(
                                SearchAction(
                                    "⬅️ Назад к релизу",
                                    "release-page",
                                    dict(payload),
                                    expires_at,
                                )
                            ),
                        }
                        if not tracking_mode
                        and isinstance(payload.get("downloaded_job_id"), str)
                        else {
                            "release_back": _source_back_payload(
                                SearchAction(
                                    "⬅️ Назад к релизу",
                                    "release-page",
                                    dict(base_payload),
                                    expires_at,
                                )
                            )
                        }
                        if not tracking_mode
                        else {}
                    ),
                    **(
                        {
                            "tracking_context": tracking_context,
                            "provider_media_ref": provider_media_ref,
                        }
                        if tracking_mode
                        else {}
                    ),
                },
                expires_at=expires_at,
            ))
    else:
        details = []
        ranking = result.get("ranking")
        if payload.get("result_index") == 1:
            details.append("⭐ Лучшее совпадение")
        quality, source_type, codec, languages = _release_traits(title)
        if quality:
            details.append(f"💎 {quality}")
        if source_type:
            details.append(f"🎞 {source_type}")
        if codec:
            details.append(f"⚙️ {codec}")
        if languages:
            details.append(f"🌍 {', '.join(languages)}")
        size = _format_size(result.get("size_bytes"))
        seeders = result.get("seeders")
        leechers = result.get("leechers")
        if size is not None:
            details.append(f"📦 {size}")
        if isinstance(seeders, int) and not isinstance(seeders, bool) and seeders >= 0:
            details.append(f"🌱 {seeders} сидов")
        if isinstance(leechers, int) and not isinstance(leechers, bool) and leechers >= 0:
            details.append(f"🧲 {leechers} личей")
        age_days = result.get("age_days")
        if isinstance(age_days, int) and not isinstance(age_days, bool) and age_days >= 0:
            details.append(f"📅 {_format_age(age_days)}")
        for key, label in (("indexer", "🔎"), ("release_group", "🎙")):
            value = _bounded_text(result.get(key), 120)
            if value is not None:
                details.append(f"{label} {value}")
        if details:
            detail_lines.extend(("", *details))
        download_actions.append(SearchAction(
            label=(
                "✅ В загрузках"
                if isinstance(payload.get("downloaded_job_id"), str)
                else "⬇️ Скачать"
            ),
            kind=(
                "job-open"
                if isinstance(payload.get("downloaded_job_id"), str)
                else "download"
            ),
            payload={
                "source": "prowlarr",
                "session_id": session_id,
                "choice_set_id": choice_set_id,
                "result_id": result_id,
                "season": season,
                "episode": episode,
                "title": title,
                "source_back": _source_back_payload(source_back_action),
                "full_width": True,
                **(
                    {
                        "job_id": payload["downloaded_job_id"],
                        "source_back": _source_back_payload(
                            SearchAction(
                                "⬅️ Назад к релизу",
                                "release-page",
                                dict(payload),
                                expires_at,
                            )
                        ),
                    }
                    if isinstance(payload.get("downloaded_job_id"), str)
                    else {
                        "release_back": _source_back_payload(
                            SearchAction(
                                "⬅️ Назад к релизу",
                                "release-page",
                                {
                                    **payload,
                                    "search_page": search_page,
                                    "source_back": _source_back_payload(source_back_action),
                                },
                                expires_at,
                            )
                        )
                    }
                ),
            },
            expires_at=expires_at,
        ))

        website_url = _website_url(result)
        if website_url is not None:
            download_actions.insert(0, SearchAction(
                label="🌐 Сайт",
                kind="website",
                payload={"url": website_url, "full_width": True},
                expires_at=expires_at,
            ))

    navigation = _release_navigation_actions(
        payload,
        search_page,
        source_back_action,
        expires_at,
    )
    download_actions = [*navigation, *download_actions]

    footer_actions: list[SearchAction] = []
    back_payload = {
        "search_page": search_page,
        "source_back": _source_back_payload(source_back_action),
        "combined_context": payload.get("combined_context"),
        "combined_page": payload.get("combined_page", 0),
        "season": season,
        "episode": episode,
        "tracking_context": payload.get("tracking_context"),
    }
    footer_actions.append(
        source_back_action
        if payload.get("direct_back") is True and source_back_action is not None
        else SearchAction(
            label="⬅️ Назад",
            kind="release-back",
            payload=back_payload,
            expires_at=expires_at,
        )
    )

    parts: list[RenderedSearchPart] = [
        RenderedSearchPart(
            "\n".join([*lines, *detail_lines]),
            tuple(download_actions),
            photo_url,
        )
    ]

    if len(parts[-1].actions) + len(footer_actions) <= _MAX_SEARCH_CARD_ACTIONS:
        parts[-1] = RenderedSearchPart(
            parts[-1].text,
            (*parts[-1].actions, *footer_actions),
            parts[-1].photo_url,
        )
    else:
        parts.append(RenderedSearchPart(
            f"🔎 {provider} · продолжение\n\n⬅️ Навигация по карточке",
            tuple(footer_actions),
            photo_url,
        ))
    return RenderedSearch(
        "\n\n".join(part.text for part in parts),
        tuple(action for part in parts for action in part.actions),
        tuple(parts),
    )


def _search_heading(provider: str, season: int, episode: int) -> str:
    if season < 1:
        return f"🔎 {provider} · фильм"
    if episode < 1:
        return f"🔎 {provider} · сезон {season}"
    return f"🔎 {provider} · S{season:02}E{episode:02}"


def _thumbnail_url(result: dict) -> str | None:
    value = _bounded_text(result.get("thumbnail_url"), 2048)
    if value is None or not value.startswith(("https://", "http://")):
        return None
    return value


def _website_url(result: dict) -> str | None:
    value = _bounded_text(result.get("website_url"), 2048)
    if value is None or not value.startswith(("https://", "http://")):
        return None
    return value


def _rezka_provider_media_ref(result_id: str) -> str | None:
    match = re.fullmatch(r"rezka:([1-9]\d*)", result_id)
    return match.group(1) if match is not None else None


def _format_age(days: int) -> str:
    if days == 0:
        return "сегодня"
    if days == 1:
        return "1 день назад"
    if 2 <= days <= 4:
        return f"{days} дня назад"
    return f"{days} дней назад"


def _release_traits(title: str) -> tuple[str | None, str | None, str | None, tuple[str, ...]]:
    upper = title.upper()
    quality_match = re.search(r"\b(4320P|2160P|1080P|720P|576P|480P)\b", upper)
    quality = quality_match.group(1).lower().replace("p", "p") if quality_match else None
    source_type = next(
        (label for token, label in (
            ("WEB-DL", "WEB-DL"),
            ("WEBDL", "WEB-DL"),
            ("WEBRIP", "WEBRip"),
            ("BLURAY", "Blu-ray"),
            ("BDREMUX", "BDRemux"),
            ("HDTV", "HDTV"),
        ) if token in upper),
        None,
    )
    codec = next(
        (label for token, label in (
            ("H.265", "HEVC"), ("H265", "HEVC"), ("X265", "HEVC"), ("HEVC", "HEVC"),
            ("H.264", "AVC"), ("H264", "AVC"), ("X264", "AVC"), ("AVC", "AVC"),
            ("AV1", "AV1"),
        ) if token in upper),
        None,
    )
    languages = tuple(
        label for token, label in (("RUS", "ru"), ("UKR", "uk"), ("ENG", "en"))
        if re.search(rf"(?:^|[^A-Z]){token}(?:[^A-Z]|$)", upper)
    )
    return quality, source_type, codec, languages


def _release_navigation_actions(
    payload: dict,
    search_page: dict | None,
    source_back_action: SearchAction | None,
    expires_at: str,
) -> list[SearchAction]:
    if not isinstance(search_page, dict) or not isinstance(search_page.get("results"), list):
        return []
    results = search_page["results"]
    current = payload.get("result_index")
    if not isinstance(current, int) or isinstance(current, bool) or not (1 <= current <= len(results)):
        return []
    has_more = isinstance(search_page.get("continuation"), str) and bool(
        search_page["continuation"]
    )
    if len(results) == 1 and not has_more:
        return []

    def action(index: int, label: str) -> SearchAction:
        result = results[index - 1]
        result_id = result.get("result_id") if isinstance(result, dict) else None
        result_source = (
            result.get("_choice_source")
            if isinstance(result, dict)
            else None
        )
        result_session = (
            result.get("_choice_session_id")
            if isinstance(result, dict)
            else None
        )
        target = {
            **payload,
            "result": result,
            "result_id": result_id,
            "result_index": index,
            "translation_index": 1,
            "search_page": search_page,
            "source_back": _source_back_payload(source_back_action),
        }
        result_title = _bounded_text(result.get("title")) if isinstance(result, dict) else None
        if result_title is not None:
            target["title"] = result_title
        if result_source in {"rezka", "prowlarr"}:
            target["source"] = result_source
        if isinstance(result_session, str) and result_session:
            target["session_id"] = result_session
        result_choice_set = (
            result.get("_choice_set_id") if isinstance(result, dict) else None
        )
        if isinstance(result_choice_set, str) and result_choice_set:
            target["choice_set_id"] = result_choice_set
        return SearchAction(label, "release-page", target, expires_at)

    def noop(label: str) -> SearchAction:
        return SearchAction(label, "noop", {}, expires_at)

    total_label = f"{len(results)}+" if has_more else str(len(results))
    previous = action(current - 1, "⬅️") if current > 1 else noop("⬅️")
    position = noop(f"{current}/{total_label}")
    if current < len(results):
        following = action(current + 1, "➡️")
    elif has_more:
        continuation_payload = {
            "source": payload["source"],
            "continuation": search_page["continuation"],
            "season": payload["season"],
            "episode": payload["episode"],
            "source_back": _source_back_payload(source_back_action),
            "carousel_page": search_page,
        }
        if isinstance(payload.get("tracking_context"), dict):
            continuation_payload["tracking_context"] = payload["tracking_context"]
        if payload.get("direct_back") is True:
            continuation_payload["direct_back"] = True
        following = SearchAction(
            label="➡️",
            kind="continue",
            payload=continuation_payload,
            expires_at=expires_at,
        )
    else:
        following = noop("➡️")
    return [previous, position, following]


def _source_back_payload(action: SearchAction | None) -> dict | None:
    if action is None:
        return None
    return {
        "kind": action.kind,
        "payload": action.payload,
        "expires_at": action.expires_at,
    }


def _source_back_action(payload: dict | None) -> SearchAction | None:
    if not isinstance(payload, dict):
        return None
    kind = payload.get("kind")
    action_payload = payload.get("payload")
    expires_at = payload.get("expires_at")
    if (
        kind not in {
            "source-back",
            "navigation-back",
            "all-search-back",
            "tracking-back",
            "release-page",
        }
        or not isinstance(action_payload, dict)
        or not isinstance(expires_at, str)
    ):
        return None
    return SearchAction(
        label="⬅️ Назад",
        kind=kind,
        payload=action_payload,
        expires_at=expires_at,
    )


def _rezka_episode_range(availability, season: int) -> str | None:
    seasons = availability.get("seasons") if isinstance(availability, dict) else None
    if not isinstance(seasons, list):
        return None
    for item in seasons:
        if not isinstance(item, dict) or item.get("season") != season:
            continue
        episodes = item.get("episodes")
        if not isinstance(episodes, list):
            return None
        valid = sorted(
            episode
            for episode in episodes
            if isinstance(episode, int) and not isinstance(episode, bool) and episode > 0
        )
        if not valid:
            return None
        return str(valid[0]) if len(valid) == 1 else f"{valid[0]}–{valid[-1]}"
    return None


def _translation_episode_count(translation: dict, season: int) -> int | None:
    episodes = _translation_available_episodes(translation, season)
    return len(episodes) if episodes else None


def _translation_available_episodes(
    translation: dict, season: int
) -> set[int] | None:
    seasons = translation.get("seasons")
    if not isinstance(seasons, list):
        return None
    for item in seasons:
        if not isinstance(item, dict) or item.get("season") != season:
            continue
        episodes = item.get("episodes")
        if not isinstance(episodes, list):
            return None
        return {
            episode
            for episode in episodes
            if isinstance(episode, int)
            and not isinstance(episode, bool)
            and episode > 0
        }
    return set()


def _episode_count_label(count: int | None) -> str | None:
    if count is None or count < 1:
        return None
    remainder_100 = count % 100
    remainder_10 = count % 10
    if 11 <= remainder_100 <= 14:
        noun = "серий"
    elif remainder_10 == 1:
        noun = "серия"
    elif 2 <= remainder_10 <= 4:
        noun = "серии"
    else:
        noun = "серий"
    return f"{count} {noun}"


def _translation_flags(translation: dict) -> list[str]:
    return [
        label
        for key, label in (
            ("premium", "Premium"),
            ("director", "режиссёрская"),
            ("camrip", "CAM"),
            ("has_ads", "с рекламой"),
        )
        if translation.get(key) is True
    ]


def _translation_display_name(value: str) -> str:
    match = _TRANSLATION_ALIAS_RE.fullmatch(value.strip())
    if match is None or re.fullmatch(
        r"[А-Яа-яЁё-]+", match.group("label").strip()
    ) is None:
        return value
    key = (
        match.group("label").casefold().strip(),
        match.group("alias").casefold().strip(),
    )
    return _VERIFIED_TRANSLATION_ALIASES.get(key, value)


def _button_label(value: str, limit: int = 60) -> str:
    return value if len(value) <= limit else f"{value[: limit - 1]}…"


def _tracking_context(output: bytes, tracking_id: str) -> dict | None:
    try:
        value = json.loads(output.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    tracking = value.get("tracking") if isinstance(value, dict) else None
    if not isinstance(tracking, list):
        return None
    for item in tracking:
        if not isinstance(item, dict) or item.get("id") != tracking_id:
            continue
        title = _bounded_text(item.get("title"))
        if title is None:
            return None
        context = {"title": title}
        release_identity = item.get("release_identity")
        release_source = (
            _bounded_text(release_identity.get("source"), 32)
            if isinstance(release_identity, dict)
            else None
        )
        release_source_id = (
            release_identity.get("source_id")
            if isinstance(release_identity, dict)
            else None
        )
        if (
            release_source is not None
            and isinstance(release_source_id, int)
            and not isinstance(release_source_id, bool)
            and release_source_id > 0
        ):
            context["release_source"] = release_source
            context["release_source_id"] = release_source_id
        return context
    return None


def _tracking_title(output: bytes, tracking_id: str) -> str | None:
    context = _tracking_context(output, tracking_id)
    return context.get("title") if context is not None else None


async def _tracking_pages(run_media, ctx, view: str = "diagnostic") -> tuple[int, bytes]:
    items: list[dict] = []
    cursor = None
    seen_cursors: set[str] = set()
    for _ in range(100):
        arguments = {"limit": 50, "view": view}
        if cursor is not None:
            arguments["cursor"] = cursor
        code, output = await run_media(
            ("mcp__media_admin__media_tracking_list", arguments), ctx
        )
        if code != 0:
            return code, output
        try:
            payload = json.loads(output.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return 1, b'{"error":{"code":"invalid_tracking_page"}}'
        page = payload.get("tracking") if isinstance(payload, dict) else None
        if isinstance(page, list):
            items.extend(item for item in page if isinstance(item, dict))
        next_cursor = payload.get("next_cursor") if isinstance(payload, dict) else None
        if not isinstance(next_cursor, str) or not next_cursor:
            return 0, json.dumps({"tracking": items}).encode("utf-8")
        if next_cursor in seen_cursors:
            return 1, b'{"error":{"code":"cyclic_tracking_cursor"}}'
        seen_cursors.add(next_cursor)
        cursor = next_cursor
    return 1, b'{"error":{"code":"tracking_page_limit"}}'


def _release_match_context(output: bytes) -> dict | None:
    try:
        value = json.loads(output.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    show = value.get("show") if isinstance(value, dict) else None
    if value.get("status") != "matched" or not isinstance(show, dict):
        return None
    title = _bounded_text(show.get("title"))
    if title is None:
        return None
    context = {"title": title}
    original_title = _bounded_text(show.get("original_title"))
    if original_title is not None:
        context["original_title"] = original_title
    year = show.get("year")
    if isinstance(year, int) and not isinstance(year, bool):
        context["year"] = year
    poster_url = _bounded_text(show.get("poster_url"), 2048)
    if poster_url is not None:
        context["poster_url"] = poster_url
    return context


def _normalized_match_text(value: object) -> str:
    text = _bounded_text(value)
    if text is None:
        return ""
    return " ".join(text.casefold().replace("!", " ").split())


def _tracking_result_score(
    result: dict,
    identity: dict,
    season: int,
    episode: int,
) -> tuple[int, int]:
    expected_titles = {
        _normalized_match_text(identity.get("title")),
        _normalized_match_text(identity.get("original_title")),
    } - {""}
    candidate_titles = {
        _normalized_match_text(result.get("title")),
        _normalized_match_text(result.get("original_title")),
    } - {""}
    score = 0
    if expected_titles & candidate_titles:
        score += 200
    elif any(
        expected in candidate or candidate in expected
        for expected in expected_titles
        for candidate in candidate_titles
    ):
        score += 40

    expected_year = identity.get("year")
    candidate_year = result.get("year")
    if isinstance(expected_year, int) and isinstance(candidate_year, int):
        score += 100 if expected_year == candidate_year else -100

    availability = result.get("availability")
    seasons = availability.get("seasons") if isinstance(availability, dict) else None
    if isinstance(seasons, list):
        for item in seasons:
            if not isinstance(item, dict) or item.get("season") != season:
                continue
            episodes = item.get("episodes")
            if isinstance(episodes, list) and episode in episodes:
                score += 25
                break
    translations = result.get("translations")
    translation_count = len(translations) if isinstance(translations, list) else 0
    return score, translation_count


def _rank_tracking_search_output(
    output: bytes,
    source: str,
    identity: dict | None,
    season: int,
    episode: int,
) -> bytes:
    if source != "rezka" or identity is None:
        return output
    try:
        value = json.loads(output.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return output
    results = value.get("results") if isinstance(value, dict) else None
    if not isinstance(results, list) or not all(isinstance(item, dict) for item in results):
        return output
    ranked = sorted(
        enumerate(results),
        key=lambda pair: (
            *_tracking_result_score(pair[1], identity, season, episode),
            -pair[0],
        ),
        reverse=True,
    )
    value["results"] = [result for _, result in ranked]
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
