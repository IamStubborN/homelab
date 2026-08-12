"""Deterministic Telegram media commands backed by media-service MCP tools."""

from __future__ import annotations

import json


def _command_payload(ctx, tool: str, arguments: dict) -> dict:
    """Dispatch one MCP tool and unwrap Hermes' stable JSON envelope."""
    raw = ctx.dispatch_tool(tool, arguments)
    try:
        envelope = json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, json.JSONDecodeError) as exc:
        raise ValueError("media tool returned an invalid response") from exc
    if not isinstance(envelope, dict) or "error" in envelope:
        raise ValueError("media tool request failed")

    payload = envelope.get("structuredContent", envelope.get("result"))
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise ValueError("media tool returned an invalid payload") from exc
    if isinstance(payload, dict) and set(payload) == {"result"}:
        payload = payload["result"]
    if not isinstance(payload, dict):
        raise ValueError("media tool returned an invalid payload")
    return payload


def _positive_page(raw_args: str) -> int:
    value = raw_args.strip()
    if not value:
        return 1
    if not value.isdigit() or int(value) < 1:
        raise ValueError("page must be a positive integer")
    return int(value)


def _render_trending_command(ctx, raw_args: str, category: str) -> str:
    labels = {
        "all": "🔥 Тренды TMDB за неделю",
        "movie": "🎬 Топ фильмов TMDB за неделю",
        "tv": "📺 Топ сериалов TMDB за неделю",
    }
    command = {"all": "trending", "movie": "movies", "tv": "series"}[category]
    try:
        page = _positive_page(raw_args)
        payload = _command_payload(
            ctx,
            "mcp__media_admin__media_trending",
            {"category": category, "page": page},
        )
    except ValueError:
        return f"⚠️ Не удалось получить данные TMDB. Использование: /{command} [страница]"

    results = payload.get("results")
    if not isinstance(results, list) or not results:
        return f"{labels[category]}\n\nНа этой странице ничего не найдено."

    lines = [labels[category], ""]
    for index, item in enumerate(results[:10], start=1):
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "Без названия")
        original = item.get("original_title")
        if isinstance(original, str) and original and original != title:
            title = f"{title} / {original}"
        year = f" ({item['year']})" if isinstance(item.get("year"), int) else ""
        rating = item.get("rating")
        rating_text = f" · ⭐ {rating:.1f}" if isinstance(rating, (int, float)) else ""
        kind = item.get("media_type")
        kind_text = " · фильм" if category == "all" and kind == "movie" else ""
        if category == "all" and kind == "tv":
            kind_text = " · сериал"
        lines.append(f"{index}. {title}{year}{kind_text}{rating_text}")

    current = payload.get("page") if isinstance(payload.get("page"), int) else page
    total = payload.get("total_pages")
    if isinstance(total, int) and current < total:
        lines.extend(("", f"➡️ Ещё: /{command} {current + 1}"))
    return "\n".join(lines)


def _render_watching_command(ctx, _raw_args: str) -> str:
    try:
        payload = _command_payload(
            ctx,
            "mcp__media_admin__plex_now_playing",
            {},
        )
    except ValueError:
        return "⚠️ Сейчас не удалось проверить Plex."

    container = payload.get("MediaContainer")
    sessions = container.get("Metadata") if isinstance(container, dict) else None
    if not isinstance(sessions, list) or not sessions:
        return "📺 Сейчас в Plex никто ничего не смотрит."

    lines = ["📺 Сейчас смотрят", ""]
    for item in sessions[:10]:
        if not isinstance(item, dict):
            continue
        title = str(item.get("grandparentTitle") or item.get("title") or "Без названия")
        if item.get("type") == "episode":
            season = item.get("parentIndex")
            episode = item.get("index")
            if isinstance(season, int) and isinstance(episode, int):
                title += f" · S{season:02}E{episode:02}"
        user = item.get("User")
        player = item.get("Player")
        details = []
        if isinstance(user, dict) and isinstance(user.get("title"), str):
            details.append(user["title"])
        if isinstance(player, dict) and isinstance(player.get("title"), str):
            details.append(player["title"])
        if isinstance(player, dict) and player.get("state") in {
            "playing",
            "paused",
            "buffering",
        }:
            details.append(
                {
                    "playing": "воспроизведение",
                    "paused": "пауза",
                    "buffering": "буферизация",
                }[player["state"]]
            )
        offset = item.get("viewOffset")
        duration = item.get("duration")
        if (
            isinstance(offset, (int, float))
            and isinstance(duration, (int, float))
            and duration > 0
        ):
            details.append(f"{min(100, max(0, round(offset * 100 / duration)))}%")
        suffix = f" — {' · '.join(details)}" if details else ""
        lines.append(f"• {title}{suffix}")
    return "\n".join(lines)
