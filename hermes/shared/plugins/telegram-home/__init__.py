"""Supported Hermes plugin extensions for the official Telegram adapter."""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from contextlib import suppress
from dataclasses import replace
import json
import logging
import os
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from html import unescape
from pathlib import Path
from types import SimpleNamespace

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, InputFile, InputMediaPhoto
from telegram.error import BadRequest, TelegramError

from plugins.platforms.telegram.adapter import (
    TelegramAdapter,
    _apply_yaml_config,
    _is_connected,
    _resolve_notifications_mode,
    _standalone_send,
    check_telegram_requirements,
    interactive_setup,
)

from .media_action_store import (
    BusinessActionReceiptStore,
    MediaActionStore,
    MediaNavigationStore,
    _DEFAULT_BUSINESS_ACTION_RECEIPTS_FILE,
    _DEFAULT_MEDIA_ACTIONS_FILE,
    _DEFAULT_MEDIA_NAVIGATION_FILE,
    _BUSINESS_ACTION_CLAIM_TTL_SECONDS,
    _MEDIA_ACTION_CLAIM_TTL_SECONDS,
)
from .media_callbacks import (
    _BARE_INTERNAL_ID_RE,
    _CALLBACK_RE,
    _DOWNLOAD_ACTION_CALLBACK_RE,
    _PRESENTATION_CALLBACK_RE,
    _PRESENTATION_COMMANDS,
    _SOURCE_BACK_CALLBACK_RE,
    _SOURCE_CHOICE_CALLBACK_RE,
    _answer_claimed_callback,
    _created_job_id,
    _is_expired_callback_query,
    _media_mcp_operation,
)
from .media_commands import (
    _command_payload,
    _render_trending_command,
    _render_watching_command,
)
from .media_models import RenderedSearch, RenderedSearchPart, SearchAction
from . import media_search as media_search_module
from .media_panel import (
    MediaPanelButton,
    MediaPanelCard,
    _MEDIA_PANEL_CALLBACK_RE,
    _business_action_generation,
    _markup_from_card,
    _media_panel_home,
    _media_panel_markup,
    _render_job_payload,
    _render_media_panel_section,
    render_job_cancel_error_card,
    render_job_cancel_error_from_card,
    render_job_cancelling_card,
    render_media_panel_card,
    render_tracking_check_failure_card,
    render_tracking_scheduled_card,
)
from .media_search import (
    _bounded_text,
    _combine_source_results,
    _decode_search_page,
    _episode_count_label,
    _media_error_code,
    _render_alternative_search,
    _render_release_details,
    _render_source_search,
    _release_match_context,
    _rank_tracking_search_output,
    _sanitize_details,
    _source_back_action,
    _source_back_payload,
    _tracking_context,
    _tracking_pages,
    _tracking_title,
    _translation_display_name,
)


logger = logging.getLogger(__name__)
from .media_trending import (
    TrendingCard,
    category_from_code,
    kind_from_code,
    render_direct_details,
    render_similar_details,
    render_similar_list,
    render_trending_details,
    render_trending_list,
)
from .notifier_client import (
    NotifierControlClient,
    NotifierControlStaleError,
    NotifierControlUnavailableError,
)

_SEARCH_LOADING_TOAST = "Ищу варианты…"


def _action_markup(
    store: MediaActionStore, actions: tuple[SearchAction, ...]
) -> InlineKeyboardMarkup | None:
    if not actions:
        return None
    # A release card returns to its release list first. The provider/source
    # route is already preserved inside that action and must not appear as a
    # second identically labelled Back button.
    if any(action.kind == "release-back" for action in actions):
        actions = tuple(
            action
            for action in actions
            if action.kind == "release-back"
            or action.label != "⬅️ Назад"
        )
    rows = []
    regular_row = []
    navigation_row = []
    navigation_kinds = {
        "all-search-back",
        "combined-page",
        "continue",
        "navigation-back",
        "release-page",
        "release-back",
        "rendered-page",
        "source-back",
        "tracking-back",
        "noop",
    }

    def flush_regular() -> None:
        if regular_row:
            rows.append(regular_row.copy())
            regular_row.clear()

    def flush_navigation() -> None:
        if navigation_row:
            rows.append(navigation_row.copy())
            navigation_row.clear()

    for action in actions:
        if action.kind == "search-context":
            continue
        if action.kind == "website":
            url = action.payload.get("url")
            if not isinstance(url, str) or not url.startswith(("https://", "http://")):
                continue
            callback_data = None
        elif action.kind == "navigation-back":
            callback_data = "mn:b"
        elif action.kind == "source-back":
            tracking_id = action.payload.get("tracking_id")
            season = action.payload.get("season")
            episode = action.payload.get("episode")
            if (
                not isinstance(tracking_id, str)
                or not isinstance(season, int)
                or isinstance(season, bool)
                or not isinstance(episode, int)
                or isinstance(episode, bool)
            ):
                continue
            callback_data = f"ms:b:{tracking_id}:{season}:{episode}"
        else:
            callback_data = f"md:{store.create(action)}"
        button = (
            InlineKeyboardButton(action.label, url=url)
            if action.kind == "website"
            else InlineKeyboardButton(action.label, callback_data=callback_data)
        )
        if action.payload.get("full_width") is True or action.label == "⬅️ Назад":
            flush_regular()
            flush_navigation()
            rows.append([button])
            continue
        if action.kind in navigation_kinds:
            flush_regular()
            navigation_row.append(button)
            if len(navigation_row) == 3:
                flush_navigation()
        else:
            flush_navigation()
            regular_row.append(button)
            if len(regular_row) == 3:
                flush_regular()
    flush_regular()
    flush_navigation()
    return InlineKeyboardMarkup(rows) if rows else None


async def _dispatch_media_mcp(
    ctx, tool: str, arguments: dict
) -> tuple[int, bytes]:
    """Call one media-service MCP tool without involving the operator CLI."""
    if ctx is None:
        return 127, b'{"error":{"code":"mcp_unavailable"}}'
    try:
        payload = await asyncio.wait_for(
            asyncio.to_thread(_command_payload, ctx, tool, arguments),
            timeout=160,
        )
        return 0, json.dumps(payload, ensure_ascii=False).encode("utf-8")
    except asyncio.TimeoutError:
        return 124, b'{"error":{"code":"mcp_timeout"}}'
    except (ValueError, RuntimeError, OSError, TimeoutError):
        return 1, b'{"error":{"code":"mcp_request_failed"}}'


async def _run_media(
    operation: tuple[str, dict], ctx
) -> tuple[int, bytes]:
    """Compatibility seam for callback tests; production dispatch is MCP-only."""
    tool, arguments = operation
    return await _dispatch_media_mcp(ctx, tool, arguments)


async def _search_media_mcp(
    ctx,
    source: str,
    *,
    query: str | None = None,
    media_kind: str | None = None,
    season: int | None = None,
    tmdb_id: int | None = None,
    continuation: str | None = None,
) -> tuple[int, bytes]:
    arguments: dict[str, object] = {"source": source}
    if continuation is not None:
        arguments["continuation"] = continuation
    else:
        arguments["query"] = query
        arguments["media_kind"] = media_kind
        if season is not None and season > 0:
            arguments["season"] = season
        if tmdb_id is not None and tmdb_id > 0:
            arguments["tmdb_id"] = tmdb_id
    returncode, output = await _run_media(
        ("mcp__media_admin__media_search", arguments), ctx
    )
    if returncode != 0 or continuation is not None:
        return returncode, output
    try:
        result = json.loads(output.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return 1, b'{"error":{"code":"invalid_search_response"}}'
    page = result.get(source) if isinstance(result, dict) else None
    if page is None and isinstance(result, dict) and result.get("source") == source:
        # Focused callback tests and older MCP-compatible fixtures may already
        # contain the single-provider page instead of the multi-source wrapper.
        page = result
    if not isinstance(page, dict) or "error" in page:
        return 1, json.dumps(
            page if isinstance(page, dict) else {"error": {"code": "provider_failed"}},
            ensure_ascii=False,
        ).encode("utf-8")
    return 0, json.dumps(page, ensure_ascii=False).encode("utf-8")


def _strip_internal_ids(response_text: str, platform: str = "", **_kwargs):
    if platform != "telegram":
        return None
    lines = []
    for line in response_text.splitlines():
        if _BARE_INTERNAL_ID_RE.fullmatch(line.strip().strip("`")):
            continue
        lines.append(line)
    result = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).rstrip()
    return result if result != response_text else None


def _suppress_download_confirmation(
    response_text: str, platform: str = "", **_kwargs
):
    if platform != "telegram":
        return None
    marker = Path(
        os.environ.get(
            "HERMES_MEDIA_SILENCE_MARKER",
            "/opt/data/runtime/media-download-succeeded",
        )
    )
    try:
        created_at = int(marker.read_text(encoding="utf-8").strip())
        marker.unlink(missing_ok=True)
    except (OSError, ValueError):
        return None
    age_seconds = int(time.time()) - created_at
    return "NO_REPLY" if 0 <= age_seconds <= 300 else None


class HomeTelegramAdapter(TelegramAdapter):
    _MAX_STALE_MESSAGE_CLEANUP = 16
    _MAX_TV_TRACKING_CACHE = 128
    _TV_TRACKING_CACHE_TTL_SECONDS = 60
    _media_plugin_context = None
    _MEDIA_DASHBOARD_PHOTO = Path(__file__).with_name("assets") / "media-menu.jpg"
    _MEDIA_DASHBOARD_FALLBACK_PHOTO = (
        Path(__file__).with_name("assets") / "media-fallback.webp"
    )

    @staticmethod
    def _photo_caption(text: str) -> str:
        if len(text) <= 1024:
            return text
        boundary = text.rfind("\n", 0, 1020)
        if boundary < 1:
            boundary = 1020
        return f"{text[:boundary].rstrip()}\n…"

    @staticmethod
    def _editable_photo(photo: str | Path | InputFile) -> str | InputFile:
        if isinstance(photo, Path):
            return InputFile(photo.read_bytes(), filename=photo.name, attach=True)
        return photo

    async def _edit_photo_card(
        self,
        message,
        photo_url: str | Path | InputFile,
        text: str,
        markup: InlineKeyboardMarkup | None,
        *,
        parse_mode: str | None = None,
    ) -> str | Path | InputFile | None:
        caption = text if parse_mode else self._photo_caption(text)
        media_kwargs = {
            "media": self._editable_photo(photo_url),
            "caption": caption,
        }
        if parse_mode:
            media_kwargs["parse_mode"] = parse_mode
        try:
            await message.edit_media(
                InputMediaPhoto(**media_kwargs),
                reply_markup=markup,
            )
            return photo_url
        except BadRequest as exc:
            if "message is not modified" in str(exc).lower():
                return photo_url
            if getattr(message, "photo", None):
                if photo_url != self._MEDIA_DASHBOARD_FALLBACK_PHOTO:
                    try:
                        fallback_kwargs = {
                            "media": self._editable_photo(
                                self._MEDIA_DASHBOARD_FALLBACK_PHOTO
                            ),
                            "caption": caption,
                        }
                        if parse_mode:
                            fallback_kwargs["parse_mode"] = parse_mode
                        await message.edit_media(
                            InputMediaPhoto(**fallback_kwargs),
                            reply_markup=markup,
                        )
                        return self._MEDIA_DASHBOARD_FALLBACK_PHOTO
                    except BadRequest as fallback_exc:
                        if "message is not modified" in str(fallback_exc).lower():
                            return self._MEDIA_DASHBOARD_FALLBACK_PHOTO
                edit_kwargs = {"caption": caption, "reply_markup": markup}
                if parse_mode:
                    edit_kwargs["parse_mode"] = parse_mode
                await message.edit_caption(**edit_kwargs)
                return None
            else:
                edit_kwargs = {"reply_markup": markup}
                if parse_mode:
                    edit_kwargs["parse_mode"] = parse_mode
                await message.edit_text(caption, **edit_kwargs)
                return None

    def _media_panel_transition(self, message) -> int:
        key = self._media_navigation_key(message)
        if key is None:
            return 0
        generations = getattr(self, "_media_panel_generations", None)
        if generations is None:
            generations = {}
            self._media_panel_generations = generations
        generation = generations.get(key, 0) + 1
        self._set_bounded_media_state(generations, key, generation)
        return generation

    @staticmethod
    def _set_bounded_media_state(state: dict, key: str, value) -> None:
        if key not in state and len(state) >= 512:
            state.pop(next(iter(state)))
        state[key] = value

    def _media_panel_transition_is_current(self, message, generation: int) -> bool:
        key = self._media_navigation_key(message)
        generations = getattr(self, "_media_panel_generations", {})
        return key is None or generations.get(key) == generation

    def _media_panel_message_lock(self, message) -> asyncio.Lock:
        key = self._media_navigation_key(message) or "unknown"
        locks = getattr(self, "_media_panel_locks", None)
        if locks is None:
            locks = {}
            self._media_panel_locks = locks
        lock = locks.get(key)
        if lock is not None:
            return lock
        if len(locks) >= 512:
            stale_key = next(
                (candidate for candidate, candidate_lock in locks.items()
                 if not candidate_lock.locked()),
                None,
            )
            if stale_key is not None:
                locks.pop(stale_key, None)
        lock = asyncio.Lock()
        locks[key] = lock
        return lock

    @staticmethod
    def _media_panel_photo_key(photo: str | Path | InputFile) -> str | None:
        if isinstance(photo, Path):
            return str(photo.resolve())
        return photo if isinstance(photo, str) else None

    def _remember_media_panel_photo(self, message, photo: str | Path | InputFile) -> None:
        key = self._media_navigation_key(message)
        photo_key = self._media_panel_photo_key(photo)
        if key is None or photo_key is None:
            return
        photos = getattr(self, "_media_panel_photos", None)
        if photos is None:
            photos = {}
            self._media_panel_photos = photos
        self._set_bounded_media_state(photos, key, photo_key)

    def _media_panel_has_photo(self, message, photo: str | Path | InputFile) -> bool:
        key = self._media_navigation_key(message)
        photo_key = self._media_panel_photo_key(photo)
        return key is not None and photo_key is not None and getattr(
            self, "_media_panel_photos", {}
        ).get(key) == photo_key

    async def _edit_or_reuse_photo_card(
        self,
        message,
        photo: str | Path | InputFile,
        caption: str,
        markup: InlineKeyboardMarkup | None,
        *,
        parse_mode: str | None = None,
    ) -> None:
        if self._media_panel_has_photo(message, photo):
            edit_kwargs = {"caption": caption, "reply_markup": markup}
            if parse_mode:
                edit_kwargs["parse_mode"] = parse_mode
            try:
                await message.edit_caption(**edit_kwargs)
            except BadRequest as exc:
                if "message is not modified" not in str(exc).lower():
                    raise
            return
        rendered_photo = await self._edit_photo_card(
            message,
            photo,
            caption,
            markup,
            parse_mode=parse_mode,
        )
        if rendered_photo is not None:
            self._remember_media_panel_photo(message, rendered_photo)

    async def _reply_photo_card(
        self,
        message,
        photo: str | Path | InputFile | None,
        text: str,
        markup: InlineKeyboardMarkup | None,
        *,
        parse_mode: str | None = None,
        reply_to_message_id: int | None = None,
    ):
        reply_kwargs = {
            "caption": text,
            "reply_markup": markup,
            "reply_to_message_id": reply_to_message_id,
        }
        if parse_mode:
            reply_kwargs["parse_mode"] = parse_mode
        try:
            sent = await message.reply_photo(
                photo=photo or self._MEDIA_DASHBOARD_PHOTO,
                **reply_kwargs,
            )
            self._remember_media_panel_photo(
                sent, photo or self._MEDIA_DASHBOARD_PHOTO
            )
            return sent
        except BadRequest:
            try:
                sent = await message.reply_photo(
                    photo=self._MEDIA_DASHBOARD_FALLBACK_PHOTO,
                    **reply_kwargs,
                )
                self._remember_media_panel_photo(
                    sent, self._MEDIA_DASHBOARD_FALLBACK_PHOTO
                )
                return sent
            except BadRequest:
                text_kwargs = {
                    "reply_markup": markup,
                    "reply_to_message_id": reply_to_message_id,
                }
                if parse_mode:
                    text_kwargs["parse_mode"] = parse_mode
                return await message.reply_text(text, **text_kwargs)

    async def _media_dashboard_photo(self) -> str | Path:
        configured = os.environ.get("HERMES_MEDIA_DASHBOARD_PHOTO", "").strip()
        if configured:
            return configured
        return self._MEDIA_DASHBOARD_PHOTO

    async def _plex_poster_for_rating_key(self, rating_key: str) -> str | None:
        ctx = self._media_plugin_context
        if ctx is None or not rating_key.isdigit():
            return None
        try:
            payload = await asyncio.to_thread(
                _command_payload,
                ctx,
                "mcp__media_admin__plex_item_get",
                {"rating_key": rating_key},
            )
        except (ValueError, RuntimeError, OSError, TimeoutError):
            return None
        container = payload.get("MediaContainer") if isinstance(payload, dict) else None
        metadata = container.get("Metadata") if isinstance(container, dict) else None
        item = metadata[0] if isinstance(metadata, list) and metadata else None
        if not isinstance(item, dict):
            return None
        tmdb_id = None
        for guid in item.get("Guid") or ():
            value = guid.get("id") if isinstance(guid, dict) else None
            if isinstance(value, str) and value.startswith("tmdb://"):
                candidate = value.removeprefix("tmdb://")
                if candidate.isdigit():
                    tmdb_id = int(candidate)
                    break
        if tmdb_id is None:
            return None
        media_type = "movie" if item.get("type") == "movie" else "tv"
        details = await self._details_payload(media_type, tmdb_id)
        poster_url = details.get("poster_url") if isinstance(details, dict) else None
        return (
            poster_url
            if isinstance(poster_url, str)
            and poster_url.startswith(("https://", "http://"))
            else None
        )

    async def _media_panel_card_photo(self, card) -> str | Path:
        photo_url = getattr(card, "photo_url", None)
        if isinstance(photo_url, str) and photo_url.startswith(("https://", "http://")):
            return photo_url
        rating_key = getattr(card, "photo_rating_key", None)
        if isinstance(rating_key, str):
            poster_url = await self._plex_poster_for_rating_key(rating_key)
            if poster_url:
                return poster_url
        return self._MEDIA_DASHBOARD_PHOTO

    async def _edit_media_panel_card(
        self,
        message,
        card,
        *,
        photo_url: str | Path | InputFile | None = None,
        generation: int | None = None,
    ):
        markup = _markup_from_card(card)
        caption = card.text
        parse_mode = card.parse_mode
        if len(caption) > 1024:
            caption = self._photo_caption(
                unescape(re.sub(r"<[^>]+>", "", caption))
            )
            parse_mode = None
        if getattr(message, "photo", None):
            if photo_url:
                await self._edit_or_reuse_photo_card(
                    message,
                    photo_url,
                    caption,
                    markup,
                    parse_mode=parse_mode,
                )
            else:
                try:
                    edit_kwargs = {"caption": caption, "reply_markup": markup}
                    if parse_mode:
                        edit_kwargs["parse_mode"] = parse_mode
                    await message.edit_caption(**edit_kwargs)
                except BadRequest as exc:
                    if "message is not modified" not in str(exc).lower():
                        raise
            return message
        if photo_url:
            replacement = await self._reply_photo_card(
                message,
                photo_url,
                caption,
                markup,
                parse_mode=parse_mode,
                reply_to_message_id=None,
            )
            if replacement is not None:
                if generation is not None and not self._media_panel_transition_is_current(
                    message, generation
                ):
                    await self._delete_stale_messages([replacement])
                    return message
                await message.delete()
                return replacement
        try:
            await message.edit_text(
                card.text,
                reply_markup=markup,
                parse_mode=card.parse_mode,
            )
        except BadRequest as exc:
            if "message is not modified" not in str(exc).lower():
                raise
        return message

    async def _present_search_part(
        self,
        message,
        part: RenderedSearchPart,
        store: MediaActionStore,
        *,
        replace: bool,
    ):
        markup = _action_markup(store, part.actions)
        text = self._photo_caption(part.text) if part.photo_url else part.text
        reply_to = getattr(message, "message_id", None)
        has_photo = bool(getattr(message, "photo", None))

        if replace and part.photo_url:
            await self._edit_photo_card(message, part.photo_url, text, markup)
            return message
        if replace and has_photo:
            if part.photo_url:
                await self._edit_photo_card(message, part.photo_url, text, markup)
            else:
                await message.edit_caption(caption=text, reply_markup=markup)
            return message
        if replace:
            await message.edit_text(text, reply_markup=markup)
            return message
        return await self._reply_photo_card(
            message,
            part.photo_url,
            text,
            markup,
            reply_to_message_id=reply_to,
        )

    @staticmethod
    async def _delete_stale_messages(messages: list) -> None:
        for message in messages[:HomeTelegramAdapter._MAX_STALE_MESSAGE_CLEANUP]:
            try:
                await message.delete()
            except TelegramError as exc:
                logger.warning(
                    "Failed to delete stale Telegram media message: %s",
                    type(exc).__name__,
                )

    @staticmethod
    async def _edit_message_card(
        message,
        text: str,
        markup: InlineKeyboardMarkup | None = None,
        *,
        parse_mode: str | None = None,
    ) -> None:
        kwargs = {"reply_markup": markup}
        if parse_mode:
            kwargs["parse_mode"] = parse_mode
        try:
            if getattr(message, "photo", None):
                await message.edit_caption(caption=text, **kwargs)
            else:
                await message.edit_text(text, **kwargs)
        except BadRequest as exc:
            if "message is not modified" not in str(exc).lower():
                raise

    async def _handle_command(self, update, context) -> None:
        message = self._effective_update_message(update)
        command = (
            message.text.split(maxsplit=1)[0].split("@", maxsplit=1)[0].lower()
            if message is not None and isinstance(getattr(message, "text", None), str)
            else ""
        )
        if command in {"/trending", "/movies", "/series"}:
            if not self._should_process_message(message, is_command=True):
                return
            if not self._is_user_authorized_from_message(message):
                return
            category = {
                "/trending": "all",
                "/movies": "movie",
                "/series": "tv",
            }[command]
            parts = message.text.split(maxsplit=1)
            try:
                page = int(parts[1]) if len(parts) == 2 else 1
            except ValueError:
                page = 0
            await self._send_trending_card(message, category, page)
            return
        if command != "/media":
            await super()._handle_command(update, context)
            return
        if not self._should_process_message(message, is_command=True):
            return
        if not self._is_user_authorized_from_message(message):
            return
        card = render_media_panel_card(self._media_plugin_context, "home")
        await self._reply_photo_card(
            message,
            await self._media_dashboard_photo(),
            card.text,
            _markup_from_card(card),
            parse_mode=card.parse_mode,
            reply_to_message_id=message.message_id,
        )

    async def _handle_callback_query(self, update, context) -> None:
        query = update.callback_query
        data = getattr(query, "data", "") if query is not None else ""
        if data.startswith("hm:"):
            await self._handle_presentation_callback(query)
            return
        if data.startswith("md:"):
            await self._handle_media_action_callback(query)
            return
        if data.startswith("ms:"):
            await self._handle_source_choice_callback(query)
            return
        if data.startswith("mp:"):
            await self._handle_media_panel_callback(query)
            return
        if data.startswith("mt:"):
            await self._handle_trending_callback(query)
            return
        if data.startswith("mi:"):
            await self._handle_similar_callback(query)
            return
        if data == "mn:b":
            await self._handle_media_navigation_callback(query)
            return
        if data.startswith("mx:"):
            try:
                await self._handle_discovery_action_callback(query)
            finally:
                message = getattr(query, "message", None)
                message_id = getattr(message, "message_id", None)
                if re.fullmatch(
                    r"mx:[if]:[mt]:\d{1,12}:\d{1,3}", data
                ) is not None and isinstance(message_id, int):
                    self._get_business_action_receipt_store().release(
                        data, message_id
                    )
            return
        if not data.startswith("ma:"):
            await super()._handle_callback_query(update, context)
            return
        try:
            await self._handle_business_action_callback(query, data)
        finally:
            message = getattr(query, "message", None)
            message_id = getattr(message, "message_id", None)
            if _CALLBACK_RE.fullmatch(data) is not None and isinstance(message_id, int):
                self._get_business_action_receipt_store().release(data, message_id)
        return

    async def _trending_payload(self, category: str, page: int) -> dict | None:
        ctx = self._media_plugin_context
        if ctx is None or page < 1:
            return None
        try:
            return await asyncio.to_thread(
                _command_payload,
                ctx,
                "mcp__media_admin__media_trending",
                {"category": category, "page": page},
            )
        except (ValueError, RuntimeError, OSError, TimeoutError):
            return None

    @staticmethod
    def _trending_markup(
        card: TrendingCard, *, include_back: bool = False
    ) -> InlineKeyboardMarkup:
        def telegram_button(button):
            if button.url:
                return InlineKeyboardButton(button.label, url=button.url)
            return InlineKeyboardButton(
                button.label, callback_data=button.callback_data
            )

        rows = [
            [telegram_button(button) for button in row]
            for row in card.buttons
        ]
        has_back = any(
            getattr(button, "callback_data", None) == "mn:b"
            for row in rows
            for button in row
        )
        if include_back and not has_back:
            rows.append([
                InlineKeyboardButton("⬅️ Назад", callback_data="mn:b")
            ])
        return InlineKeyboardMarkup(rows)

    async def _details_payload(self, media_type: str, tmdb_id: int) -> dict | None:
        ctx = self._media_plugin_context
        if ctx is None or media_type not in {"movie", "tv"} or tmdb_id < 1:
            return None
        try:
            return await asyncio.to_thread(
                _command_payload,
                ctx,
                "mcp__media_admin__media_details",
                {"media_type": media_type, "tmdb_id": tmdb_id},
            )
        except (ValueError, RuntimeError, OSError, TimeoutError):
            return None

    async def _similar_payload(
        self, media_type: str, tmdb_id: int, page: int
    ) -> dict | None:
        ctx = self._media_plugin_context
        if (
            ctx is None
            or media_type not in {"movie", "tv"}
            or tmdb_id < 1
            or page < 1
        ):
            return None
        try:
            return await asyncio.to_thread(
                _command_payload,
                ctx,
                "mcp__media_admin__media_similar",
                {"media_type": media_type, "tmdb_id": tmdb_id, "page": page},
            )
        except (ValueError, RuntimeError, OSError, TimeoutError):
            return None

    async def _send_trending_card(self, message, category: str, page: int) -> None:
        payload = await self._trending_payload(category, page)
        card = render_trending_list(payload) if payload is not None else None
        if card is None:
            await message.reply_text(
                "⚠️ Не удалось получить данные TMDB.",
                reply_to_message_id=message.message_id,
            )
            return
        markup = self._trending_markup(card)
        await self._reply_photo_card(
            message,
            card.photo_url,
            card.text,
            markup,
            parse_mode=card.parse_mode,
            reply_to_message_id=message.message_id,
        )

    async def _handle_trending_callback(
        self, query, *, record_navigation: bool = True
    ) -> None:
        data = getattr(query, "data", "") if query is not None else ""
        match = re.fullmatch(
            r"mt:([ld]):([amt]):(\d{1,5}):(\d{1,2}):(\d{1,12})",
            data,
        )
        message = getattr(query, "message", None)
        chat = getattr(message, "chat", None)
        caller_id = str(getattr(getattr(query, "from_user", None), "id", ""))
        if not self._is_callback_user_authorized(
            caller_id,
            chat_id=getattr(message, "chat_id", None),
            chat_type=str(getattr(chat, "type", "")),
            thread_id=str(getattr(message, "message_thread_id", "") or ""),
            user_name=getattr(getattr(query, "from_user", None), "first_name", None),
        ):
            await query.answer()
            return
        if match is None or message is None:
            await query.answer()
            return
        view, category_code, page_text, index_text, tmdb_id_text = match.groups()
        category = category_from_code(category_code)
        if category is None:
            await query.answer()
            return
        generation = self._media_panel_transition(message)
        await query.answer()
        payload = await self._trending_payload(category, int(page_text))
        card_details = None
        if view == "d" and payload is not None:
            results = payload.get("results")
            index = int(index_text)
            expected_tmdb_id = int(tmdb_id_text)
            if (
                not isinstance(results, list)
                or index >= len(results)
                or not isinstance(results[index], dict)
                or results[index].get("tmdb_id") != expected_tmdb_id
            ):
                categories = [
                    InlineKeyboardButton(
                        f"{'✅ ' if code == category_code else ''}{label}",
                        callback_data=(
                            "mp:noop"
                            if code == category_code
                            else f"mt:l:{code}:1:0:0"
                        ),
                    )
                    for code, label in (
                        ("m", "Фильмы"),
                        ("t", "Сериалы"),
                        ("a", "Все"),
                    )
                ]
                markup = InlineKeyboardMarkup([
                    categories,
                    [InlineKeyboardButton("🔄 Повторить", callback_data=data)],
                    [
                        InlineKeyboardButton(
                            "⬅️ Назад",
                            callback_data=f"mt:l:{category_code}:{page_text}:0:0",
                        )
                    ],
                ])
                async with self._media_panel_message_lock(message):
                    if not self._media_panel_transition_is_current(message, generation):
                        return
                    await self._edit_message_card(
                        message,
                        "⚠️ Карточка устарела. Откройте список заново.",
                        markup,
                    )
                return
            media_type = results[index].get("media_type")
            details = (
                await self._details_payload(media_type, expected_tmdb_id)
                if media_type in {"movie", "tv"}
                else None
            )
            if details is not None:
                results[index] = {**results[index], **details}
                card_details = results[index]
        card = (
            render_trending_list(payload)
            if view == "l" and payload is not None
            else render_trending_details(payload, int(index_text))
            if payload is not None
            else None
        )
        if card is None:
            retry = InlineKeyboardButton("🔄 Повторить", callback_data=data)
            categories = [
                InlineKeyboardButton(
                    f"{'✅ ' if code == category_code else ''}{label}",
                    callback_data=(
                        "mp:noop"
                        if code == category_code
                        else f"mt:l:{code}:1:0:0"
                    ),
                )
                for code, label in (("m", "Фильмы"), ("t", "Сериалы"), ("a", "Все"))
            ]
            markup = InlineKeyboardMarkup([
                categories,
                [retry],
                [InlineKeyboardButton("⬅️ Назад", callback_data="mn:b")],
            ])
            async with self._media_panel_message_lock(message):
                if not self._media_panel_transition_is_current(message, generation):
                    return
                await self._edit_message_card(
                    message,
                    "⚠️ Не удалось обновить данные TMDB.",
                    markup,
                )
            return
        card = await self._decorate_tv_tracking_card(card, card_details)
        async with self._media_panel_message_lock(message):
            if not self._media_panel_transition_is_current(message, generation):
                return
            if record_navigation:
                fallback = (
                    f"mt:l:{category_code}:{page_text}:0:0"
                    if view == "d"
                    else None
                )
                current = self._media_navigation_current(message)
                replace = view == "l" or (
                    view == "d"
                    and isinstance(current, str)
                    and current.startswith("mt:d:")
                )
                self._media_navigation_visit(
                    message, data, fallback=fallback, replace=replace
                )
            markup = self._trending_markup(
                card, include_back=self._media_navigation_has_back(message)
            )
            if getattr(message, "photo", None):
                await self._edit_or_reuse_photo_card(
                    message,
                    card.photo_url or self._MEDIA_DASHBOARD_PHOTO,
                    card.text,
                    markup,
                    parse_mode=card.parse_mode,
                )
            elif card.photo_url:
                await self._edit_photo_card(
                    message,
                    card.photo_url,
                    card.text,
                    markup,
                    parse_mode=card.parse_mode,
                )
            else:
                await message.edit_text(
                    card.text,
                    reply_markup=markup,
                    parse_mode=card.parse_mode,
                )

    async def _edit_trending_card(
        self, message, card: TrendingCard, details: dict | None = None
    ) -> None:
        card = await self._decorate_tv_tracking_card(card, details)
        markup = self._trending_markup(card)
        if getattr(message, "photo", None):
            await self._edit_or_reuse_photo_card(
                message,
                card.photo_url or self._MEDIA_DASHBOARD_PHOTO,
                card.text,
                markup,
                parse_mode=card.parse_mode,
            )
        elif card.photo_url:
            await self._edit_photo_card(
                message,
                card.photo_url,
                card.text,
                markup,
                parse_mode=card.parse_mode,
            )
        else:
            await message.edit_text(
                card.text,
                reply_markup=markup,
                parse_mode=card.parse_mode,
            )

    async def _handle_similar_callback(
        self, query, *, record_navigation: bool = True
    ) -> None:
        data = getattr(query, "data", "") if query is not None else ""
        match = re.fullmatch(
            r"mi:([ld]):([mt]):(\d{1,12}):(\d{1,5}):(\d{1,2}):(\d{1,12})",
            data,
        )
        message = getattr(query, "message", None)
        if not self._authorize_media_callback(query, message):
            await query.answer()
            return
        if match is None or message is None:
            await query.answer()
            return
        view, kind_code, origin_id_text, page_text, index_text, item_id_text = match.groups()
        media_type = kind_from_code(kind_code)
        if media_type is None:
            await query.answer()
            return
        generation = self._media_panel_transition(message)
        await query.answer()
        card_details = None
        payload = await self._similar_payload(
            media_type, int(origin_id_text), int(page_text)
        )
        if view == "d" and payload is not None:
            results = payload.get("results")
            index = int(index_text)
            if (
                not isinstance(results, list)
                or index >= len(results)
                or not isinstance(results[index], dict)
                or results[index].get("tmdb_id") != int(item_id_text)
            ):
                markup = InlineKeyboardMarkup([
                    [InlineKeyboardButton("🔄 Повторить", callback_data=data)],
                    [
                        InlineKeyboardButton(
                            "⬅️ Назад",
                            callback_data=(
                                f"mi:l:{kind_code}:{origin_id_text}:{page_text}:0:0"
                            ),
                        )
                    ],
                ])
                async with self._media_panel_message_lock(message):
                    if not self._media_panel_transition_is_current(message, generation):
                        return
                    await self._edit_message_card(
                        message,
                        "⚠️ Карточка устарела. Откройте похожие заново.",
                        markup,
                    )
                return
            selected_type = results[index].get("media_type")
            details = (
                await self._details_payload(selected_type, int(item_id_text))
                if selected_type in {"movie", "tv"}
                else None
            )
            if details is not None:
                results[index] = {**results[index], **details}
                card_details = results[index]
        card = (
            render_similar_list(payload, media_type, int(origin_id_text))
            if view == "l" and payload is not None
            else render_similar_details(
                payload, media_type, int(origin_id_text), int(index_text)
            )
            if payload is not None
            else None
        )
        if card is None:
            markup = InlineKeyboardMarkup([
                [InlineKeyboardButton("🔄 Повторить", callback_data=data)],
                [
                    InlineKeyboardButton(
                        "⬅️ Назад",
                        callback_data=f"mx:d:{kind_code}:{origin_id_text}:0",
                    )
                ],
            ])
            async with self._media_panel_message_lock(message):
                if not self._media_panel_transition_is_current(message, generation):
                    return
                await self._edit_message_card(
                    message,
                    "⚠️ Не удалось получить похожие релизы.",
                    markup,
                )
            return
        async with self._media_panel_message_lock(message):
            if not self._media_panel_transition_is_current(message, generation):
                return
            if record_navigation:
                current = self._media_navigation_current(message)
                replace = isinstance(current, str) and current.startswith(f"mi:{view}:")
                self._media_navigation_visit(
                    message,
                    data,
                    fallback=f"mx:d:{kind_code}:{origin_id_text}:0",
                    replace=replace,
                )
            await self._edit_trending_card(message, card, card_details)

    def _authorize_media_callback(self, query, message) -> bool:
        chat = getattr(message, "chat", None)
        caller_id = str(getattr(getattr(query, "from_user", None), "id", ""))
        return self._is_callback_user_authorized(
            caller_id,
            chat_id=getattr(message, "chat_id", None),
            chat_type=str(getattr(chat, "type", "")),
            thread_id=str(getattr(message, "message_thread_id", "") or ""),
            user_name=getattr(getattr(query, "from_user", None), "first_name", None),
        )

    def _invalidate_tv_tracking_cache(self) -> None:
        self._tv_tracking_cache_epoch = (
            getattr(self, "_tv_tracking_cache_epoch", 0) + 1
        )
        cache = getattr(self, "_tv_tracking_cache", None)
        if isinstance(cache, OrderedDict):
            cache.clear()
        self._tv_tracking_items = None

    def _tv_tracking_cache_store(self) -> OrderedDict:
        cache = getattr(self, "_tv_tracking_cache", None)
        if not isinstance(cache, OrderedDict):
            cache = OrderedDict()
            self._tv_tracking_cache = cache
        return cache

    async def _tv_tracking_state(self, details: dict) -> dict | None:
        if details.get("media_type") != "tv":
            return None
        tmdb_id = details.get("tmdb_id")
        title = _bounded_text(details.get("title"))
        original = _bounded_text(details.get("original_title"))
        year = details.get("year")
        context = self._media_plugin_context
        if (
            not isinstance(tmdb_id, int)
            or isinstance(tmdb_id, bool)
            or title is None
            or context is None
        ):
            return None
        key = (
            id(context),
            tmdb_id,
            title,
            original,
            year if isinstance(year, int) and not isinstance(year, bool) else None,
        )
        cache = self._tv_tracking_cache_store()
        cached = cache.get(key)
        now = time.monotonic()
        if (
            isinstance(cached, tuple)
            and len(cached) == 2
            and isinstance(cached[0], (int, float))
            and cached[0] > now
            and isinstance(cached[1], dict)
        ):
            cache.move_to_end(key)
            return cached[1]

        lock = getattr(self, "_tv_tracking_cache_lock", None)
        if lock is None:
            lock = asyncio.Lock()
            self._tv_tracking_cache_lock = lock
        async with lock:
            cached = cache.get(key)
            now = time.monotonic()
            if (
                isinstance(cached, tuple)
                and len(cached) == 2
                and isinstance(cached[0], (int, float))
                and cached[0] > now
                and isinstance(cached[1], dict)
            ):
                cache.move_to_end(key)
                return cached[1]
            cache_epoch = getattr(self, "_tv_tracking_cache_epoch", 0)
            try:
                release = await asyncio.to_thread(
                    _command_payload,
                    context,
                    "mcp__media_admin__media_release_schedule",
                    {
                        "title": title,
                        "original_title": original,
                        "year": key[-1],
                    },
                )
            except (TypeError, ValueError, RuntimeError, OSError, TimeoutError):
                return None
            show = release.get("show")
            source_id = show.get("source_id") if isinstance(show, dict) else None
            if (
                release.get("status") != "matched"
                or release.get("source") != "tvmaze"
                or not isinstance(source_id, int)
                or isinstance(source_id, bool)
                or source_id < 1
            ):
                return None

            items_cache = getattr(self, "_tv_tracking_items", None)
            if not (
                isinstance(items_cache, tuple)
                and len(items_cache) == 3
                and items_cache[0] == id(context)
                and isinstance(items_cache[1], (int, float))
                and items_cache[1] > now
                and isinstance(items_cache[2], tuple)
            ):
                code, output = await _tracking_pages(
                    _run_media, context, view="diagnostic"
                )
                if code != 0:
                    return None
                try:
                    payload = json.loads(output.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    return None
                raw_items = payload.get("tracking") if isinstance(payload, dict) else None
                if not isinstance(raw_items, list):
                    return None
                tracking_items = tuple(
                    item for item in raw_items if isinstance(item, dict)
                )
                if cache_epoch == getattr(self, "_tv_tracking_cache_epoch", 0):
                    self._tv_tracking_items = (
                        id(context),
                        now + self._TV_TRACKING_CACHE_TTL_SECONDS,
                        tracking_items,
                    )
            else:
                tracking_items = items_cache[2]

            matches = tuple(
                item
                for item in tracking_items
                if isinstance(item.get("release_identity"), dict)
                and item["release_identity"].get("source") == "tvmaze"
                and isinstance(item["release_identity"].get("source_id"), int)
                and not isinstance(item["release_identity"].get("source_id"), bool)
                and item["release_identity"].get("source_id") == source_id
            )
            baselines = self._release_baselines(release)
            state = {
                "source": "tvmaze",
                "source_id": source_id,
                "matches": matches,
                "season": max(baselines)[0] if baselines else 1,
            }
            if cache_epoch == getattr(self, "_tv_tracking_cache_epoch", 0):
                cache[key] = (now + self._TV_TRACKING_CACHE_TTL_SECONDS, state)
                cache.move_to_end(key)
                while len(cache) > self._MAX_TV_TRACKING_CACHE:
                    cache.popitem(last=False)
            return state

    async def _decorate_tv_tracking_card(
        self, card, details: dict | None = None
    ):
        tmdb_id = None
        for row in getattr(card, "buttons", ()):
            for button in row:
                match = re.fullmatch(
                    r"mx:t:t:(\d{1,12}):0",
                    str(getattr(button, "callback_data", "")),
                )
                if match is not None:
                    tmdb_id = int(match.group(1))
                    break
            if tmdb_id is not None:
                break
        if tmdb_id is None:
            return card
        if not isinstance(details, dict) or details.get("tmdb_id") != tmdb_id:
            details = await self._details_payload("tv", tmdb_id)
        if not isinstance(details, dict):
            return card
        state = await self._tv_tracking_state(details)
        label = (
            "🔄 Обновить"
            if state is None
            else (
                "🔔 Отслеживание"
                if state["matches"]
                else "🔕 Отслеживание"
            )
        )
        buttons = tuple(
            tuple(
                replace(button, label=label)
                if re.fullmatch(
                    r"mx:t:t:\d{1,12}:0",
                    str(getattr(button, "callback_data", "")),
                )
                else button
                for button in row
            )
            for row in card.buttons
        )
        return replace(card, buttons=buttons)

    async def _handle_discovery_action_callback(
        self, query, *, record_navigation: bool = True
    ) -> None:
        data = getattr(query, "data", "") if query is not None else ""
        match = re.fullmatch(r"mx:([dwarptifonxy]):([mt]):(\d{1,12}):(\d{1,3})", data)
        message = getattr(query, "message", None)
        if not self._authorize_media_callback(query, message):
            await query.answer()
            return
        if match is None or message is None:
            await query.answer()
            return
        action, kind_code, tmdb_id_text, season_text = match.groups()
        media_type = kind_from_code(kind_code)
        tmdb_id = int(tmdb_id_text)
        season = int(season_text)
        if media_type is None:
            await query.answer()
            return
        mutation_receipt = None
        if action in {"i", "f"}:
            message_id = getattr(message, "message_id", None)
            if not isinstance(message_id, int):
                await query.answer()
                return
            receipts = self._get_business_action_receipt_store()
            try:
                receipt_state = receipts.claim(data, message_id)
            except ValueError:
                await query.answer()
                return
            if receipt_state != "ready":
                await query.answer()
                return
            mutation_receipt = (receipts, data, message_id)
        return_route = self._media_navigation_current(message) or "mp:home"
        generation = self._media_panel_transition(message)
        if mutation_receipt is not None:
            receipts, callback_data, message_id = mutation_receipt
            if not await _answer_claimed_callback(
                query,
                lambda: receipts.release(callback_data, message_id),
            ):
                return
        elif action in {"a", "r", "p", "x", "y"}:
            await query.answer(text=_SEARCH_LOADING_TOAST)
        else:
            await query.answer()
        try:
            details = await self._details_payload(media_type, tmdb_id)
        except asyncio.CancelledError:
            if mutation_receipt is not None:
                receipts, callback_data, message_id = mutation_receipt
                receipts.release(callback_data, message_id)
            raise
        if details is None:
            if mutation_receipt is not None:
                receipts, callback_data, message_id = mutation_receipt
                receipts.release(callback_data, message_id)
            await self._edit_callback_result(
                message,
                "⚠️ Не удалось обновить карточку. Попробуйте ещё раз.",
                return_route,
                generation,
            )
            return
        stale = False
        async with self._media_panel_message_lock(message):
            if not self._media_panel_transition_is_current(message, generation):
                stale = True
            elif record_navigation:
                current = self._media_navigation_current(message)
                tracking_flow = action in {"t", "o", "n", "i", "f", "x", "y"}
                replace = (
                    action == "d"
                    or current == data
                    or (
                        tracking_flow
                        and isinstance(current, str)
                        and re.fullmatch(
                            rf"mx:[tonifxy]:t:{tmdb_id}:\d{{1,3}}", current
                        ) is not None
                    )
                )
                fallback = (
                    f"mt:l:{'m' if media_type == 'movie' else 't'}:1:0:0"
                    if action == "d"
                    else f"mx:d:{kind_code}:{tmdb_id}:0"
                )
                self._media_navigation_visit(
                    message, data, fallback=fallback, replace=replace
                )
        if stale:
            if mutation_receipt is not None:
                receipts, callback_data, message_id = mutation_receipt
                receipts.release(callback_data, message_id)
            return
        if action == "d":
            card = render_direct_details(details)
            if card is None:
                await self._edit_callback_result(
                    message,
                    "⚠️ Не удалось открыть карточку. Попробуйте ещё раз.",
                    return_route,
                    generation,
                )
                return
            async with self._media_panel_message_lock(message):
                if not self._media_panel_transition_is_current(message, generation):
                    return
                await self._edit_trending_card(message, card, details)
            return
        if action == "w":
            if details.get("media_type") == "tv" and season == 0:
                await self._show_download_setup(message, details, season, generation)
            else:
                await self._show_download_source_choice(
                    message, details, season, generation
                )
            return
        if action in {"a", "r", "p"}:
            await self._search_from_tmdb_card(
                message, details, action, season, generation, return_route
            )
            return
        if action == "t":
            await self._show_tracking_management(message, details, generation)
            return
        if action in {"o", "n"}:
            await self._show_tracking_setup(
                message, details, generation, auto_download=action == "o"
            )
            return
        if action in {"i", "f"}:
            await self._create_tracking_from_tmdb(
                message,
                details,
                "personal" if action == "i" else "family",
                generation,
                return_route,
                mutation_receipt,
            )
            return
        if action in {"x", "y"}:
            await self._search_tracking_download(
                message,
                details,
                "personal" if action == "x" else "family",
                generation,
                return_route,
            )

    async def _edit_callback_result(
        self,
        message,
        text: str,
        back_callback: str,
        generation: int,
    ) -> None:
        markup = InlineKeyboardMarkup([[
            InlineKeyboardButton("⬅️ Назад", callback_data=back_callback)
        ]])
        async with self._media_panel_message_lock(message):
            if not self._media_panel_transition_is_current(message, generation):
                return
            await self._edit_message_card(message, text, markup)

    async def _edit_callback_retry_result(
        self,
        message,
        text: str,
        retry_callback: str,
        back_callback: str,
        generation: int,
    ) -> None:
        markup = InlineKeyboardMarkup([
            [InlineKeyboardButton("🔄 Повторить", callback_data=retry_callback)],
            [InlineKeyboardButton("⬅️ Назад", callback_data=back_callback)],
        ])
        async with self._media_panel_message_lock(message):
            if not self._media_panel_transition_is_current(message, generation):
                return
            await self._edit_message_card(message, text, markup)

    async def _show_download_setup(
        self, message, details: dict, season: int, generation: int
    ) -> None:
        title = _bounded_text(details.get("title")) or "Выбранный релиз"
        media_type = details.get("media_type")
        tmdb_id = details.get("tmdb_id")
        if media_type not in {"movie", "tv"} or not isinstance(tmdb_id, int):
            return
        kind_code = "m" if media_type == "movie" else "t"
        media_icon = "🎬" if media_type == "movie" else "📺"
        lines = ["⬇️ Скачать", "", f"{media_icon} {title}"]
        rows = []
        if media_type == "tv" and season == 0:
            season_count = details.get("season_count")
            if not isinstance(season_count, int) or season_count < 1:
                season_count = 1
            season_count = min(season_count, 30)
            lines.extend(("", "📚 Выберите сезон"))
            season_buttons = [
                InlineKeyboardButton(
                    f"S{value}",
                    callback_data=f"mx:w:{kind_code}:{tmdb_id}:{value}",
                )
                for value in range(1, season_count + 1)
            ]
            rows.extend(
                season_buttons[index : index + 3]
                for index in range(0, len(season_buttons), 3)
            )
        rows.append([InlineKeyboardButton("⬅️ Назад", callback_data="mn:b")])
        markup = InlineKeyboardMarkup(rows)
        async with self._media_panel_message_lock(message):
            if not self._media_panel_transition_is_current(message, generation):
                return
            if getattr(message, "photo", None):
                await message.edit_caption(caption="\n".join(lines), reply_markup=markup)
            else:
                await message.edit_text("\n".join(lines), reply_markup=markup)

    async def _show_download_source_choice(
        self, message, details: dict, season: int, generation: int
    ) -> None:
        title = _bounded_text(details.get("title")) or "Выбранный релиз"
        media_type = details.get("media_type")
        tmdb_id = details.get("tmdb_id")
        if (
            media_type not in {"movie", "tv"}
            or not isinstance(tmdb_id, int)
            or isinstance(tmdb_id, bool)
            or (media_type == "tv" and season < 1)
        ):
            return
        kind_code = "m" if media_type == "movie" else "t"
        icon = "🎬" if media_type == "movie" else "📺"
        lines = ["⬇️ Скачать", "", f"{icon} {title}"]
        if media_type == "tv":
            lines.append(f"📚 Сезон {season}")
        lines.extend(("", "Выберите источник"))
        markup = InlineKeyboardMarkup([
            [
                InlineKeyboardButton(
                    "🌐 Rezka", callback_data=f"mx:r:{kind_code}:{tmdb_id}:{season}"
                ),
                InlineKeyboardButton(
                    "🧲 Prowlarr", callback_data=f"mx:p:{kind_code}:{tmdb_id}:{season}"
                ),
            ],
            [InlineKeyboardButton("⬅️ Назад", callback_data="mn:b")],
        ])
        async with self._media_panel_message_lock(message):
            if not self._media_panel_transition_is_current(message, generation):
                return
            await self._edit_message_card(message, "\n".join(lines), markup)

    async def _search_from_tmdb_card(
        self,
        message,
        details: dict,
        action: str,
        season: int,
        generation: int,
        return_route: str,
    ) -> None:
        media_type = details.get("media_type")
        title = _bounded_text(details.get("title"))
        tmdb_id = details.get("tmdb_id")
        if (
            media_type not in {"movie", "tv"}
            or title is None
            or not isinstance(tmdb_id, int)
            or (media_type == "tv" and season < 1)
        ):
            await self._edit_callback_result(
                message,
                "⚠️ Сначала выберите сезон.",
                return_route,
                generation,
            )
            return
        sources = ("rezka", "prowlarr") if action == "a" else (
            "rezka" if action == "r" else "prowlarr",
        )
        back_action = SearchAction(
            label="⬅️ Назад",
            kind="navigation-back",
            payload={},
            expires_at="2099-12-31T23:59:59Z",
        )
        searches = await asyncio.gather(*(
            _search_media_mcp(
                self._media_plugin_context,
                source,
                query=title,
                media_kind="movie" if media_type == "movie" else "series",
                season=season if media_type == "tv" else None,
                tmdb_id=tmdb_id if media_type == "tv" else None,
            )
            for source in sources
        ))
        rendered_searches = []
        failed_sources = []
        for source, (returncode, output) in zip(sources, searches, strict=True):
            rendered = (
                _render_source_search(
                    output,
                    source,
                    season if media_type == "tv" else 0,
                    0,
                    back_action,
                    carousel=action != "a",
                    direct_back=action in {"r", "p"},
                )
                if returncode == 0
                else None
            )
            if rendered is not None:
                rendered_searches.append(rendered)
            else:
                failed_sources.append("Rezka" if source == "rezka" else "Prowlarr")
        if not any(
            self._rendered_has_search_results(rendered)
            for rendered in rendered_searches
        ):
            unavailable = not rendered_searches
            source_badge = {
                "a": "🌐 Rezka · 🧲 Prowlarr",
                "r": "🌐 Rezka",
                "p": "🧲 Prowlarr",
            }[action]
            unavailable_title = {
                "a": "⚠️ Источники временно недоступны",
                "r": "⚠️ Rezka временно недоступен",
                "p": "⚠️ Prowlarr временно недоступен",
            }[action]
            lines = [
                unavailable_title if unavailable else "⚠️ Вариантов нет",
                "",
                f"{'🎬' if media_type == 'movie' else '📺'} {title}",
            ]
            if media_type == "tv":
                lines.append(f"📚 Сезон {season}")
            if not unavailable:
                lines.append(source_badge)
            if failed_sources and not unavailable:
                lines.append(f"⚠️ Недоступно: {', '.join(failed_sources)}")
            kind_code = "m" if media_type == "movie" else "t"
            rows = []
            if unavailable:
                retry = InlineKeyboardButton(
                    "🔄 Повторить",
                    callback_data=f"mx:{action}:{kind_code}:{tmdb_id}:{season}",
                )
                retry_row = [retry]
                if action in {"r", "p"}:
                    alternate = "p" if action == "r" else "r"
                    alternate_label = (
                        "🧲 Prowlarr" if alternate == "p" else "🌐 Rezka"
                    )
                    retry_row.append(InlineKeyboardButton(
                        alternate_label,
                        callback_data=f"mx:{alternate}:{kind_code}:{tmdb_id}:{season}",
                    ))
                rows.append(retry_row)
            elif action in {"r", "p"}:
                alternate = "p" if action == "r" else "r"
                alternate_label = "🧲 Prowlarr" if alternate == "p" else "🌐 Rezka"
                rows.append([InlineKeyboardButton(
                    alternate_label,
                    callback_data=f"mx:{alternate}:{kind_code}:{tmdb_id}:{season}",
                )])
            rows.append([InlineKeyboardButton("⬅️ Назад", callback_data="mn:b")])
            markup = InlineKeyboardMarkup(rows)
            async with self._media_panel_message_lock(message):
                if not self._media_panel_transition_is_current(message, generation):
                    return
                if getattr(message, "photo", None):
                    await message.edit_caption(caption="\n".join(lines), reply_markup=markup)
                else:
                    await message.edit_text("\n".join(lines), reply_markup=markup)
            return
        combined = _combine_source_results(rendered_searches, failed_sources)
        if combined is None or not self._rendered_has_search_results(combined):
            await self._edit_callback_result(
                message,
                "⚠️ Источники временно недоступны. Попробуйте позже.",
                return_route,
                generation,
            )
            return
        store = self._get_media_action_store()
        await self._present_search_once(message, combined, store, generation)

    async def _show_tracking_setup(
        self,
        message,
        details: dict,
        generation: int,
        *,
        auto_download: bool = False,
    ) -> None:
        title = _bounded_text(details.get("title")) or "Выбранный сериал"
        tmdb_id = details.get("tmdb_id")
        if not isinstance(tmdb_id, int):
            return
        text = "\n".join((
            "🔔 Подписаться",
            "",
            f"📺 {title}",
            "",
            "Новые серии будут проверяться каждый час.",
            (
                "✅ Автоскачивание: после выбора релиза и озвучки"
                if auto_download
                else "⬜ Автоскачивание выключено"
            ),
            "Кому отправлять уведомления?",
        ))
        scope_actions = ("x", "y") if auto_download else ("i", "f")
        markup = InlineKeyboardMarkup([
            [InlineKeyboardButton(
                "✅ Автоскачивание" if auto_download else "⬜ Автоскачивание",
                callback_data=f"mx:{'n' if auto_download else 'o'}:t:{tmdb_id}:0",
            )],
            [
                InlineKeyboardButton(
                    "Личное", callback_data=f"mx:{scope_actions[0]}:t:{tmdb_id}:0"
                ),
                InlineKeyboardButton(
                    "Семейное", callback_data=f"mx:{scope_actions[1]}:t:{tmdb_id}:0"
                ),
            ],
            [InlineKeyboardButton("⬅️ Назад", callback_data="mn:b")],
        ])
        async with self._media_panel_message_lock(message):
            if not self._media_panel_transition_is_current(message, generation):
                return
            if getattr(message, "photo", None):
                await message.edit_caption(caption=text, reply_markup=markup)
            else:
                await message.edit_text(text, reply_markup=markup)

    @staticmethod
    def _tracking_match(item: object) -> dict | None:
        if not isinstance(item, dict):
            return None
        tracking_id = item.get("id")
        scope = item.get("scope")
        if (
            not isinstance(tracking_id, str)
            or not tracking_id
            or len(tracking_id) > 128
            or not all(character.isprintable() for character in tracking_id)
            or scope not in {"personal", "family"}
        ):
            return None
        return item

    @staticmethod
    def _tracking_action(
        label: str, kind: str, *, tmdb_id: int, tracking_id: str
    ) -> SearchAction:
        expires_at = (
            datetime.now(timezone.utc) + timedelta(hours=1)
        ).isoformat().replace("+00:00", "Z")
        return SearchAction(
            label,
            kind,
            {"tmdb_id": tmdb_id, "tracking_id": tracking_id},
            expires_at,
        )

    async def _show_tracking_management(
        self,
        message,
        details: dict,
        generation: int,
        *,
        selected_tracking_id: str | None = None,
        state: dict | None = None,
    ) -> bool:
        tmdb_id = details.get("tmdb_id")
        title = _bounded_text(details.get("title")) or "Выбранный сериал"
        if not isinstance(tmdb_id, int) or isinstance(tmdb_id, bool):
            return False
        if state is None:
            state = await self._tv_tracking_state(details)
        if state is None:
            await self._edit_callback_result(
                message,
                "⚠️ Не удалось проверить отслеживание.",
                "mn:b",
                generation,
            )
            return False
        raw_matches = state.get("matches", ())
        matches = tuple(
            match
            for item in raw_matches
            if (match := self._tracking_match(item)) is not None
        )
        if raw_matches and not matches:
            await self._edit_callback_result(
                message,
                "⚠️ Не удалось безопасно открыть отслеживание.",
                "mn:b",
                generation,
            )
            return False
        if not matches:
            await self._show_tracking_setup(message, details, generation)
            return False

        selected = None
        if selected_tracking_id is not None:
            selected = next(
                (item for item in matches if item["id"] == selected_tracking_id),
                None,
            )
            if selected is None:
                await self._edit_callback_result(
                    message,
                    "⚠️ Отслеживание изменилось. Откройте его заново.",
                    "mn:b",
                    generation,
                )
                return False
        elif len(matches) == 1:
            selected = matches[0]

        store = self._get_media_action_store()
        if selected is None:
            actions = tuple(
                self._tracking_action(
                    (
                        "👤 Личное"
                        if item["scope"] == "personal"
                        else "👥 Семейное"
                    )
                    + f" · {index}"
                    + (" · авто" if isinstance(item.get("download"), dict) else ""),
                    "tracking-manage",
                    tmdb_id=tmdb_id,
                    tracking_id=item["id"],
                )
                for index, item in enumerate(matches, start=1)
            )
            markup = _action_markup(store, actions)
            rows = list(markup.inline_keyboard) if markup is not None else []
            rows.append([InlineKeyboardButton("⬅️ Назад", callback_data="mn:b")])
            text = "\n".join((
                "🔔 Отслеживание",
                "",
                f"📺 {title}",
                "",
                "Выберите подписку.",
            ))
        else:
            scope = "Личное" if selected["scope"] == "personal" else "Семейное"
            auto_download = isinstance(selected.get("download"), dict)
            actions = (
                self._tracking_action(
                    "⚙️ Автоскачивание",
                    "tracking-configure",
                    tmdb_id=tmdb_id,
                    tracking_id=selected["id"],
                ),
                self._tracking_action(
                    "🗑 Отключить",
                    "tracking-remove-prepare",
                    tmdb_id=tmdb_id,
                    tracking_id=selected["id"],
                ),
            )
            markup = _action_markup(store, actions)
            rows = list(markup.inline_keyboard) if markup is not None else []
            rows.append([InlineKeyboardButton("⬅️ Назад", callback_data="mn:b")])
            text = "\n".join((
                "🔔 Отслеживание",
                "",
                f"📺 {title}",
                f"👤 {scope}",
                f"⬇️ Автоскачивание: {'включено' if auto_download else 'выключено'}",
            ))

        async with self._media_panel_message_lock(message):
            if not self._media_panel_transition_is_current(message, generation):
                return False
            await self._edit_message_card(message, text, InlineKeyboardMarkup(rows))
        return True

    async def _create_tracking_from_tmdb(
        self,
        message,
        details: dict,
        scope: str,
        generation: int,
        return_route: str,
        mutation_receipt,
    ) -> None:
        receipts, callback_data, message_id = mutation_receipt
        async with receipts.execution(callback_data, message_id) as owns_claim:
            if not owns_claim:
                return
            try:
                prepared = await self._prepare_tracking_create(details, scope)
            except asyncio.CancelledError:
                receipts.release(callback_data, message_id)
                raise
            if prepared is None:
                receipts.release(callback_data, message_id)
                await self._edit_callback_retry_result(
                    message,
                    "⚠️ Не удалось безопасно определить текущую серию.",
                    callback_data,
                    return_route,
                    generation,
                )
                return
            create_arguments, _season, _episode = prepared
            receipts.consume(callback_data, message_id)
            returncode, _output = await _run_media(
                ("mcp__media_admin__media_tracking_create", create_arguments),
                self._media_plugin_context,
            )
        if returncode != 0:
            await self._edit_callback_result(
                message,
                "⚠️ Не удалось добавить отслеживание.",
                return_route,
                generation,
            )
            return
        self._invalidate_tv_tracking_cache()
        await self._show_tracking_management(message, details, generation)

    async def _prepare_tracking_create(
        self, details: dict, scope: str
    ) -> tuple[dict[str, object], int, int] | None:
        title = _bounded_text(details.get("title"))
        original = _bounded_text(details.get("original_title"))
        year = details.get("year")
        ctx = self._media_plugin_context
        if title is None or ctx is None:
            return None
        try:
            release = await asyncio.to_thread(
                _command_payload,
                ctx,
                "mcp__media_admin__media_release_schedule",
                {
                    "title": title,
                    "original_title": original,
                    "year": year if isinstance(year, int) else None,
                },
            )
        except (ValueError, RuntimeError, OSError, TimeoutError):
            return None
        baselines = self._release_baselines(release)
        show = release.get("show")
        source_id = show.get("source_id") if isinstance(show, dict) else None
        if (
            not baselines
            or release.get("source") != "tvmaze"
            or not isinstance(source_id, int)
            or isinstance(source_id, bool)
            or source_id < 1
        ):
            return None
        season, episode = max(baselines)
        create_arguments = {
            "provider": "rezka",
            "title": title,
            "translation": "release-calendar",
            "known_episodes": [
                {"season": known_season, "episode": known_episode}
                for known_season, known_episode in baselines
            ],
            "scope": scope,
            "series_ongoing": True,
            "release_identity": {
                "source": "tvmaze",
                "source_id": source_id,
            },
        }
        poster_url = show.get("poster_url")
        if (
            isinstance(poster_url, str)
            and len(poster_url) <= 2048
            and poster_url.startswith("https://")
        ):
            create_arguments["poster_url"] = poster_url
        return create_arguments, season, episode

    async def _search_tracking_download(
        self,
        message,
        details: dict,
        scope: str,
        generation: int,
        return_route: str,
    ) -> None:
        prepared = await self._prepare_tracking_create(details, scope)
        if prepared is None:
            await self._edit_callback_result(
                message,
                "⚠️ Не удалось безопасно определить текущую серию.",
                return_route,
                generation,
            )
            return
        create_arguments, season, _episode = prepared
        title = str(create_arguments["title"])
        returncode, output = await _search_media_mcp(
            self._media_plugin_context,
            "rezka",
            query=title,
            media_kind="series",
            season=season,
            tmdb_id=details.get("tmdb_id"),
        )
        back_action = SearchAction(
            "⬅️ Назад", "navigation-back", {}, "2099-12-31T23:59:59Z"
        )
        rendered = (
            _render_source_search(
                output,
                "rezka",
                season,
                0,
                back_action,
                carousel=False,
                tracking_context={
                    "create_arguments": create_arguments,
                    "tmdb_id": details.get("tmdb_id"),
                },
            )
            if returncode == 0
            else None
        )
        if rendered is None or not self._rendered_has_search_results(rendered):
            await self._edit_callback_result(
                message,
                "⚠️ На Rezka пока нет подходящего релиза.",
                return_route,
                generation,
            )
            return
        await self._present_search_once(
            message, rendered, self._get_media_action_store(), generation
        )

    @staticmethod
    def _release_baselines(payload: dict) -> tuple[tuple[int, int], ...]:
        if payload.get("status") != "matched" or not isinstance(payload.get("schedule"), list):
            return ()
        now = datetime.now(timezone.utc)
        aired_by_season = {}
        for item in payload["schedule"]:
            if not isinstance(item, dict):
                continue
            season = item.get("season")
            episode = item.get("episode")
            air_at = item.get("air_at")
            if (
                not isinstance(season, int)
                or not isinstance(episode, int)
                or season < 0
                or episode < 1
                or not isinstance(air_at, str)
            ):
                continue
            try:
                timestamp = datetime.fromisoformat(air_at.replace("Z", "+00:00"))
            except ValueError:
                continue
            if timestamp.tzinfo is None:
                timestamp = timestamp.replace(tzinfo=timezone.utc)
            if timestamp <= now:
                aired_by_season[season] = max(
                    episode, aired_by_season.get(season, 0)
                )
        return tuple(sorted(aired_by_season.items()))

    async def _handle_business_action_callback(self, query, data: str) -> None:
        match = _CALLBACK_RE.fullmatch(data)
        query_message = getattr(query, "message", None)
        query_chat = getattr(query_message, "chat", None)
        caller_id = str(getattr(getattr(query, "from_user", None), "id", ""))
        if not self._is_callback_user_authorized(
            caller_id,
            chat_id=getattr(query_message, "chat_id", None),
            chat_type=str(getattr(query_chat, "type", "")),
            thread_id=str(getattr(query_message, "message_thread_id", "") or ""),
            user_name=getattr(getattr(query, "from_user", None), "first_name", None),
        ):
            await query.answer()
            return
        if match is None or query_message is None:
            await query.answer()
            return

        action, job_id, receipt_generation = match.groups()
        operation = _media_mcp_operation(action, job_id)
        if operation is None:
            await query.answer()
            return
        message_id = getattr(query_message, "message_id", None)
        if not isinstance(message_id, int):
            await query.answer()
            return
        message_job_back = self._message_job_back_action(query_message)
        job_page = self._message_job_page(query_message, job_id)
        job_filter = self._message_job_filter(query_message, job_id)
        is_media_panel = (
            self._is_media_panel_message(query_message)
            or message_job_back is not None
        )
        receipts = self._get_business_action_receipt_store()
        receipt_state = receipts.claim(data, message_id)
        if receipt_state == "consumed":
            await query.answer()
            return
        if receipt_state == "claimed":
            await query.answer()
            return
        if receipt_state == "busy":
            await query.answer()
            return
        acknowledgement = {
            "cancel": "Отменяю загрузку…",
            "retry": "Повторяю загрузку…",
            "retry-missing": "Повторяю недостающие серии…",
            "resume-storage": "Возобновляю загрузку…",
            "details": "Показываю подробности…",
            "search-alternative": "Ищу другой источник…",
        }[action]
        generation = self._media_panel_transition(query_message)
        answer_kwargs = {"text": acknowledgement} if action == "cancel" else {}
        if not await _answer_claimed_callback(
            query,
            lambda: receipts.release(data, message_id),
            **answer_kwargs,
        ):
            return
        back_callback = (
            f"mp:job:{job_id}" if is_media_panel else f"hm:b:{job_id}"
        )
        if message_job_back is not None:
            back_action = (
                message_job_back
                if message_job_back.kind == "job-open"
                else SearchAction(
                    "⬅️ Назад",
                    "job-open",
                    {
                        "job_id": job_id,
                        "source_back": _source_back_payload(message_job_back),
                    },
                    message_job_back.expires_at,
                )
            )
            back_callback = f"md:{self._get_media_action_store().create(back_action)}"
        job_route = (
            f"job:{job_id}:{job_page}:{job_filter}"
            if job_filter in {"m", "t"}
            else f"job:{job_id}:{job_page}"
        )

        tool, arguments = operation
        cancelling_card = None
        retry_safe_action = action in {"details", "search-alternative"}
        async with receipts.execution(data, message_id) as owns_claim:
            if not owns_claim:
                return
            if not retry_safe_action:
                try:
                    if self._media_plugin_context is None:
                        raise RuntimeError("media context is unavailable")
                    current_job = await asyncio.to_thread(
                        _command_payload,
                        self._media_plugin_context,
                        "mcp__media_admin__media_job_get",
                        {"job_id": job_id},
                    )
                    current_generation = _business_action_generation(current_job)
                    if current_generation is None:
                        raise ValueError("media job lifecycle is unavailable")
                    current_lifecycle_cycle = current_job["lifecycle_cycle"]
                except (ValueError, RuntimeError, OSError, TimeoutError):
                    receipts.release(data, message_id)
                    await self._edit_callback_retry_result(
                        query_message,
                        "⚠️ Не удалось проверить актуальное состояние загрузки.",
                        data,
                        back_callback,
                        generation,
                    )
                    return
                if (
                    receipt_generation is None
                    or current_generation != receipt_generation
                ):
                    receipts.consume(data, message_id)
                    card = await asyncio.to_thread(
                        _render_job_payload,
                        None,
                        current_job,
                        job_id,
                        job_page,
                        job_filter,
                    )
                    card = self._job_card_with_source_back(card, message_job_back)
                    async with self._media_panel_message_lock(query_message):
                        if self._media_panel_transition_is_current(
                            query_message, generation
                        ):
                            await self._edit_media_panel_card(
                                query_message, card, generation=generation
                            )
                    return
                operation = _media_mcp_operation(
                    action,
                    job_id,
                    expected_lifecycle_cycle=current_lifecycle_cycle,
                )
                if operation is None:
                    receipts.release(data, message_id)
                    return
                tool, arguments = operation
            if not retry_safe_action:
                receipts.consume(data, message_id)
            operation_task = (
                asyncio.create_task(
                    _run_media((tool, arguments), self._media_plugin_context)
                )
                if action == "cancel"
                else None
            )
            try:
                if action == "cancel" and self._media_plugin_context is not None:
                    try:
                        cancelling_card = await asyncio.to_thread(
                            render_job_cancelling_card,
                            self._media_plugin_context,
                            job_id,
                            job_page,
                            job_filter,
                        )
                        cancelling_card = self._job_card_with_source_back(
                            cancelling_card, message_job_back
                        )
                        async with self._media_panel_message_lock(query_message):
                            if self._media_panel_transition_is_current(
                                query_message, generation
                            ):
                                await self._edit_media_panel_card(
                                    query_message,
                                    cancelling_card,
                                    generation=generation,
                                )
                    except (
                        TelegramError,
                        TypeError,
                        ValueError,
                        RuntimeError,
                        OSError,
                        TimeoutError,
                    ):
                        logger.exception(
                            "Failed to render optimistic media job cancellation %s",
                            job_id,
                        )
                returncode, stdout = (
                    await operation_task
                    if operation_task is not None
                    else await _run_media(
                        (tool, arguments), self._media_plugin_context
                    )
                )
            except asyncio.CancelledError:
                if operation_task is not None and not operation_task.done():
                    operation_task.cancel()
                if operation_task is not None:
                    with suppress(asyncio.CancelledError):
                        await operation_task
                if retry_safe_action:
                    receipts.release(data, message_id)
                raise
            if retry_safe_action:
                receipts.release(data, message_id)
            elif returncode == 127 and self._media_plugin_context is None:
                receipts.restore_consumed(data, message_id)
        if returncode != 0 and action == "cancel":
            error_code = _media_error_code(stdout)
            message = (
                "Загрузка больше не может быть отменена."
                if error_code in {"cancelled", "completed", "conflict", "terminal"}
                else "Не удалось отменить загрузку. Попробуйте ещё раз."
            )
            try:
                card = await asyncio.to_thread(
                    render_job_cancel_error_card,
                    self._media_plugin_context,
                    job_id,
                    job_page,
                    message,
                    job_filter,
                )
                card = self._job_card_with_source_back(card, message_job_back)
            except (TypeError, ValueError, RuntimeError, OSError, TimeoutError):
                logger.exception("Failed to refresh cancel error card %s", job_id)
                card = (
                    render_job_cancel_error_from_card(cancelling_card, message)
                    if cancelling_card is not None
                    else render_media_panel_card(None, job_route)
                )
            async with self._media_panel_message_lock(query_message):
                if self._media_panel_transition_is_current(query_message, generation):
                    await self._edit_media_panel_card(
                        query_message, card, generation=generation
                    )
            return
        if returncode in {124, 127}:
            await self._edit_callback_result(
                query_message,
                "⚠️ Сервис временно недоступен. Попробуйте позже.",
                back_callback,
                generation,
            )
            return
        if returncode != 0:
            error_code = _media_error_code(stdout)
            message = (
                "Поиск другого источника временно недоступен."
                if action == "search-alternative"
                else (
                    "Действие устарело: загрузка больше не может быть отменена."
                    if action == "cancel"
                    and error_code in {"cancelled", "completed", "conflict", "terminal"}
                    else "Не удалось выполнить действие."
                )
            )
            await self._edit_callback_result(
                query_message,
                f"⚠️ {message}",
                back_callback,
                generation,
            )
            return
        if action == "details":
            await self._edit_callback_result(
                query_message,
                _sanitize_details(stdout),
                back_callback,
                generation,
            )
            return
        if action == "search-alternative":
            rendered = _render_alternative_search(stdout)
            if rendered is None:
                await self._edit_callback_result(
                    query_message,
                    "⚠️ Поиск другого источника временно недоступен.",
                    back_callback,
                    generation,
                )
                return
            await self._edit_callback_result(
                query_message,
                rendered,
                back_callback,
                generation,
            )
            return
        if is_media_panel or action == "cancel":
            plugin_context = self._media_plugin_context
            try:
                card = await asyncio.to_thread(
                    render_media_panel_card,
                    plugin_context,
                    job_route,
                )
                card = self._job_card_with_source_back(card, message_job_back)
            except (
                AttributeError,
                TypeError,
                ValueError,
                RuntimeError,
                OSError,
                TimeoutError,
            ):
                logger.exception("Failed to refresh media job card %s", job_id)
                card = render_media_panel_card(None, job_route)
            async with self._media_panel_message_lock(query_message):
                if self._media_panel_transition_is_current(
                    query_message, generation
                ):
                    await self._edit_media_panel_card(
                        query_message, card, generation=generation
                    )

    @staticmethod
    def _is_media_panel_message(message) -> bool:
        markup = getattr(message, "reply_markup", None)
        rows = getattr(markup, "inline_keyboard", ())
        return any(
            isinstance(getattr(button, "callback_data", None), str)
            and button.callback_data.startswith("mp:")
            for row in rows
            for button in row
        )

    def _message_job_back_action(self, message) -> SearchAction | None:
        markup = getattr(message, "reply_markup", None)
        for row in getattr(markup, "inline_keyboard", ()):
            for button in row:
                callback = getattr(button, "callback_data", None)
                if not isinstance(callback, str) or not callback.startswith("md:"):
                    continue
                resolved = self._get_media_action_store().resolve(callback[3:])
                if resolved is None:
                    continue
                action, consumed = resolved
                if not consumed and action.kind in {"release-page", "job-open"}:
                    return action
        return None

    @staticmethod
    def _message_job_page(message, job_id: str) -> int:
        markup = getattr(message, "reply_markup", None)
        prefix = f"mp:job:{job_id}:"
        for row in getattr(markup, "inline_keyboard", ()):
            for button in row:
                callback = getattr(button, "callback_data", None)
                if not isinstance(callback, str) or not callback.startswith(prefix):
                    continue
                page = callback[len(prefix) :].split(":", 1)[0]
                if page.isdigit() and int(page) > 0:
                    return int(page)
        return 1

    @staticmethod
    def _message_job_filter(message, job_id: str) -> str:
        markup = getattr(message, "reply_markup", None)
        prefix = f"mp:job:{job_id}:"
        for row in getattr(markup, "inline_keyboard", ()):
            for button in row:
                callback = getattr(button, "callback_data", None)
                if not isinstance(callback, str) or not callback.startswith(prefix):
                    continue
                parts = callback[len(prefix) :].split(":", 1)
                if len(parts) == 2 and parts[1] in {"m", "t"}:
                    return parts[1]
        return "a"

    async def _handle_media_panel_callback(self, query) -> None:
        data = getattr(query, "data", "") if query is not None else ""
        match = _MEDIA_PANEL_CALLBACK_RE.fullmatch(data)
        query_message = getattr(query, "message", None)
        query_chat = getattr(query_message, "chat", None)
        caller_id = str(getattr(getattr(query, "from_user", None), "id", ""))
        if not self._is_callback_user_authorized(
            caller_id,
            chat_id=getattr(query_message, "chat_id", None),
            chat_type=str(getattr(query_chat, "type", "")),
            thread_id=str(getattr(query_message, "message_thread_id", "") or ""),
            user_name=getattr(getattr(query, "from_user", None), "first_name", None),
        ):
            await query.answer()
            return
        if match is None or query_message is None:
            await query.answer()
            return

        route = match.group(1)
        source_job_back = self._message_job_back_action(query_message)
        if route == "noop":
            await query.answer()
            return
        if route.startswith(("tracking-check:", "tc:")):
            await self._handle_tracking_check_callback(
                query, query_message, data, route
            )
            return
        if route == "trending":
            generation = self._media_panel_transition(query_message)
            await query.answer()
            payload = await self._trending_payload("all", 1)
            card = render_trending_list(payload) if payload is not None else None
            async with self._media_panel_message_lock(query_message):
                if not self._media_panel_transition_is_current(
                    query_message, generation
                ):
                    return
                if card is None:
                    error_markup = InlineKeyboardMarkup([
                        [
                            InlineKeyboardButton(
                                "🔄 Повторить", callback_data="mp:trending"
                            )
                        ],
                        [InlineKeyboardButton("⬅️ Назад", callback_data="mp:home")],
                    ])
                    if getattr(query_message, "photo", None):
                        await query_message.edit_caption(
                            caption="⚠️ Тренды временно недоступны.",
                            reply_markup=error_markup,
                        )
                    else:
                        await query_message.edit_text(
                            "⚠️ Тренды временно недоступны.",
                            reply_markup=error_markup,
                        )
                    return
                markup = self._trending_markup(card, include_back=True)
                if card.photo_url:
                    if getattr(query_message, "photo", None):
                        await self._edit_or_reuse_photo_card(
                            query_message,
                            card.photo_url,
                            card.text,
                            markup,
                            parse_mode=card.parse_mode,
                        )
                        target_message = query_message
                    else:
                        target_message = await self._reply_photo_card(
                            query_message,
                            card.photo_url,
                            card.text,
                            markup,
                            parse_mode=card.parse_mode,
                            reply_to_message_id=None,
                        )
                        if not self._media_panel_transition_is_current(
                            query_message, generation
                        ):
                            await self._delete_stale_messages([target_message])
                            return
                        await query_message.delete()
                    self._media_navigation_visit(target_message, "mp:home")
                    self._media_navigation_visit(target_message, "mt:l:a:1:0:0")
                else:
                    if getattr(query_message, "photo", None):
                        await self._edit_or_reuse_photo_card(
                            query_message,
                            self._MEDIA_DASHBOARD_PHOTO,
                            card.text,
                            markup,
                            parse_mode=card.parse_mode,
                        )
                    else:
                        await query_message.edit_text(
                            card.text,
                            reply_markup=markup,
                            parse_mode=card.parse_mode,
                        )
                    self._media_navigation_visit(query_message, "mp:home")
                    self._media_navigation_visit(query_message, "mt:l:a:1:0:0")
            return
        if route == "home" and getattr(query_message, "photo", None):
            generation = self._media_panel_transition(query_message)
            card = render_media_panel_card(self._media_plugin_context, "home")
            await query.answer()
            photo_url = await self._media_dashboard_photo()
            async with self._media_panel_message_lock(query_message):
                if not self._media_panel_transition_is_current(
                    query_message, generation
                ):
                    return
                await self._edit_media_panel_card(
                    query_message,
                    card,
                    photo_url=photo_url,
                    generation=generation,
                )
                if not self._media_panel_transition_is_current(
                    query_message, generation
                ):
                    return
                self._media_navigation_reset(query_message, "mp:home")
            return
        generation = self._media_panel_transition(query_message)
        if route.startswith("tracking:"):
            await query.answer()
        else:
            await query.answer()
        plugin_context = self._media_plugin_context
        try:
            card = await asyncio.to_thread(
                render_media_panel_card,
                plugin_context,
                route,
            )
        except (
            AttributeError,
            TypeError,
            ValueError,
            RuntimeError,
            OSError,
            TimeoutError,
        ):
            logger.exception("Failed to render media panel callback %s", route)
            card = render_media_panel_card(None, route)
        card = await self._decorate_tv_tracking_card(card)
        if source_job_back is not None and route.startswith("job"):
            if route.startswith(("job-cancel:", "job-retry:")):
                job_id = route.split(":", 2)[1]
                source_action = (
                    _source_back_action(source_job_back.payload.get("source_back"))
                    if source_job_back.kind == "job-open"
                    else source_job_back
                )
                if source_action is not None:
                    back_action = SearchAction(
                        "⬅️ Назад",
                        "job-open",
                        {
                            "job_id": job_id,
                            "source_back": _source_back_payload(source_action),
                        },
                        source_action.expires_at,
                    )
                    back_token = self._get_media_action_store().create(back_action)
                    card = self._job_card_with_back(
                        card, f"md:{back_token}", "⬅️ Назад"
                    )
            else:
                source_action = (
                    _source_back_action(source_job_back.payload.get("source_back"))
                    if source_job_back.kind == "job-open"
                    else source_job_back
                )
                if source_action is not None:
                    back_token = self._get_media_action_store().create(source_action)
                    card = self._job_card_with_back(
                        card, f"md:{back_token}", "⬅️ Назад к релизу"
                    )
        preserve_existing_photo = (
            bool(getattr(query_message, "photo", None))
            and route.startswith(("job-cancel:", "job-retry:"))
            and card.photo_url is None
            and card.photo_rating_key is None
        )
        photo_url = (
            None
            if preserve_existing_photo
            else await self._media_panel_card_photo(card)
        )
        async with self._media_panel_message_lock(query_message):
            if not self._media_panel_transition_is_current(query_message, generation):
                return
            target_message = await self._edit_media_panel_card(
                query_message,
                card,
                photo_url=photo_url,
                generation=generation,
            )
            if not self._media_panel_transition_is_current(query_message, generation):
                return
            if route == "home":
                self._media_navigation_reset(target_message or query_message, "mp:home")
            elif route.startswith((
                "watching-key:",
                "recent-key:",
                "library-key:",
                "job:",
                "tracking:",
                "best-key:",
                "prem-key:",
                "discover-key:",
            )):
                self._media_navigation_visit(
                    target_message or query_message, f"mp:{route}"
                )

    async def _handle_tracking_check_callback(
        self, query, message, callback_data: str, route: str
    ) -> None:
        parts = route.split(":")
        if parts[0] == "tc" and len(parts) == 4:
            tracking_id, page_text = parts[1], parts[2]
        elif parts[0] == "tracking-check" and 2 <= len(parts) <= 3:
            tracking_id = parts[1]
            page_text = parts[2] if len(parts) == 3 else "1"
        else:
            await query.answer()
            return
        message_id = getattr(message, "message_id", None)
        if not isinstance(message_id, int):
            await query.answer()
            return
        page = int(page_text)
        receipts = self._get_business_action_receipt_store()
        try:
            receipt_state = receipts.claim(callback_data, message_id)
        except ValueError:
            await query.answer()
            return
        if receipt_state == "consumed":
            await query.answer()
            return
        if receipt_state == "claimed":
            await query.answer()
            return
        if receipt_state == "busy":
            await query.answer()
            return

        try:
            generation = self._media_panel_transition(message)
            if not await _answer_claimed_callback(
                query,
                lambda: receipts.release(callback_data, message_id),
            ):
                return
            context = self._media_plugin_context
            async with receipts.execution(callback_data, message_id) as owns_claim:
                if not owns_claim:
                    return
                if context is None:
                    receipts.release(callback_data, message_id)
                    card = render_tracking_check_failure_card(
                        tracking_id, page, callback_data
                    )
                else:
                    receipts.consume(callback_data, message_id)
                    try:
                        await asyncio.to_thread(
                            _command_payload,
                            context,
                            "mcp__media_admin__media_tracking_check",
                            {"tracking_id": tracking_id},
                        )
                    except (TypeError, ValueError, RuntimeError, OSError, TimeoutError):
                        card = render_tracking_check_failure_card(tracking_id, page)
                    else:
                        card = await asyncio.to_thread(
                            render_tracking_scheduled_card,
                            context,
                            tracking_id,
                            page,
                        )

            async with self._media_panel_message_lock(message):
                if not self._media_panel_transition_is_current(message, generation):
                    return
                photo_url = (
                    await self._media_panel_card_photo(card)
                    if getattr(card, "photo_url", None)
                    else None
                )
                await self._edit_media_panel_card(
                    message,
                    card,
                    photo_url=photo_url,
                    generation=generation,
                )
        finally:
            receipts.release(callback_data, message_id)

    def _get_media_action_store(self) -> MediaActionStore:
        store = getattr(self, "_media_action_store", None)
        if store is None:
            configured = os.environ.get("HERMES_MEDIA_ACTIONS_FILE")
            store = MediaActionStore(
                Path(configured) if configured else _DEFAULT_MEDIA_ACTIONS_FILE
            )
            self._media_action_store = store
        return store

    def _get_media_navigation_store(self) -> MediaNavigationStore:
        store = getattr(self, "_media_navigation_store", None)
        if store is None:
            configured = os.environ.get("HERMES_MEDIA_NAVIGATION_FILE")
            store = MediaNavigationStore(
                Path(configured) if configured else _DEFAULT_MEDIA_NAVIGATION_FILE
            )
            self._media_navigation_store = store
        return store

    @staticmethod
    def _media_navigation_key(message) -> str | None:
        chat_id = getattr(message, "chat_id", None)
        message_id = getattr(message, "message_id", None)
        if chat_id is None or message_id is None:
            return None
        return f"{chat_id}:{message_id}"

    def _media_navigation_current(self, message) -> str | None:
        key = self._media_navigation_key(message)
        return self._get_media_navigation_store().current(key) if key else None

    def _media_navigation_has_back(
        self, message, *, prefix: str | None = None
    ) -> bool:
        key = self._media_navigation_key(message)
        return (
            self._get_media_navigation_store().has_back(key, prefix=prefix)
            if key
            else False
        )

    def _media_navigation_visit(
        self,
        message,
        route: str,
        *,
        fallback: str | None = None,
        replace: bool = False,
    ) -> None:
        key = self._media_navigation_key(message)
        if key:
            self._get_media_navigation_store().visit(
                key, route, fallback=fallback, replace=replace
            )

    def _media_navigation_reset(self, message, route: str) -> None:
        key = self._media_navigation_key(message)
        if key:
            self._get_media_navigation_store().reset(key, route)

    async def _handle_media_navigation_callback(self, query) -> None:
        message = getattr(query, "message", None)
        if not self._authorize_media_callback(query, message):
            await query.answer()
            return
        key = self._media_navigation_key(message)
        route = self._get_media_navigation_store().back(key) if key else None
        if route is None:
            await query.answer()
            return
        replay = SimpleNamespace(
            data=route,
            message=message,
            from_user=getattr(query, "from_user", None),
            answer=query.answer,
        )
        if route.startswith("mt:"):
            await self._handle_trending_callback(replay, record_navigation=False)
        elif route.startswith("mi:"):
            await self._handle_similar_callback(replay, record_navigation=False)
        elif route.startswith("mx:"):
            await self._handle_discovery_action_callback(
                replay, record_navigation=False
            )
        elif route.startswith("mp:"):
            await self._handle_media_panel_callback(replay)
        else:
            await query.answer()

    def _get_business_action_receipt_store(self) -> BusinessActionReceiptStore:
        store = getattr(self, "_business_action_receipt_store", None)
        if store is None:
            configured = os.environ.get("HERMES_MEDIA_BUSINESS_ACTIONS_FILE")
            store = BusinessActionReceiptStore(
                Path(configured) if configured else _DEFAULT_BUSINESS_ACTION_RECEIPTS_FILE
            )
            self._business_action_receipt_store = store
        return store

    def _get_notifier_control_client(self) -> NotifierControlClient:
        client = getattr(self, "_notifier_control_client", None)
        if client is None:
            client = NotifierControlClient()
            self._notifier_control_client = client
        return client

    async def _handle_presentation_callback(self, query) -> None:
        data = getattr(query, "data", "") if query is not None else ""
        match = _PRESENTATION_CALLBACK_RE.fullmatch(data)
        query_message = getattr(query, "message", None)
        query_chat = getattr(query_message, "chat", None)
        caller_id = str(getattr(getattr(query, "from_user", None), "id", ""))
        if not self._is_callback_user_authorized(
            caller_id,
            chat_id=getattr(query_message, "chat_id", None),
            chat_type=str(getattr(query_chat, "type", "")),
            thread_id=str(getattr(query_message, "message_thread_id", "") or ""),
            user_name=getattr(getattr(query, "from_user", None), "first_name", None),
        ):
            await query.answer()
            return
        message_id = getattr(query_message, "message_id", None)
        if match is None or not isinstance(message_id, int):
            await query.answer()
            return

        command = _PRESENTATION_COMMANDS[match.group(1)]
        job_id = match.group(2)
        await query.answer()
        try:
            await asyncio.to_thread(
                self._get_notifier_control_client().control,
                command,
                job_id,
                str(message_id),
            )
        except NotifierControlStaleError:
            await self._edit_presentation_failure(
                query_message,
                "⚠️ Карточка устарела. Запросите текущий статус.",
                match.group(1),
                job_id,
            )
            return
        except (NotifierControlUnavailableError, ValueError):
            await self._edit_presentation_failure(
                query_message,
                "⚠️ Не удалось обновить карточку. Попробуйте ещё раз.",
                match.group(1),
                job_id,
            )
            return

    async def _edit_presentation_failure(
        self, message, text: str, action_code: str, job_id: str
    ) -> None:
        rows = [[
            InlineKeyboardButton(
                "🔄 Повторить", callback_data=f"hm:{action_code}:{job_id}"
            )
        ]]
        if action_code != "b":
            rows.append([
                InlineKeyboardButton("⬅️ Назад", callback_data=f"hm:b:{job_id}")
            ])
        await self._edit_message_card(message, text, InlineKeyboardMarkup(rows))

    async def _handle_media_action_callback(self, query) -> None:
        data = getattr(query, "data", "") if query is not None else ""
        match = _DOWNLOAD_ACTION_CALLBACK_RE.fullmatch(data)
        query_message = getattr(query, "message", None)
        query_chat = getattr(query_message, "chat", None)
        caller_id = str(getattr(getattr(query, "from_user", None), "id", ""))
        if not self._is_callback_user_authorized(
            caller_id,
            chat_id=getattr(query_message, "chat_id", None),
            chat_type=str(getattr(query_chat, "type", "")),
            thread_id=str(getattr(query_message, "message_thread_id", "") or ""),
            user_name=getattr(getattr(query, "from_user", None), "first_name", None),
        ):
            await query.answer()
            return
        if match is None or query_message is None:
            await query.answer()
            return

        token = match.group(1)
        store = self._get_media_action_store()
        resolved = store.resolve(token)
        if resolved is None:
            await query.answer()
            return
        action, consumed = resolved
        if action.kind == "noop":
            await query.answer()
            return
        if consumed:
            message = (
                "Эта загрузка уже была принята."
                if action.kind == "download"
                else "Эта кнопка устарела."
            )
            await query.answer()
            return
        claimed = store.claim(token)
        if claimed is None:
            await query.answer()
            return
        action, claim_state = claimed
        if claim_state == "consumed":
            message = (
                "Эта загрузка уже была принята."
                if action.kind == "download"
                else "Эта кнопка устарела."
            )
            await query.answer()
            return
        if claim_state == "claimed":
            await query.answer()
            return
        generation = self._media_panel_transition(query_message)
        async with store.execution(token) as owns_claim:
            if not owns_claim:
                await query.answer()
                return
            try:
                await self._dispatch_claimed_media_action(
                    query, query_message, token, action, store, generation
                )
            except TelegramError:
                pass
            finally:
                store.release(token)

    async def _dispatch_claimed_media_action(
        self,
        query,
        query_message,
        token: str,
        action: SearchAction,
        store: MediaActionStore,
        generation: int,
    ) -> None:
        if action.kind == "continue":
            await self._handle_continue_action(
                query, query_message, token, action, store, generation
            )
            return
        if action.kind == "combined-page":
            await self._handle_combined_page_action(
                query, query_message, token, action, store, generation
            )
            return
        if action.kind == "rendered-page":
            await self._handle_rendered_page_action(
                query, query_message, token, action, store, generation
            )
            return
        if action.kind == "provider-open":
            await self._handle_provider_open_action(
                query, query_message, token, action, store, generation
            )
            return
        if action.kind == "all-search-back":
            await self._handle_all_search_back_action(
                query, query_message, token, action, store, generation
            )
            return
        if action.kind in {"release-details", "release-page"}:
            await self._handle_release_details_action(
                query, query_message, token, action, store, generation
            )
            return
        if action.kind == "release-back":
            await self._handle_release_back_action(
                query, query_message, token, action, store, generation
            )
            return
        if action.kind == "job-open":
            await self._handle_job_open_action(
                query, query_message, token, action, store, generation
            )
            return
        if action.kind == "tracking-create":
            await self._handle_tracking_create_action(
                query, query_message, token, action, store, generation
            )
            return
        if action.kind in {"tracking-manage", "tracking-back"}:
            await self._handle_tracking_manage_action(
                query, query_message, token, action, store, generation
            )
            return
        if action.kind == "tracking-configure":
            await self._handle_tracking_configure_action(
                query, query_message, token, action, store, generation
            )
            return
        if action.kind == "tracking-enable-download":
            await self._handle_tracking_enable_download_action(
                query, query_message, token, action, store, generation
            )
            return
        if action.kind == "tracking-remove-prepare":
            await self._handle_tracking_remove_prepare_action(
                query, query_message, token, action, store, generation
            )
            return
        if action.kind == "tracking-remove-confirm":
            await self._handle_tracking_remove_confirm_action(
                query, query_message, token, action, store, generation
            )
            return
        await self._handle_download_action(
            query, query_message, token, action, store, generation
        )

    @staticmethod
    def _job_card_with_back(
        card: MediaPanelCard, callback_data: str, label: str
    ) -> MediaPanelCard:
        buttons = tuple(
            tuple(
                MediaPanelButton(label, callback_data)
                if button.label == "⬅️ Назад"
                else button
                for button in row
            )
            for row in card.buttons
        )
        return replace(card, buttons=buttons)

    def _job_card_with_source_back(
        self,
        card: MediaPanelCard,
        message_job_back: SearchAction | None,
    ) -> MediaPanelCard:
        if message_job_back is None:
            return card
        source_back = (
            _source_back_action(message_job_back.payload.get("source_back"))
            if message_job_back.kind == "job-open"
            else message_job_back
        )
        if source_back is None:
            return card
        back_token = self._get_media_action_store().create(source_back)
        return self._job_card_with_back(
            card,
            f"md:{back_token}",
            "⬅️ Назад к релизу",
        )

    async def _handle_job_open_action(
        self,
        query,
        query_message,
        token: str,
        action: SearchAction,
        store: MediaActionStore,
        generation: int,
    ) -> None:
        job_id = action.payload.get("job_id")
        source_back = _source_back_action(action.payload.get("source_back"))
        if not isinstance(job_id, str) or source_back is None:
            store.release(token)
            await query.answer()
            return
        if not await _answer_claimed_callback(query, lambda: store.release(token)):
            return
        try:
            card = await asyncio.to_thread(
                render_media_panel_card, self._media_plugin_context, f"job:{job_id}"
            )
        except (AttributeError, TypeError, ValueError, RuntimeError, OSError, TimeoutError):
            logger.exception("Failed to render media job card %s", job_id)
            store.release(token)
            return
        back_token = store.create(source_back)
        card = self._job_card_with_back(
            card, f"md:{back_token}", "⬅️ Назад к релизу"
        )
        async with self._media_panel_message_lock(query_message):
            if self._media_panel_transition_is_current(query_message, generation):
                await self._edit_media_panel_card(
                    query_message, card, generation=generation
                )
                store.consume(token)

    async def _handle_provider_open_action(
        self,
        query,
        query_message,
        token: str,
        action: SearchAction,
        store: MediaActionStore,
        generation: int,
    ) -> None:
        payload = action.payload
        source = payload.get("source")
        page = payload.get("search_page")
        season = payload.get("season")
        episode = payload.get("episode")
        if (
            source not in {"rezka", "prowlarr"}
            or not isinstance(page, dict)
            or not isinstance(season, int)
            or isinstance(season, bool)
            or not isinstance(episode, int)
            or isinstance(episode, bool)
        ):
            store.release(token)
            await query.answer()
            return
        rendered = _render_source_search(
            json.dumps(page, ensure_ascii=False).encode("utf-8"),
            source,
            season,
            episode,
            _source_back_action(payload.get("source_back")),
        )
        if rendered is None:
            store.release(token)
            await query.answer()
            return
        await query.answer()
        await self._present_claimed_search(
            query_message, rendered, token, store, generation
        )

    async def _handle_tracking_create_action(
        self,
        query,
        query_message,
        token: str,
        action: SearchAction,
        store: MediaActionStore,
        generation: int,
    ) -> None:
        if not await _answer_claimed_callback(query, lambda: store.release(token)):
            return
        payload = action.payload
        context = payload.get("tracking_context")
        arguments = context.get("create_arguments") if isinstance(context, dict) else None
        provider_media_ref = payload.get("provider_media_ref")
        translation_id = payload.get("translation_id")
        season = payload.get("season")
        translation = _bounded_text(payload.get("translation"))
        if (
            not isinstance(arguments, dict)
            or not isinstance(provider_media_ref, str)
            or re.fullmatch(r"[1-9]\d*", provider_media_ref) is None
            or not isinstance(translation_id, int)
            or isinstance(translation_id, bool)
            or translation_id < 1
            or not isinstance(season, int)
            or isinstance(season, bool)
            or season < 1
            or translation is None
        ):
            store.release(token)
            await self._edit_search_retry_card(
                query_message,
                "⚠️ Выбранная озвучка больше недоступна.",
                action,
                store,
                generation,
                _source_back_action(payload.get("source_back")),
            )
            return
        create_arguments = dict(arguments)
        create_arguments["translation"] = translation
        create_arguments["download"] = {
            "provider_media_ref": provider_media_ref,
            "translation_id": translation_id,
            "season": season,
        }
        store.consume(token)
        returncode, _output = await _run_media(
            ("mcp__media_admin__media_tracking_create", create_arguments),
            self._media_plugin_context,
        )
        if returncode == 127 and self._media_plugin_context is None:
            store.restore_consumed(token)
            await self._edit_search_retry_card(
                query_message,
                "⚠️ Сервис отслеживания временно недоступен.",
                action,
                store,
                generation,
                _source_back_action(payload.get("source_back")),
            )
            return
        if returncode != 0:
            await self._edit_search_back_card(
                query_message,
                "⚠️ Не удалось подтвердить добавление отслеживания. Проверьте раздел «Подписки».",
                store,
                generation,
                _source_back_action(payload.get("source_back")),
            )
            return
        self._invalidate_tv_tracking_cache()
        tmdb_id = context.get("tmdb_id") if isinstance(context, dict) else None
        details = (
            await self._details_payload("tv", tmdb_id)
            if isinstance(tmdb_id, int) and not isinstance(tmdb_id, bool)
            else None
        )
        if details is None:
            await self._edit_callback_result(
                query_message,
                "✅ Отслеживание настроено.",
                "mn:b",
                generation,
            )
            return
        await self._show_tracking_management(query_message, details, generation)

    async def _resolve_tracking_action(
        self, payload: dict
    ) -> tuple[dict, dict, dict] | None:
        tmdb_id = payload.get("tmdb_id")
        tracking_id = payload.get("tracking_id")
        if (
            not isinstance(tmdb_id, int)
            or isinstance(tmdb_id, bool)
            or tmdb_id < 1
            or not isinstance(tracking_id, str)
            or not tracking_id
            or len(tracking_id) > 128
        ):
            return None
        details = await self._details_payload("tv", tmdb_id)
        if details is None:
            return None
        state = await self._tv_tracking_state(details)
        if state is None:
            return None
        selected = next(
            (
                match
                for item in state.get("matches", ())
                if (match := self._tracking_match(item)) is not None
                and match["id"] == tracking_id
            ),
            None,
        )
        return (details, state, selected) if selected is not None else None

    async def _handle_tracking_manage_action(
        self, query, message, token, action, store, generation
    ) -> None:
        if not await _answer_claimed_callback(query, lambda: store.release(token)):
            return
        resolved = await self._resolve_tracking_action(action.payload)
        if resolved is None:
            store.release(token)
            await self._edit_callback_result(
                message,
                "⚠️ Отслеживание изменилось. Откройте его заново.",
                "mn:b",
                generation,
            )
            return
        details, state, selected = resolved
        edited = await self._show_tracking_management(
            message,
            details,
            generation,
            selected_tracking_id=selected["id"],
            state=state,
        )
        if edited:
            store.consume(token)

    async def _handle_tracking_configure_action(
        self, query, message, token, action, store, generation
    ) -> None:
        await query.answer()
        resolved = await self._resolve_tracking_action(action.payload)
        if resolved is None:
            store.release(token)
            await self._edit_callback_result(
                message,
                "⚠️ Отслеживание изменилось. Откройте его заново.",
                "mn:b",
                generation,
            )
            return
        details, state, selected = resolved
        title = _bounded_text(details.get("title"))
        season = state.get("season")
        if title is None or not isinstance(season, int) or season < 1:
            store.release(token)
            return
        returncode, output = await _search_media_mcp(
            self._media_plugin_context,
            "rezka",
            query=title,
            media_kind="series",
            season=season,
            tmdb_id=details["tmdb_id"],
        )
        back_action = self._tracking_action(
            "⬅️ Назад",
            "tracking-back",
            tmdb_id=details["tmdb_id"],
            tracking_id=selected["id"],
        )
        rendered = (
            _render_source_search(
                output,
                "rezka",
                season,
                0,
                back_action,
                carousel=False,
                tracking_context={
                    "mode": "configure",
                    "tmdb_id": details["tmdb_id"],
                    "tracking_id": selected["id"],
                },
            )
            if returncode == 0
            else None
        )
        if rendered is None or not self._rendered_has_search_results(rendered):
            store.release(token)
            await self._edit_search_retry_card(
                message,
                "⚠️ На Rezka пока нет подходящего релиза.",
                action,
                store,
                generation,
                back_action,
            )
            return
        await self._present_claimed_search(message, rendered, token, store, generation)

    async def _handle_tracking_enable_download_action(
        self, query, message, token, action, store, generation
    ) -> None:
        if not await _answer_claimed_callback(
            query,
            lambda: store.release(token),
            text="Включаю автоскачивание…",
        ):
            return
        payload = action.payload
        context = payload.get("tracking_context")
        resolved = (
            await self._resolve_tracking_action(context)
            if isinstance(context, dict) and context.get("mode") == "configure"
            else None
        )
        provider_media_ref = payload.get("provider_media_ref")
        translation_id = payload.get("translation_id")
        translation = _bounded_text(payload.get("translation"))
        season = payload.get("season")
        if (
            resolved is None
            or not isinstance(provider_media_ref, str)
            or re.fullmatch(r"[1-9]\d*", provider_media_ref) is None
            or not isinstance(translation_id, int)
            or isinstance(translation_id, bool)
            or translation_id < 1
            or translation is None
            or not isinstance(season, int)
            or isinstance(season, bool)
            or season < 1
        ):
            store.release(token)
            await self._edit_search_retry_card(
                message,
                "⚠️ Выбранная озвучка больше недоступна.",
                action,
                store,
                generation,
                _source_back_action(payload.get("source_back")),
            )
            return
        details, _state, selected = resolved
        arguments = {
            "tracking_id": selected["id"],
            "translation": translation,
            "provider_media_ref": provider_media_ref,
            "translation_id": translation_id,
            "season": season,
        }
        store.consume(token)
        returncode, _output = await _run_media(
            ("mcp__media_admin__media_tracking_enable_download", arguments),
            self._media_plugin_context,
        )
        if returncode == 127 and self._media_plugin_context is None:
            store.restore_consumed(token)
        if returncode != 0:
            await self._edit_search_back_card(
                message,
                "⚠️ Не удалось подтвердить включение автоскачивания. Проверьте подписку.",
                store,
                generation,
                _source_back_action(payload.get("source_back")),
            )
            return
        self._invalidate_tv_tracking_cache()
        await self._show_tracking_management(
            message,
            details,
            generation,
            selected_tracking_id=selected["id"],
        )

    async def _handle_tracking_remove_prepare_action(
        self, query, message, token, action, store, generation
    ) -> None:
        if not await _answer_claimed_callback(query, lambda: store.release(token)):
            return
        resolved = await self._resolve_tracking_action(action.payload)
        if resolved is None:
            store.release(token)
            await self._edit_callback_result(
                message,
                "⚠️ Отслеживание изменилось. Откройте его заново.",
                "mn:b",
                generation,
            )
            return
        details, _state, selected = resolved
        confirm = self._tracking_action(
            "🗑 Отключить",
            "tracking-remove-confirm",
            tmdb_id=details["tmdb_id"],
            tracking_id=selected["id"],
        )
        cancel = self._tracking_action(
            "⬅️ Назад",
            "tracking-manage",
            tmdb_id=details["tmdb_id"],
            tracking_id=selected["id"],
        )
        markup = _action_markup(store, (confirm, cancel))
        scope = "Личное" if selected["scope"] == "personal" else "Семейное"
        text = "\n".join((
            "Отключить отслеживание?",
            "",
            f"📺 {_bounded_text(details.get('title')) or 'Выбранный сериал'}",
            f"👤 {scope}",
            "Скачанные файлы останутся.",
        ))
        async with self._media_panel_message_lock(message):
            if not self._media_panel_transition_is_current(message, generation):
                return
            await self._edit_message_card(message, text, markup)
            store.consume(token)

    async def _handle_tracking_remove_confirm_action(
        self, query, message, token, action, store, generation
    ) -> None:
        if not await _answer_claimed_callback(query, lambda: store.release(token)):
            return
        resolved = await self._resolve_tracking_action(action.payload)
        if resolved is None:
            store.release(token)
            await self._edit_callback_result(
                message,
                "⚠️ Отслеживание уже изменилось.",
                "mn:b",
                generation,
            )
            return
        details, _state, selected = resolved
        store.consume(token)
        returncode, _output = await _run_media(
            (
                "mcp__media_admin__media_tracking_remove",
                {"tracking_id": selected["id"]},
            ),
            self._media_plugin_context,
        )
        if returncode == 127 and self._media_plugin_context is None:
            store.restore_consumed(token)
        if returncode != 0:
            await self._edit_search_back_card(
                message,
                "⚠️ Не удалось подтвердить отключение отслеживания. Проверьте подписку.",
                store,
                generation,
                self._tracking_action(
                    "⬅️ Назад",
                    "tracking-manage",
                    tmdb_id=details["tmdb_id"],
                    tracking_id=selected["id"],
                ),
            )
            return
        self._invalidate_tv_tracking_cache()
        await self._show_tracking_management(message, details, generation)

    async def _handle_all_search_back_action(
        self,
        query,
        query_message,
        token: str,
        action: SearchAction,
        store: MediaActionStore,
        generation: int,
    ) -> None:
        payload = action.payload
        title = _bounded_text(payload.get("query"))
        media_kind = payload.get("media_kind")
        season = payload.get("season")
        episode = payload.get("episode")
        if (
            title is None
            or media_kind not in {"movie", "series"}
            or not isinstance(season, int)
            or isinstance(season, bool)
            or not isinstance(episode, int)
            or isinstance(episode, bool)
        ):
            store.release(token)
            await query.answer()
            return
        await query.answer()
        sources = ("rezka", "prowlarr")
        searches = await asyncio.gather(*(
            _search_media_mcp(
                self._media_plugin_context,
                source,
                query=title,
                media_kind=media_kind,
                season=season if media_kind == "series" else None,
            )
            for source in sources
        ))
        pages = {
            source: page
            for source, (returncode, output) in zip(sources, searches, strict=True)
            if returncode == 0
            and (page := _decode_search_page(output, source)) is not None
        }
        if not pages:
            store.release(token)
            await self._edit_search_retry_card(
                query_message,
                "⚠️ Источники временно недоступны. Попробуйте ещё раз.",
                action,
                store,
                generation,
                _source_back_action(payload.get("overview_back")),
            )
            return
        rendered_searches = []
        for source, page in pages.items():
            rendered = _render_source_search(
                json.dumps(page, ensure_ascii=False).encode("utf-8"),
                source,
                season,
                episode,
                _source_back_action(payload.get("overview_back")),
                carousel=False,
            )
            if rendered is not None:
                rendered_searches.append(rendered)
        failed_sources = [
            "Rezka" if source == "rezka" else "Prowlarr"
            for source in sources
            if source not in pages
        ]
        rendered = _combine_source_results(
            rendered_searches,
            failed_sources,
        )
        if rendered is None:
            store.release(token)
            await self._edit_search_retry_card(
                query_message,
                "⚠️ Источники временно недоступны. Попробуйте ещё раз.",
                action,
                store,
                generation,
                _source_back_action(payload.get("overview_back")),
            )
            return
        await self._present_claimed_search(
            query_message, rendered, token, store, generation
        )

    async def _edit_search_retry_card(
        self,
        message,
        text: str,
        retry_action: SearchAction,
        store: MediaActionStore,
        generation: int,
        back_action: SearchAction | None = None,
    ) -> None:
        actions = [
            SearchAction(
                "🔄 Повторить",
                retry_action.kind,
                retry_action.payload,
                retry_action.expires_at,
            )
        ]
        actions.append(
            back_action
            if back_action is not None
            else SearchAction(
                "⬅️ Назад",
                "navigation-back",
                {},
                retry_action.expires_at,
            )
        )
        markup = _action_markup(store, tuple(actions))
        async with self._media_panel_message_lock(message):
            if not self._media_panel_transition_is_current(message, generation):
                return
            await self._edit_message_card(message, text, markup)

    async def _edit_search_back_card(
        self,
        message,
        text: str,
        store: MediaActionStore,
        generation: int,
        back_action: SearchAction | None = None,
    ) -> None:
        action = back_action or SearchAction(
            "⬅️ Назад",
            "navigation-back",
            {},
            "2099-12-31T23:59:59Z",
        )
        markup = _action_markup(store, (action,))
        async with self._media_panel_message_lock(message):
            if not self._media_panel_transition_is_current(message, generation):
                return
            await self._edit_message_card(message, text, markup)

    async def _present_claimed_search(
        self,
        query_message,
        rendered,
        token: str,
        store: MediaActionStore,
        generation: int,
        *,
        page: int = 0,
    ) -> None:
        try:
            await self._present_search_once(
                query_message, rendered, store, generation, page=page
            )
        except Exception:
            store.release(token)
            raise
        store.consume(token)

    async def _present_search_once(
        self,
        message,
        rendered: RenderedSearch,
        store: MediaActionStore,
        generation: int,
        *,
        page: int = 0,
    ) -> None:
        parts = tuple(rendered.parts)
        if not parts or page < 0 or page >= len(parts):
            return
        part = self._search_part_page(parts, page)
        async with self._media_panel_message_lock(message):
            if not self._media_panel_transition_is_current(message, generation):
                return
            await self._present_search_part(message, part, store, replace=True)

    @staticmethod
    def _search_part_page(
        parts: tuple[RenderedSearchPart, ...], page: int
    ) -> RenderedSearchPart:
        part = parts[page]
        if len(parts) == 1:
            return part
        expires_at = next(
            (action.expires_at for action in part.actions if action.expires_at),
            "2099-12-31T23:59:59Z",
        )
        serialized = media_search_module._serialize_search_parts(parts)
        previous = (
            SearchAction(
                "⬅️",
                "rendered-page",
                {"parts": serialized, "page": page - 1},
                expires_at,
            )
            if page > 0
            else SearchAction("⬅️", "noop", {}, expires_at)
        )
        position = SearchAction(
            f"{page + 1}/{len(parts)}", "noop", {}, expires_at
        )
        following = (
            SearchAction(
                "➡️",
                "rendered-page",
                {"parts": serialized, "page": page + 1},
                expires_at,
            )
            if page + 1 < len(parts)
            else SearchAction("➡️", "noop", {}, expires_at)
        )
        return RenderedSearchPart(
            part.text,
            (*part.actions, previous, position, following),
            part.photo_url,
        )

    async def _handle_rendered_page_action(
        self,
        query,
        query_message,
        token: str,
        action: SearchAction,
        store: MediaActionStore,
        generation: int,
    ) -> None:
        parts = media_search_module._deserialize_search_parts(
            action.payload.get("parts")
        )
        page = action.payload.get("page")
        if (
            parts is None
            or not isinstance(page, int)
            or isinstance(page, bool)
            or page < 0
            or page >= len(parts)
        ):
            store.release(token)
            await query.answer()
            return
        await query.answer()
        rendered = RenderedSearch(parts[page].text, parts[page].actions, parts)
        await self._present_claimed_search(
            query_message,
            rendered,
            token,
            store,
            generation,
            page=page,
        )

    async def _handle_release_details_action(
        self,
        query,
        query_message,
        token: str,
        action: SearchAction,
        store: MediaActionStore,
        generation: int,
    ) -> None:
        payload = action.payload
        search_page = payload.get("search_page")
        if not isinstance(search_page, dict):
            store.release(token)
            await query.answer()
            return
        rendered = _render_release_details(
            payload,
            search_page=search_page,
            source_back_action=_source_back_action(payload.get("source_back")),
        )
        if rendered is None:
            store.release(token)
            await query.answer()
            return
        await query.answer()
        await self._present_claimed_search(
            query_message, rendered, token, store, generation
        )

    async def _handle_release_back_action(
        self,
        query,
        query_message,
        token: str,
        action: SearchAction,
        store: MediaActionStore,
        generation: int,
    ) -> None:
        payload = action.payload
        search_page = payload.get("search_page")
        if not isinstance(search_page, dict):
            store.release(token)
            await query.answer()
            return
        season = payload.get("season")
        episode = payload.get("episode")
        if (
            not isinstance(season, int)
            or isinstance(season, bool)
            or not isinstance(episode, int)
            or isinstance(episode, bool)
        ):
            store.release(token)
            await query.answer()
            return
        combined_context = payload.get("combined_context")
        tracking_context = (
            payload.get("tracking_context")
            if isinstance(payload.get("tracking_context"), dict)
            else None
        )
        if isinstance(combined_context, dict):
            pages = combined_context.get("search_pages")
            failures = combined_context.get("failed_providers")
            if isinstance(pages, list) and isinstance(failures, list):
                rendered_searches = []
                for page in pages[:2]:
                    if not isinstance(page, dict):
                        continue
                    source = page.get("source")
                    if source not in {"rezka", "prowlarr"}:
                        continue
                    try:
                        output = json.dumps(page, ensure_ascii=False).encode("utf-8")
                    except (TypeError, ValueError):
                        continue
                    rendered = _render_source_search(
                        output,
                        source,
                        season,
                        episode,
                        _source_back_action(payload.get("source_back")),
                        carousel=False,
                        tracking_context=tracking_context,
                    )
                    if rendered is not None:
                        rendered_searches.append(rendered)
                failed_providers = [
                    provider
                    for provider in failures
                    if provider in {"Rezka", "Prowlarr"}
                ]
                combined = _combine_source_results(
                    rendered_searches,
                    failed_providers,
                    page=(
                        payload.get("combined_page", 0)
                        if isinstance(payload.get("combined_page", 0), int)
                        and not isinstance(payload.get("combined_page", 0), bool)
                        else 0
                    ),
                )
                if combined is not None:
                    await query.answer()
                    await self._present_claimed_search(
                        query_message,
                        combined,
                        token,
                        store,
                        generation,
                    )
                    return
        try:
            search_output = json.dumps(search_page, ensure_ascii=False).encode("utf-8")
        except (TypeError, ValueError):
            store.release(token)
            await query.answer()
            return
        source = search_page.get("source")
        if (
            source not in {"rezka", "prowlarr"}
        ):
            store.release(token)
            await query.answer()
            return
        rendered = _render_source_search(
            search_output,
            source,
            season,
            episode,
            _source_back_action(payload.get("source_back")),
            carousel=False,
            tracking_context=(
                payload.get("tracking_context")
                if isinstance(payload.get("tracking_context"), dict)
                else None
            ),
        )
        if rendered is None:
            store.release(token)
            await query.answer()
            return
        await query.answer()
        await self._present_claimed_search(
            query_message, rendered, token, store, generation
        )

    async def _handle_download_action(
        self,
        query,
        query_message,
        token: str,
        action: SearchAction,
        store: MediaActionStore,
        generation: int,
    ) -> None:
        payload = action.payload
        source = payload.get("source")
        choice_set_id = payload.get("choice_set_id")
        session_id = payload.get("session_id")
        result_id = payload.get("result_id")
        season = payload.get("season")
        episode = payload.get("episode")
        if (
            source not in {"rezka", "prowlarr"}
            or (
                not isinstance(choice_set_id, str)
                and not isinstance(session_id, str)
            )
            or not isinstance(result_id, str)
            or not isinstance(season, int)
            or isinstance(season, bool)
            or season < 0
            or not isinstance(episode, int)
            or isinstance(episode, bool)
            or episode < 0
        ):
            store.release(token)
            await query.answer()
            return
        use_choice_set = isinstance(choice_set_id, str)
        arguments: dict[str, object] = {
            "result_id": result_id,
        }
        if use_choice_set:
            arguments["choice_set_id"] = choice_set_id
            arguments["source"] = source
        else:
            arguments["session_id"] = session_id
        translation_id = payload.get("translation_id")
        if source == "rezka":
            if not isinstance(translation_id, int) or isinstance(translation_id, bool):
                store.release(token)
                await query.answer()
                return
            arguments["translation_id"] = translation_id
            if season > 0:
                arguments["season"] = season
            if episode > 0:
                arguments["episode"] = episode
        tool_name = (
            "mcp__media_admin__media_episode_choice_set_download"
            if use_choice_set
            else "mcp__media_admin__media_download"
        )
        if not await _answer_claimed_callback(
            query,
            lambda: store.release(token),
            text="Добавляю…",
        ):
            return
        store.consume(token)
        returncode, output = await _run_media(
            (tool_name, arguments),
            self._media_plugin_context,
        )
        if returncode == 127 and self._media_plugin_context is None:
            store.restore_consumed(token)
        job_id = _created_job_id(output) if returncode == 0 else None
        release_back = _source_back_action(payload.get("release_back"))
        if returncode != 0 or job_id is None:
            await self._edit_search_back_card(
                query_message,
                "⚠️ Не удалось подтвердить добавление загрузки. Проверьте раздел «Загрузки».",
                store,
                generation,
                _source_back_action(payload.get("source_back")),
            )
            return
        if release_back is not None:
            release_back.payload["downloaded_job_id"] = job_id
        try:
            card = await asyncio.to_thread(
                render_media_panel_card, self._media_plugin_context, f"job:{job_id}"
            )
        except (AttributeError, TypeError, ValueError, RuntimeError, OSError, TimeoutError):
            logger.exception("Failed to render newly created media job %s", job_id)
            await self._edit_search_back_card(
                query_message,
                "⚠️ Загрузка добавлена, но карточка временно недоступна. Откройте её в «Загрузках».",
                store,
                generation,
                release_back,
            )
            return
        if release_back is not None:
            back_token = store.create(release_back)
            card = self._job_card_with_back(
                card, f"md:{back_token}", "⬅️ Назад к релизу"
            )
        async with self._media_panel_message_lock(query_message):
            if not self._media_panel_transition_is_current(query_message, generation):
                return
            await self._edit_media_panel_card(
                query_message, card, generation=generation
            )

    async def _handle_continue_action(
        self,
        query,
        query_message,
        token: str,
        action: SearchAction,
        store: MediaActionStore,
        generation: int,
    ) -> None:
        payload = action.payload
        source = payload.get("source")
        continuation = payload.get("continuation")
        season = payload.get("season")
        episode = payload.get("episode")
        if (
            source not in {"rezka", "prowlarr"}
            or not isinstance(continuation, str)
            or not isinstance(season, int)
            or isinstance(season, bool)
            or season < 0
            or not isinstance(episode, int)
            or isinstance(episode, bool)
            or episode < 0
        ):
            store.release(token)
            await query.answer()
            return
        await query.answer()
        returncode, output = await _search_media_mcp(
            self._media_plugin_context,
            source,
            continuation=continuation,
        )
        combined_context = payload.get("combined_context")
        tracking_context = (
            payload.get("tracking_context")
            if isinstance(payload.get("tracking_context"), dict)
            else None
        )
        if returncode == 0 and isinstance(combined_context, dict):
            try:
                next_page = json.loads(output.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                next_page = None
            pages = combined_context.get("search_pages")
            if (
                isinstance(next_page, dict)
                and next_page.get("source") == source
                and isinstance(next_page.get("results"), list)
                and isinstance(pages, list)
            ):
                merged_pages = []
                found_source = False
                for existing_page in pages:
                    if not isinstance(existing_page, dict):
                        continue
                    if existing_page.get("source") != source:
                        merged_pages.append(existing_page)
                        continue
                    previous_results = existing_page.get("results")
                    if not isinstance(previous_results, list):
                        previous_results = []
                    seen_ids = {
                        result.get("result_id")
                        for result in previous_results
                        if isinstance(result, dict)
                    }
                    merged_results = [*previous_results]
                    merged_results.extend(
                        result
                        for result in next_page["results"]
                        if isinstance(result, dict)
                        and result.get("result_id") not in seen_ids
                    )
                    merged_pages.append({**next_page, "results": merged_results})
                    found_source = True
                if not found_source:
                    merged_pages.append(next_page)
                updated_context = {
                    **combined_context,
                    "search_pages": merged_pages,
                }
                if tracking_context is not None:
                    updated_context["tracking_context"] = tracking_context
                rendered = self._render_combined_search_context(
                    updated_context,
                    payload.get("combined_page", 0),
                )
                if rendered is not None:
                    await self._present_claimed_search(
                        query_message, rendered, token, store, generation
                    )
                    return
        carousel_page = payload.get("carousel_page")
        if returncode == 0 and isinstance(carousel_page, dict):
            try:
                next_page = json.loads(output.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                next_page = None
            previous_results = carousel_page.get("results")
            next_results = next_page.get("results") if isinstance(next_page, dict) else None
            if (
                isinstance(previous_results, list)
                and isinstance(next_results, list)
                and next_results
                and next_page.get("source") == source
            ):
                merged_page = {
                    **next_page,
                    "results": [*previous_results, *next_results],
                }
                first_result = next_results[0]
                result_id = first_result.get("result_id") if isinstance(first_result, dict) else None
                title = first_result.get("title") if isinstance(first_result, dict) else None
                detail_payload = {
                    "source": source,
                    "session_id": merged_page.get("session_id"),
                    "result_id": result_id,
                    "result_index": len(previous_results) + 1,
                    "result": first_result,
                    "season": season,
                    "episode": episode,
                    "title": title,
                    "combined_context": payload.get("combined_context"),
                }
                if payload.get("direct_back") is True:
                    detail_payload["direct_back"] = True
                if tracking_context is not None:
                    detail_payload["tracking_context"] = tracking_context
                rendered = _render_release_details(
                    detail_payload,
                    search_page=merged_page,
                    source_back_action=_source_back_action(payload.get("source_back")),
                )
                if rendered is not None:
                    await self._present_claimed_search(
                        query_message, rendered, token, store, generation
                    )
                    return
        rendered = (
            _render_source_search(
                output,
                source,
                season,
                episode,
                _source_back_action(payload.get("source_back")),
                combined_context=(
                    payload.get("combined_context")
                    if isinstance(payload.get("combined_context"), dict)
                    else None
                ),
                tracking_context=tracking_context,
                direct_back=payload.get("direct_back") is True,
            )
            if returncode == 0
            else None
        )
        if rendered is None:
            store.release(token)
            await self._edit_search_retry_card(
                query_message,
                "⚠️ Следующая страница временно недоступна. Повторите поиск.",
                action,
                store,
                generation,
                _source_back_action(payload.get("source_back")),
            )
            return
        await self._present_claimed_search(
            query_message, rendered, token, store, generation
        )

    async def _handle_combined_page_action(
        self,
        query,
        query_message,
        token: str,
        action: SearchAction,
        store: MediaActionStore,
        generation: int,
    ) -> None:
        context = action.payload.get("combined_context")
        page = action.payload.get("page")
        if (
            not isinstance(context, dict)
            or not isinstance(page, int)
            or isinstance(page, bool)
            or page < 0
        ):
            store.release(token)
            await query.answer()
            return
        rendered = self._render_combined_search_context(context, page)
        if rendered is None:
            store.release(token)
            await query.answer()
            return
        await query.answer()
        await self._present_claimed_search(
            query_message, rendered, token, store, generation
        )

    def _render_combined_search_context(
        self,
        context: dict,
        page: object,
    ) -> RenderedSearch | None:
        pages = context.get("search_pages")
        failures = context.get("failed_providers")
        season = context.get("season", 0)
        episode = context.get("episode", 0)
        back_action = _source_back_action(context.get("back_action"))
        tracking_context = (
            context.get("tracking_context")
            if isinstance(context.get("tracking_context"), dict)
            else None
        )
        if (
            not isinstance(pages, list)
            or not isinstance(failures, list)
            or not isinstance(season, int)
            or isinstance(season, bool)
            or not isinstance(episode, int)
            or isinstance(episode, bool)
            or not isinstance(page, int)
            or isinstance(page, bool)
        ):
            return None
        rendered_searches = []
        for search_page in pages[:2]:
            if not isinstance(search_page, dict):
                continue
            source = search_page.get("source")
            if source not in {"rezka", "prowlarr"}:
                continue
            try:
                search_output = json.dumps(
                    search_page, ensure_ascii=False
                ).encode("utf-8")
            except (TypeError, ValueError):
                continue
            rendered = _render_source_search(
                search_output,
                source,
                season,
                episode,
                back_action,
                carousel=False,
                combined_context=context,
                result_limit=None,
                tracking_context=tracking_context,
            )
            if rendered is not None:
                rendered_searches.append(rendered)
        return _combine_source_results(
            rendered_searches,
            [
                provider
                for provider in failures
                if provider in {"Rezka", "Prowlarr"}
            ],
            page=max(page, 0),
        )

    async def _handle_source_choice_callback(self, query) -> None:
        data = getattr(query, "data", "") if query is not None else ""
        back_match = _SOURCE_BACK_CALLBACK_RE.fullmatch(data)
        match = _SOURCE_CHOICE_CALLBACK_RE.fullmatch(data)
        query_message = getattr(query, "message", None)
        query_chat = getattr(query_message, "chat", None)
        caller_id = str(getattr(getattr(query, "from_user", None), "id", ""))
        if not self._is_callback_user_authorized(
            caller_id,
            chat_id=getattr(query_message, "chat_id", None),
            chat_type=str(getattr(query_chat, "type", "")),
            thread_id=str(getattr(query_message, "message_thread_id", "") or ""),
            user_name=getattr(getattr(query, "from_user", None), "first_name", None),
        ):
            await query.answer()
            return
        if query_message is None or (match is None and back_match is None):
            await query.answer()
            return
        generation = self._media_panel_transition(query_message)

        if back_match is not None:
            tracking_id, season_text, episode_text = back_match.groups()
            season = int(season_text)
            episode = int(episode_text)
            await query.answer()
            tracking_code, tracking_output = await _tracking_pages(
                _run_media, self._media_plugin_context
            )
            title = (
                _tracking_title(tracking_output, tracking_id)
                if tracking_code == 0
                else None
            )
            if title is None:
                markup = InlineKeyboardMarkup([
                    [InlineKeyboardButton(
                        "🔄 Повторить",
                        callback_data=f"ms:b:{tracking_id}:{season}:{episode}",
                    )],
                    [InlineKeyboardButton(
                        "⬅️ Назад", callback_data=f"mp:tracking:{tracking_id}:1"
                    )],
                ])
                await self._edit_tracking_choice_card(
                    query_message,
                    "⚠️ Не удалось восстановить выбор источника. "
                    "Обновите отслеживания.",
                    markup,
                    generation,
                )
                return
            text = "\n".join((
                f"📺 {title}",
                f"🆕 S{season:02d}E{episode:02d}",
                "",
                "Выберите источник",
            ))
            markup = InlineKeyboardMarkup([
                [
                    InlineKeyboardButton(
                        "🌐 Rezka",
                        callback_data=f"ms:r:{tracking_id}:{season}:{episode}",
                    ),
                    InlineKeyboardButton(
                        "🧲 Prowlarr",
                        callback_data=f"ms:p:{tracking_id}:{season}:{episode}",
                    ),
                ],
                [InlineKeyboardButton(
                    "⬅️ Назад", callback_data=f"mp:tracking:{tracking_id}:1"
                )],
            ])
            await self._edit_tracking_choice_card(
                query_message, text, markup, generation
            )
            return

        action_code, tracking_id, season_text, episode_text = match.groups()
        source_action = {"a": "all", "r": "rezka", "p": "prowlarr"}[action_code]
        season = int(season_text)
        episode = int(episode_text)
        # A callback must be acknowledged before any network or rendering work.
        # Telegram otherwise reports a spinner/timeout even when the cached
        # choice set is available.
        try:
            await query.answer(text=_SEARCH_LOADING_TOAST)
        except BadRequest as error:
            # Telegram can deliver a callback after its answer window has
            # elapsed. The message edit is still useful, so continue for the
            # known stale-query response instead of failing the callback.
            if not _is_expired_callback_query(error):
                raise

        choice_set_id = str(
            uuid.uuid5(
                uuid.NAMESPACE_URL,
                f"tracking:{tracking_id}:{season}:{episode}",
            )
        )
        choice_code, choice_output = await _run_media(
            (
                "mcp__media_admin__media_episode_choice_set",
                {"choice_set_id": choice_set_id},
            ),
            self._media_plugin_context,
        )
        try:
            choice_value = json.loads(choice_output.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            choice_value = None
        # Compatibility for a still-running media-service that predates the
        # durable choice-set MCP tool. This branch is deliberately restricted
        # to the old tracking-list response shape; a real expired choice set
        # never falls back to provider searches.
        if choice_code == 0 and isinstance(choice_value, dict) and "tracking" in choice_value:
            await self._handle_legacy_source_choice_callback(
                query,
                source_action,
                tracking_id,
                season,
                episode,
                choice_output,
                generation,
            )
            return
        if (
            choice_code != 0
            or not isinstance(choice_value, dict)
            or choice_value.get("status") != "ready"
            or not isinstance(choice_value.get("sources"), dict)
            or not choice_value.get("sources")
        ):
            # The refresh tool is the only server-side path that may search.
            # Keep the current card stable; the single callback toast above is
            # the loading signal.
            refresh_code, refresh_output = await _run_media(
                (
                    "mcp__media_admin__media_episode_choice_set_refresh",
                    {"choice_set_id": choice_set_id},
                ),
                self._media_plugin_context,
            )
            try:
                refreshed = json.loads(refresh_output.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                refreshed = None
            if (
                refresh_code != 0
                or not isinstance(refreshed, dict)
                or not isinstance(refreshed.get("sources"), dict)
                or not refreshed.get("sources")
            ):
                # Never leave the edited card in a permanent spinner when a
                # provider refresh fails. Keep the user on the same card with
                # an explicit retry and a deterministic return action.
                error_text = "\n".join(
                    (
                        "⚠️ Не удалось обновить варианты",
                        "",
                        f"📺 Сезон {season} · серия {episode}",
                        "",
                        "Сервисы временно недоступны. Повторите попытку позже.",
                    )
                )
                error_markup = InlineKeyboardMarkup(
                    [
                        [
                            InlineKeyboardButton(
                                "🔄 Повторить",
                                callback_data=f"ms:{action_code}:{tracking_id}:{season}:{episode}",
                            )
                        ],
                        [
                            InlineKeyboardButton(
                                "⬅️ Назад",
                                callback_data=f"ms:b:{tracking_id}:{season}:{episode}",
                            )
                        ],
                    ]
                )
                await self._edit_tracking_choice_card(
                    query_message, error_text, error_markup, generation
                )
                return
            choice_value = refreshed

        source_names = ("rezka", "prowlarr") if source_action == "all" else (source_action,)
        rendered_searches = []
        failed_sources = []
        source_back_action = SearchAction(
            label="⬅️ Назад",
            kind="source-back",
            payload={
                "tracking_id": tracking_id,
                "season": season,
                "episode": episode,
            },
            expires_at="2099-12-31T23:59:59Z",
        )
        sources = choice_value.get("sources")
        for source in source_names:
            source_value = sources.get(source) if isinstance(sources, dict) else None
            page_value = {
                "api_version": "v1",
                "source": source,
                # This is an opaque selection reference. The private search
                # session locator never leaves media-service.
                "session_id": source_value.get("selection_ref") if isinstance(source_value, dict) else None,
                "choice_set_id": choice_value.get("choice_set_id"),
                "expires_at": source_value.get("expires_at", choice_value.get("expires_at")) if isinstance(source_value, dict) else choice_value.get("expires_at"),
                "results": source_value.get("results", []) if isinstance(source_value, dict) else [],
            }
            if not isinstance(page_value["session_id"], str) or not isinstance(page_value["expires_at"], str):
                page = None
            else:
                page = _render_source_search(
                    json.dumps(page_value, ensure_ascii=False).encode("utf-8"),
                    source,
                    season,
                    episode,
                    source_back_action,
                    carousel=False,
                    result_limit=None,
                )
            if page is None:
                failed_sources.append("Rezka" if source == "rezka" else "Prowlarr")
                continue
            rendered_searches.append(page)
        combined = _combine_source_results(rendered_searches, failed_sources)
        if combined is None or not self._rendered_has_search_results(combined):
            error_markup = InlineKeyboardMarkup([
                [InlineKeyboardButton(
                    "🔄 Повторить",
                    callback_data=f"ms:{action_code}:{tracking_id}:{season}:{episode}",
                )],
                [InlineKeyboardButton(
                    "⬅️ Назад",
                    callback_data=f"ms:b:{tracking_id}:{season}:{episode}",
                )],
            ])
            await self._edit_tracking_choice_card(
                query_message,
                "⚠️ Источники сейчас не вернули доступных вариантов.",
                error_markup,
                generation,
            )
            return
        # Open the best exact result directly as a release carousel. The list
        # remains reachable through the existing Back/navigation actions.
        first_action = next(
            (
                action
                for part in combined.parts
                for action in part.actions
                if action.kind == "release-details"
            ),
            None,
        )
        if first_action is not None:
            first_page = first_action.payload.get("search_page")
            first_payload = dict(first_action.payload)
            direct = _render_release_details(
                first_payload,
                search_page=first_page if isinstance(first_page, dict) else None,
                source_back_action=source_back_action,
            )
            if direct is not None:
                combined = direct
        store = self._get_media_action_store()
        await self._present_search_once(
            query_message, combined, store, generation
        )

    async def _edit_tracking_choice_card(
        self,
        message,
        text: str,
        markup: InlineKeyboardMarkup | None,
        generation: int,
    ) -> None:
        async with self._media_panel_message_lock(message):
            if not self._media_panel_transition_is_current(message, generation):
                return
            await self._edit_message_card(message, text, markup)

    @staticmethod
    def _rendered_has_search_results(rendered: RenderedSearch) -> bool:
        return any(
            action.kind in {"download", "release-details"}
            for part in rendered.parts
            for action in part.actions
        )

    async def _handle_legacy_source_choice_callback(
        self,
        query,
        source_action: str,
        tracking_id: str,
        season: int,
        episode: int,
        tracking_output: bytes,
        generation: int,
    ) -> None:
        """Bridge one rollout window before all media services have migrated.

        Production notifications use ``media_episode_choice_set`` above. The
        narrow response-shape check keeps old test fixtures/older services
        usable without weakening the cached path or accepting arbitrary
        provider payloads as a choice set.
        """
        query_message = getattr(query, "message", None)
        tracking_context = _tracking_context(tracking_output, tracking_id)
        if tracking_context is None:
            markup = InlineKeyboardMarkup([[
                InlineKeyboardButton(
                    "⬅️ Назад", callback_data=f"mp:tracking:{tracking_id}:1"
                )
            ]])
            await self._edit_tracking_choice_card(
                query_message,
                "⚠️ Не удалось найти это отслеживание. Обновите список отслеживаний.",
                markup,
                generation,
            )
            return
        title = tracking_context["title"]
        release_identity = None
        release_source = tracking_context.get("release_source")
        release_source_id = tracking_context.get("release_source_id")
        if release_source == "tvmaze" and isinstance(release_source_id, int):
            release_code, release_output = await _run_media(
                (
                    "mcp__media_admin__media_release_schedule",
                    {"title": title, "source_id": release_source_id},
                ),
                self._media_plugin_context,
            )
            if release_code == 0:
                release_identity = _release_match_context(release_output)
        sources = ("rezka", "prowlarr") if source_action == "all" else (source_action,)
        searches = await asyncio.gather(
            *(
                _search_media_mcp(
                    self._media_plugin_context,
                    source,
                    query=title,
                    media_kind="series",
                    season=season,
                )
                for source in sources
            )
        )
        rendered_searches = []
        failed_sources = []
        source_back_action = SearchAction(
            label="⬅️ Назад",
            kind="source-back",
            payload={"tracking_id": tracking_id, "season": season, "episode": episode},
            expires_at="2099-12-31T23:59:59Z",
        )
        for source, (returncode, output) in zip(sources, searches, strict=True):
            provider = "Rezka" if source == "rezka" else "Prowlarr"
            output = _rank_tracking_search_output(
                output, source, release_identity, season, episode
            )
            page = (
                _render_source_search(
                    output,
                    source,
                    season,
                    episode,
                    source_back_action,
                    carousel=source_action != "all",
                )
                if returncode == 0
                else None
            )
            if page is None:
                failed_sources.append(provider)
            else:
                rendered_searches.append(page)
        combined = _combine_source_results(rendered_searches, failed_sources)
        if combined is None or not self._rendered_has_search_results(combined):
            action_code = {"all": "a", "rezka": "r", "prowlarr": "p"}[source_action]
            markup = InlineKeyboardMarkup([
                [InlineKeyboardButton(
                    "🔄 Повторить",
                    callback_data=f"ms:{action_code}:{tracking_id}:{season}:{episode}",
                )],
                [InlineKeyboardButton(
                    "⬅️ Назад",
                    callback_data=f"ms:b:{tracking_id}:{season}:{episode}",
                )],
            ])
            await self._edit_tracking_choice_card(
                query_message,
                "⚠️ Источники сейчас не вернули доступных вариантов.",
                markup,
                generation,
            )
            return
        store = self._get_media_action_store()
        await self._present_search_once(
            query_message, combined, store, generation
        )


def _build_adapter(config):
    adapter = HomeTelegramAdapter(config)
    adapter._notifications_mode = _resolve_notifications_mode()
    return adapter


def register(ctx) -> None:
    HomeTelegramAdapter._media_plugin_context = ctx
    ctx.register_hook("transform_llm_output", _suppress_download_confirmation)
    ctx.register_hook("transform_llm_output", _strip_internal_ids)
    ctx.register_command(
        "media",
        handler=lambda _raw: _media_panel_home(),
        description="Открыть медиа-панель",
    )
    ctx.register_command(
        "watching",
        handler=lambda raw: _render_watching_command(ctx, raw),
        description="Что сейчас смотрят в Plex",
    )
    for name, category, description in (
        ("movies", "movie", "Топ фильмов TMDB за неделю"),
        ("series", "tv", "Топ сериалов TMDB за неделю"),
        ("trending", "all", "Тренды TMDB за неделю"),
    ):
        ctx.register_command(
            name,
            handler=lambda raw, selected=category: _render_trending_command(
                ctx, raw, selected
            ),
            description=description,
            args_hint="[страница]",
        )
    ctx.register_platform(
        name="telegram",
        label="Telegram",
        adapter_factory=_build_adapter,
        check_fn=check_telegram_requirements,
        is_connected=_is_connected,
        required_env=["TELEGRAM_BOT_TOKEN"],
        install_hint="pip install 'hermes-agent[telegram]'",
        setup_fn=interactive_setup,
        apply_yaml_config_fn=_apply_yaml_config,
        allowed_users_env="TELEGRAM_ALLOWED_USERS",
        allow_all_env="TELEGRAM_ALLOW_ALL_USERS",
        cron_deliver_env_var="TELEGRAM_HOME_CHANNEL",
        standalone_sender_fn=_standalone_send,
        max_message_length=4096,
        emoji="✈️",
        allow_update_command=True,
    )
