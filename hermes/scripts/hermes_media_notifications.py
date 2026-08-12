"""Deterministic Telegram rendering and state for media lifecycle webhooks."""

from __future__ import annotations

import json
import hashlib
import os
import re
import time
import unicodedata
import uuid
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import urlsplit


MAX_STATE_ITEMS = 1000
PROGRESS_THROTTLE_SECONDS = 5.0
_CARD_KEY_RE = re.compile(r"[A-Za-z0-9._:-]{1,96}\Z")
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
_SOURCE_CHOICE_FALLBACK_PHOTO = os.environ.get(
    "MEDIA_SOURCE_CHOICE_FALLBACK_PHOTO",
    "/usr/local/share/hermes-home/media-menu.jpg",
)
_PRESENTATION_CALLBACK_RE = re.compile(
    r"hm:(e|b|c|x):"
    r"([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\Z"
)
_ACTIONS = frozenset(
    {"cancel", "retry", "retry-missing", "resume-storage", "details", "search-alternative"}
)
_STATES = frozenset(
    {
        "queued",
        "downloading",
        "processing",
        "publishing",
        "completed",
        "partial",
        "failed",
        "cancelled",
        "needs-action",
    }
)
_TERMINAL_STATES = frozenset({"completed", "partial", "failed", "cancelled", "needs-action"})
_STAGES = frozenset({"download", "process", "publish"})
_NEXT_STEPS = frozenset({"download", "process", "publish", "none"})
_PROVIDERS = frozenset({"rezka", "prowlarr"})
_TOP_LEVEL_FIELDS = frozenset(
    {
        "event_type",
        "schema_version",
        "delivery_kind",
        "card_key",
        "revision",
        "lifecycle_cycle",
        "terminal",
        "state",
        "media",
        "progress",
        "stage",
        "next_step",
        "issue",
        "actions",
        "result",
    }
)
_MAX_U32 = 2**32 - 1
_MAX_U64 = 2**64 - 1
_MAX_SIGNED_64 = 2**63 - 1
_RESULT_ALLOWED_PUNCTUATION = frozenset(".,:!?\"'()[]{}+-_/@#%&")
_RESULT_FORBIDDEN_CHARACTERS = frozenset("$`\\\\<>|;")
_RESULT_URL_RE = re.compile(r"\b(?:https?|ftp)://|\bwww\.", re.IGNORECASE)
_RESULT_BARE_URL_RE = re.compile(
    r"(?<![\w-])(?:(?:[a-z0-9]|[^\W_])(?:[a-z0-9-]|[^\W_])*\.)+(?:[a-z]|[^\W\d_]){2,}(?:[/?#]\S*)?(?![\w-])",
    re.IGNORECASE,
)
_RESULT_ABSOLUTE_PATH_RE = re.compile(
    r"(?<!\w)(?:/(?:[^/\s]+/)*[^/\s]+|~(?:/|[A-Za-z0-9_.-]+/)|[A-Za-z]:[\\\\/]|\\\\\\\\)"
)
_RESULT_SHELL_COMMAND_RE = re.compile(
    r"(?<![\w-])(?:sudo\s+)?(?:bash|cat|chmod|chown|cmd|cp|curl|docker|echo|env|export|ffmpeg|git|kubectl|ls|mv|node|perl|python\d*|rm|sh|sleep|wget|yt-dlp|zsh)\b",
    re.IGNORECASE,
)
_RESULT_SECRET_RE = re.compile(
    r"\b(?:access[_-]?token|api[_-]?key|auth(?:entication|orization)?|bearer|cookie|password|passwd|secret|session[_-]?id)\b\s*(?:=|:)\s*\S+|\bbearer\s+[A-Za-z0-9._~-]{8,}|\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9._-]{8,}\b",
    re.IGNORECASE,
)
_RESULT_INTERNAL_CODE_RE = re.compile(r"\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b")


class DeliveryKind(str, Enum):
    CARD = "card"
    FINAL_PUSH = "final-push"


class UpdateDecision(str, Enum):
    SEND = "send"
    EDIT = "edit"
    IGNORE = "ignore"
    RETRY = "retry"


class CardView(str, Enum):
    COMPACT = "compact"
    DETAILS = "details"
    CONFIRM_CANCEL = "confirm-cancel"


class NotificationParseError(ValueError):
    """Raised when a schema-v2 media notification is not a valid wire payload."""


@dataclass(frozen=True)
class MediaIdentity:
    job_id: str
    title: str
    kind: str
    provider: str
    season: int | None = None
    translation: str | None = None
    origin: str | None = None
    poster_url: str | None = None


@dataclass(frozen=True)
class Episode:
    season: int
    episode: int


@dataclass(frozen=True)
class Progress:
    completed_episodes: int | None = None
    total_episodes: int | None = None
    current_episode: int | None = None
    missing_episodes: tuple[Episode, ...] = ()
    percentage: int | None = None
    downloaded_bytes: int | None = None
    total_bytes: int | None = None
    download_speed_bps: int | None = None
    eta_seconds: int | None = None
    seeds: int | None = None
    peers: int | None = None
    source_state: str | None = None
    connection_attempt: int | None = None
    connection_attempt_limit: int | None = None
    vpn_rotation_pending: bool | None = None
    storage_available_bytes: int | None = None
    storage_required_bytes: int | None = None


@dataclass(frozen=True)
class VideoResult:
    codec: str
    profile: str | None
    width: int
    height: int


@dataclass(frozen=True)
class AudioResult:
    language: str | None
    codec: str
    channels: int | None
    channel_layout: str | None
    title: str | None


@dataclass(frozen=True)
class SubtitleResult:
    downloaded: int
    missing: int


@dataclass(frozen=True)
class ProcessingResult:
    mode: str
    elapsed_seconds: int | None


@dataclass(frozen=True)
class PublicationResult:
    library: str
    title: str
    season: int | None
    episode: int | None


@dataclass(frozen=True)
class MediaResult:
    video: VideoResult | None
    audio: AudioResult | None
    subtitles: SubtitleResult | None
    file_size_bytes: int | None
    duration_seconds: int | None
    processing: ProcessingResult | None
    publication: PublicationResult | None


@dataclass(frozen=True)
class Issue:
    code: str
    message: str


@dataclass(frozen=True)
class MediaNotification:
    delivery_kind: DeliveryKind
    card_key: str
    revision: int
    lifecycle_cycle: int
    terminal: bool
    state: str
    media: MediaIdentity
    progress: Progress | None
    stage: str | None
    next_step: str | None
    issue: Issue | None
    actions: tuple[str, ...]
    result: MediaResult | None


@dataclass(frozen=True)
class SourceChoiceNotification:
    card_key: str
    tracking_id: str
    title: str
    season: int
    episode: int
    actions: tuple[str, ...]
    poster_url: str | None = None
    choice_set_id: str | None = None
    choice_set_expires_at: str | None = None
    rezka_count: int | None = None
    prowlarr_count: int | None = None


@dataclass(frozen=True)
class RenderedAction:
    label: str
    callback_data: str


@dataclass(frozen=True)
class RenderedCard:
    text: str
    button_rows: tuple[tuple[RenderedAction, ...], ...] = ()
    photo: str | None = None

    def __post_init__(self) -> None:
        text_limit = 1024 if self.photo is not None else 4096
        if len(self.text) > text_limit:
            raise ValueError("rendered card text is too long")
        if sum(len(row) for row in self.button_rows) > 100:
            raise ValueError("rendered card has too many buttons")

    @property
    def actions(self) -> tuple[RenderedAction, ...]:
        return tuple(action for row in self.button_rows for action in row)


@dataclass
class CardState:
    message_id: str | None
    revision: int
    lifecycle_cycle: int
    terminal: bool
    stage: str
    updated_at: float
    fingerprint: str = ""
    action_callbacks: tuple[str, ...] = ()
    view: CardView = CardView.COMPACT
    notification_payload: dict[str, Any] | None = None
    has_photo: bool = False

    @classmethod
    def from_value(cls, value: Any) -> "CardState | None":
        if not isinstance(value, Mapping):
            return None
        message_id = value.get("message_id")
        if message_id is not None and not str(message_id).isdigit():
            return None
        revision = _integer(value.get("revision"), minimum=0)
        lifecycle_cycle = _integer(value.get("lifecycle_cycle"), minimum=0)
        terminal = value.get("terminal")
        stage = value.get("stage")
        updated_at = value.get("updated_at")
        fingerprint = value.get("fingerprint", "")
        action_callbacks = value.get("action_callbacks", [])
        raw_view = value.get("view", CardView.COMPACT.value)
        raw_notification_payload = value.get("notification_payload")
        has_photo = value.get("has_photo", False)
        if (
            revision is None
            or lifecycle_cycle is None
            or not isinstance(terminal, bool)
            or not isinstance(stage, str)
            or not isinstance(updated_at, (int, float))
            or isinstance(updated_at, bool)
            or not isinstance(fingerprint, str)
            or (fingerprint and re.fullmatch(r"[0-9a-f]{64}", fingerprint) is None)
            or not isinstance(action_callbacks, list)
            or any(not isinstance(callback, str) for callback in action_callbacks)
            or not isinstance(has_photo, bool)
        ):
            return None
        try:
            view = CardView(raw_view)
        except (TypeError, ValueError):
            view = CardView.COMPACT
        notification_payload = None
        if isinstance(raw_notification_payload, Mapping):
            try:
                parse_notification(raw_notification_payload)
                notification_payload = json.loads(
                    json.dumps(raw_notification_payload, separators=(",", ":"))
                )
            except (TypeError, ValueError, json.JSONDecodeError):
                notification_payload = None
        return cls(
            str(message_id) if message_id is not None else None,
            revision,
            lifecycle_cycle,
            terminal,
            stage,
            float(updated_at),
            fingerprint,
            tuple(action_callbacks),
            view,
            notification_payload,
            has_photo,
        )

    def to_value(self) -> dict[str, Any]:
        return {
            "message_id": self.message_id,
            "revision": self.revision,
            "lifecycle_cycle": self.lifecycle_cycle,
            "terminal": self.terminal,
            "stage": self.stage,
            "updated_at": self.updated_at,
            "fingerprint": self.fingerprint,
            "action_callbacks": list(self.action_callbacks),
            "view": self.view.value,
            "notification_payload": self.notification_payload,
            "has_photo": self.has_photo,
        }


@dataclass
class NotificationState:
    cards: dict[str, CardState] = field(default_factory=dict)
    push_receipts: list[str] = field(default_factory=list)
    control_receipts: list[str] = field(default_factory=list)
    pending_card_deliveries: dict[str, dict[str, Any]] = field(default_factory=dict)


def _integer(value: Any, *, minimum: int = 0, maximum: int | None = None) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        return None
    if maximum is not None and value > maximum:
        return None
    return value


def _required_text(value: Any, name: str, *, maximum: int = 256) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{name} must be a string")
    if not value.strip() or len(value.encode("utf-8")) > maximum or not value.isprintable():
        raise ValueError(f"{name} is invalid")
    return value


def _required_result_text(value: Any, name: str) -> str:
    text = _required_text(value, name)
    if text != text.strip() or any(character in _RESULT_FORBIDDEN_CHARACTERS for character in text):
        raise ValueError(f"{name} is invalid")
    if any(
        character != " "
        and character not in _RESULT_ALLOWED_PUNCTUATION
        and unicodedata.category(character)[0] not in {"L", "M", "N"}
        for character in text
    ):
        raise ValueError(f"{name} contains unsupported characters")
    if _RESULT_URL_RE.search(text) or _RESULT_BARE_URL_RE.search(text):
        raise ValueError(f"{name} cannot contain a URL")
    if _RESULT_ABSOLUTE_PATH_RE.search(text):
        raise ValueError(f"{name} cannot contain a path")
    if _RESULT_SHELL_COMMAND_RE.search(text):
        raise ValueError(f"{name} cannot contain a command")
    if _RESULT_SECRET_RE.search(text):
        raise ValueError(f"{name} cannot contain a secret")
    if _RESULT_INTERNAL_CODE_RE.search(text):
        raise ValueError(f"{name} cannot contain an internal code")
    return text


def _optional_integer(
    mapping: Mapping[str, Any], key: str, *, minimum: int = 0, maximum: int
) -> int | None:
    value = mapping.get(key)
    if value is None:
        return None
    result = _integer(value, minimum=minimum, maximum=maximum)
    if result is None:
        raise ValueError(f"{key} is invalid")
    return result


def _validate_fields(
    value: Mapping[str, Any],
    *,
    name: str,
    allowed: frozenset[str],
    required: frozenset[str] = frozenset(),
) -> None:
    unknown = set(value).difference(allowed)
    if unknown:
        raise ValueError(f"{name} has unknown fields")
    missing = required.difference(value)
    if missing:
        raise ValueError(f"{name} is missing required fields")


def _parse_progress(raw_progress: Any) -> Progress:
    if not isinstance(raw_progress, Mapping):
        raise ValueError("progress must be an object")
    _validate_fields(
        raw_progress,
        name="progress",
        allowed=frozenset(
            {
                "completed_episodes",
                "total_episodes",
                "current_episode",
                "missing_episodes",
                "downloaded_bytes",
                "total_bytes",
                "download_speed_bps",
                "percentage",
                "eta_seconds",
                "seeds",
                "peers",
                "source_state",
                "connection_attempt",
                "connection_attempt_limit",
                "vpn_rotation_pending",
                "storage_available_bytes",
                "storage_required_bytes",
            }
        ),
    )
    missing = raw_progress.get("missing_episodes", [])
    if not isinstance(missing, list):
        raise ValueError("missing_episodes is invalid")
    missing_episodes = []
    for item in missing:
        if not isinstance(item, Mapping):
            raise ValueError("missing_episodes is invalid")
        _validate_fields(
            item,
            name="missing_episodes item",
            allowed=frozenset({"season", "episode"}),
            required=frozenset({"season", "episode"}),
        )
        episode_season = _integer(item.get("season"), maximum=_MAX_U32)
        episode_number = _integer(item.get("episode"), minimum=1, maximum=_MAX_U32)
        if episode_season is None or episode_number is None:
            raise ValueError("missing_episodes is invalid")
        missing_episodes.append(Episode(episode_season, episode_number))
    progress = Progress(
        completed_episodes=_optional_integer(
            raw_progress, "completed_episodes", maximum=_MAX_U32
        ),
        total_episodes=_optional_integer(raw_progress, "total_episodes", maximum=_MAX_U32),
        current_episode=_optional_integer(raw_progress, "current_episode", maximum=_MAX_U32),
        missing_episodes=tuple(missing_episodes),
        percentage=_optional_integer(raw_progress, "percentage", maximum=100),
        downloaded_bytes=_optional_integer(raw_progress, "downloaded_bytes", maximum=_MAX_U64),
        total_bytes=_optional_integer(raw_progress, "total_bytes", maximum=_MAX_U64),
        download_speed_bps=_optional_integer(raw_progress, "download_speed_bps", maximum=_MAX_U64),
        eta_seconds=_optional_integer(raw_progress, "eta_seconds", maximum=_MAX_U64),
        seeds=_optional_integer(raw_progress, "seeds", maximum=_MAX_U64),
        peers=_optional_integer(raw_progress, "peers", maximum=_MAX_U64),
        source_state=(
            _required_text(raw_progress["source_state"], "source_state", maximum=64)
            if raw_progress.get("source_state") is not None
            else None
        ),
        connection_attempt=_optional_integer(
            raw_progress, "connection_attempt", minimum=1, maximum=_MAX_U32
        ),
        connection_attempt_limit=_optional_integer(
            raw_progress, "connection_attempt_limit", minimum=1, maximum=_MAX_U32
        ),
        vpn_rotation_pending=raw_progress.get("vpn_rotation_pending"),
        storage_available_bytes=_optional_integer(
            raw_progress, "storage_available_bytes", maximum=_MAX_U64
        ),
        storage_required_bytes=_optional_integer(
            raw_progress, "storage_required_bytes", maximum=_MAX_U64
        ),
    )
    if (
        progress.total_episodes == 0
        or (
            progress.completed_episodes is not None
            and (
                progress.total_episodes is None
                or progress.completed_episodes > progress.total_episodes
            )
        )
        or (
            progress.current_episode is not None
            and progress.current_episode == 0
        )
        or (
            progress.connection_attempt is not None
            and progress.connection_attempt_limit is not None
            and progress.connection_attempt > progress.connection_attempt_limit
        )
        or (progress.storage_available_bytes is None) != (progress.storage_required_bytes is None)
        or (
            progress.vpn_rotation_pending is not None
            and not isinstance(progress.vpn_rotation_pending, bool)
        )
        or (
            progress.downloaded_bytes is not None
            and progress.total_bytes is not None
            and progress.downloaded_bytes > progress.total_bytes
        )
        or (
            progress.source_state is not None
            and re.fullmatch(r"[A-Za-z0-9_-]+", progress.source_state) is None
        )
    ):
        raise ValueError("invalid episode progress")
    return progress


def _parse_result(raw_result: Any) -> MediaResult:
    if not isinstance(raw_result, Mapping):
        raise ValueError("result must be an object")
    _validate_fields(
        raw_result,
        name="result",
        allowed=frozenset(
            {
                "video",
                "audio",
                "subtitles",
                "file_size_bytes",
                "duration_seconds",
                "processing",
                "publication",
            }
        ),
    )

    raw_video = raw_result.get("video")
    video = None
    if raw_video is not None:
        if not isinstance(raw_video, Mapping):
            raise ValueError("result.video must be an object")
        _validate_fields(
            raw_video,
            name="result.video",
            allowed=frozenset({"codec", "profile", "width", "height"}),
            required=frozenset({"codec", "width", "height"}),
        )
        width = _integer(raw_video.get("width"), minimum=1, maximum=_MAX_U32)
        height = _integer(raw_video.get("height"), minimum=1, maximum=_MAX_U32)
        if width is None or height is None:
            raise ValueError("result.video dimensions are invalid")
        profile = raw_video.get("profile")
        video = VideoResult(
            _required_result_text(raw_video.get("codec"), "result.video.codec"),
            _required_result_text(profile, "result.video.profile") if profile is not None else None,
            width,
            height,
        )

    raw_audio = raw_result.get("audio")
    audio = None
    if raw_audio is not None:
        if not isinstance(raw_audio, Mapping):
            raise ValueError("result.audio must be an object")
        _validate_fields(
            raw_audio,
            name="result.audio",
            allowed=frozenset({"language", "codec", "channels", "channel_layout", "title"}),
            required=frozenset({"codec"}),
        )
        language = raw_audio.get("language")
        channel_layout = raw_audio.get("channel_layout")
        title = raw_audio.get("title")
        audio = AudioResult(
            _required_result_text(language, "result.audio.language") if language is not None else None,
            _required_result_text(raw_audio.get("codec"), "result.audio.codec"),
            _optional_integer(raw_audio, "channels", maximum=_MAX_U32),
            _required_result_text(channel_layout, "result.audio.channel_layout")
            if channel_layout is not None
            else None,
            _required_result_text(title, "result.audio.title") if title is not None else None,
        )

    raw_subtitles = raw_result.get("subtitles")
    subtitles = None
    if raw_subtitles is not None:
        if not isinstance(raw_subtitles, Mapping):
            raise ValueError("result.subtitles must be an object")
        _validate_fields(
            raw_subtitles,
            name="result.subtitles",
            allowed=frozenset({"downloaded", "missing"}),
            required=frozenset({"downloaded", "missing"}),
        )
        downloaded = _integer(raw_subtitles.get("downloaded"), maximum=_MAX_U32)
        missing = _integer(raw_subtitles.get("missing"), maximum=_MAX_U32)
        if downloaded is None or missing is None:
            raise ValueError("result.subtitles is invalid")
        subtitles = SubtitleResult(downloaded, missing)

    raw_processing = raw_result.get("processing")
    processing = None
    if raw_processing is not None:
        if not isinstance(raw_processing, Mapping):
            raise ValueError("result.processing must be an object")
        _validate_fields(
            raw_processing,
            name="result.processing",
            allowed=frozenset({"mode", "elapsed_seconds"}),
            required=frozenset({"mode"}),
        )
        mode = raw_processing.get("mode")
        if mode not in {"vaapi-upscale", "original"}:
            raise ValueError("result.processing.mode is invalid")
        processing = ProcessingResult(
            mode,
            _optional_integer(raw_processing, "elapsed_seconds", maximum=_MAX_U64),
        )

    raw_publication = raw_result.get("publication")
    publication = None
    if raw_publication is not None:
        if not isinstance(raw_publication, Mapping):
            raise ValueError("result.publication must be an object")
        _validate_fields(
            raw_publication,
            name="result.publication",
            allowed=frozenset({"library", "title", "season", "episode"}),
            required=frozenset({"library", "title"}),
        )
        library = raw_publication.get("library")
        if library not in {"movies", "tv-shows"}:
            raise ValueError("result.publication.library is invalid")
        publication = PublicationResult(
            library,
            _required_result_text(raw_publication.get("title"), "result.publication.title"),
            _optional_integer(raw_publication, "season", maximum=_MAX_U32),
            _optional_integer(raw_publication, "episode", minimum=1, maximum=_MAX_U32),
        )

    return MediaResult(
        video,
        audio,
        subtitles,
        _optional_integer(raw_result, "file_size_bytes", maximum=_MAX_U64),
        _optional_integer(raw_result, "duration_seconds", maximum=_MAX_U64),
        processing,
        publication,
    )


def _parse_notification(payload: Mapping[str, Any]) -> MediaNotification:
    """Validate the schema-v2 media webhook before it reaches Telegram."""
    if not isinstance(payload, Mapping):
        raise ValueError("payload must be an object")
    _validate_fields(
        payload,
        name="payload",
        allowed=_TOP_LEVEL_FIELDS,
        required=frozenset(
            {
                "event_type",
                "schema_version",
                "delivery_kind",
                "card_key",
                "revision",
                "lifecycle_cycle",
                "terminal",
                "state",
                "media",
            }
        ),
    )
    if payload.get("event_type") != "media.notification":
        raise ValueError("unexpected event type")
    if payload.get("schema_version") != 2:
        raise ValueError("unsupported schema version")

    try:
        delivery_kind = DeliveryKind(payload.get("delivery_kind"))
    except ValueError as error:
        raise ValueError("invalid delivery kind") from error
    card_key = _required_text(payload.get("card_key"), "card_key", maximum=96)
    if _CARD_KEY_RE.fullmatch(card_key) is None:
        raise ValueError("invalid card key")
    revision = _integer(payload.get("revision"), minimum=1, maximum=_MAX_SIGNED_64)
    lifecycle_cycle = _integer(payload.get("lifecycle_cycle"), minimum=1, maximum=_MAX_SIGNED_64)
    terminal = payload.get("terminal")
    state = payload.get("state")
    if revision is None or lifecycle_cycle is None or not isinstance(terminal, bool):
        raise ValueError("invalid lifecycle values")
    if state not in _STATES:
        raise ValueError("invalid state")
    if terminal != (state in _TERMINAL_STATES):
        raise ValueError("terminal state mismatch")
    if delivery_kind == DeliveryKind.FINAL_PUSH and not terminal:
        raise ValueError("final push must be terminal")

    raw_media = payload.get("media")
    if not isinstance(raw_media, Mapping):
        raise ValueError("media must be an object")
    _validate_fields(
        raw_media,
        name="media",
        allowed=frozenset(
            {
                "job_id",
                "title",
                "kind",
                "provider",
                "season",
                "translation",
                "origin",
                "poster_url",
            }
        ),
        required=frozenset({"job_id", "title", "kind", "provider"}),
    )
    job_id = _required_text(raw_media.get("job_id"), "media.job_id", maximum=36)
    try:
        if str(uuid.UUID(job_id)) != job_id:
            raise ValueError("media.job_id must be canonical")
    except (ValueError, AttributeError) as error:
        raise ValueError("media.job_id must be a UUID") from error
    kind = raw_media.get("kind")
    provider = raw_media.get("provider")
    if kind not in {"movie", "series"}:
        raise ValueError("unsupported media identity")
    if provider not in _PROVIDERS:
        raise ValueError("unsupported media provider")
    season = _optional_integer(raw_media, "season", maximum=_MAX_U32)
    translation = raw_media.get("translation")
    origin = raw_media.get("origin")
    if origin is not None and origin != "tracked-episode":
        raise ValueError("unsupported media origin")
    media = MediaIdentity(
        job_id=job_id,
        title=_required_result_text(raw_media.get("title"), "media.title"),
        kind=kind,
        provider=_required_text(provider, "media.provider"),
        season=season,
        translation=_required_result_text(translation, "media.translation") if translation is not None else None,
        origin=origin,
        poster_url=_optional_https_url(raw_media.get("poster_url"), "media.poster_url"),
    )

    progress = _parse_progress(payload["progress"]) if "progress" in payload else None
    result = _parse_result(payload["result"]) if "result" in payload else None
    if result is not None and result.processing is not None:
        if (
            result.processing.mode == "vaapi-upscale" and media.provider != "rezka"
        ) or (result.processing.mode == "original" and media.provider != "prowlarr"):
            raise ValueError("processing mode does not match the media provider")

    stage = payload.get("stage")
    if stage is not None and stage not in _STAGES:
        raise ValueError("invalid stage")
    next_step = payload.get("next_step")
    if next_step is not None and next_step not in _NEXT_STEPS:
        raise ValueError("invalid next step")
    raw_issue = payload.get("issue")
    if raw_issue is not None and not isinstance(raw_issue, Mapping):
        raise ValueError("issue must be an object")
    issue = None
    if raw_issue is not None:
        _validate_fields(
            raw_issue,
            name="issue",
            allowed=frozenset({"code", "message"}),
            required=frozenset({"code", "message"}),
        )
        issue = Issue(
            code=_required_text(raw_issue.get("code"), "issue.code"),
            message=_required_text(raw_issue.get("message"), "issue.message"),
        )
    if "actions" not in payload:
        actions = ()
    else:
        raw_actions = payload["actions"]
        if not isinstance(raw_actions, list):
            raise ValueError("invalid actions")
        actions = tuple(raw_actions)
        if any(not isinstance(action, str) or action not in _ACTIONS for action in actions):
            raise ValueError("invalid actions")
    return MediaNotification(
        delivery_kind=delivery_kind,
        card_key=card_key,
        revision=revision,
        lifecycle_cycle=lifecycle_cycle,
        terminal=terminal,
        state=state,
        media=media,
        progress=progress,
        stage=stage,
        next_step=next_step,
        issue=issue,
        actions=actions,
        result=result,
    )


def parse_notification(payload: Mapping[str, Any]) -> MediaNotification:
    """Validate the schema-v2 media webhook before it reaches Telegram."""
    try:
        return _parse_notification(payload)
    except NotificationParseError:
        raise
    except ValueError as error:
        raise NotificationParseError(str(error)) from error


def parse_source_choice(payload: Mapping[str, Any]) -> SourceChoiceNotification:
    """Validate a schema-v1 tracking source-choice webhook."""
    if not isinstance(payload, Mapping):
        raise NotificationParseError("payload must be an object")
    expected_fields = frozenset(
        {
            "event_type",
            "schema_version",
            "card_key",
            "tracking_id",
            "title",
            "season",
            "episode",
            "actions",
            "poster_url",
            "choice_set_id",
            "choice_set_expires_at",
            "rezka_count",
            "prowlarr_count",
        }
    )
    _validate_fields(
        payload,
        name="payload",
        allowed=expected_fields,
        required=expected_fields
        - {
            "poster_url",
            "choice_set_id",
            "choice_set_expires_at",
            "rezka_count",
            "prowlarr_count",
        },
    )
    if payload.get("event_type") != "media.source-choice":
        raise NotificationParseError("unexpected event type")
    if payload.get("schema_version") != 1:
        raise NotificationParseError("unsupported schema version")
    card_key = _required_text(payload.get("card_key"), "card_key", maximum=96)
    if _CARD_KEY_RE.fullmatch(card_key) is None:
        raise NotificationParseError("invalid card key")
    tracking_id = _required_text(payload.get("tracking_id"), "tracking_id", maximum=36)
    try:
        if str(uuid.UUID(tracking_id)) != tracking_id:
            raise ValueError("tracking ID must be canonical")
    except (ValueError, AttributeError) as error:
        raise NotificationParseError("tracking ID must be a UUID") from error
    season = _integer(payload.get("season"), minimum=0, maximum=_MAX_U32)
    episode = _integer(payload.get("episode"), minimum=1, maximum=_MAX_U32)
    if season is None or episode is None:
        raise NotificationParseError("invalid episode coordinates")
    actions = payload.get("actions")
    if actions not in (
        ["rezka"],
        ["prowlarr"],
        ["all", "rezka", "prowlarr"],
    ):
        raise NotificationParseError("invalid source choice actions")
    choice_set_keys = (
        "choice_set_id",
        "choice_set_expires_at",
        "rezka_count",
        "prowlarr_count",
    )
    choice_set_present = [key in payload for key in choice_set_keys]
    if any(choice_set_present) and not all(choice_set_present):
        raise NotificationParseError("choice-set metadata must be complete")
    choice_set_id = payload.get("choice_set_id")
    if choice_set_id is not None:
        choice_set_id = _required_text(choice_set_id, "choice_set_id", maximum=36)
        try:
            if str(uuid.UUID(choice_set_id)) != choice_set_id:
                raise ValueError("choice set ID must be canonical")
        except (ValueError, AttributeError) as error:
            raise NotificationParseError("choice_set_id must be a UUID") from error
    choice_set_expires_at = payload.get("choice_set_expires_at")
    if choice_set_expires_at is not None:
        choice_set_expires_at = _required_text(
            choice_set_expires_at, "choice_set_expires_at", maximum=64
        )
    rezka_count = payload.get("rezka_count")
    if rezka_count is not None:
        rezka_count = _integer(rezka_count, minimum=0, maximum=1000)
        if rezka_count is None:
            raise NotificationParseError("invalid rezka_count")
    prowlarr_count = payload.get("prowlarr_count")
    if prowlarr_count is not None:
        prowlarr_count = _integer(prowlarr_count, minimum=0, maximum=1000)
        if prowlarr_count is None:
            raise NotificationParseError("invalid prowlarr_count")
    return SourceChoiceNotification(
        card_key=card_key,
        tracking_id=tracking_id,
        title=_required_result_text(payload.get("title"), "title"),
        season=season,
        episode=episode,
        actions=tuple(actions),
        poster_url=_optional_https_url(payload.get("poster_url"), "poster_url"),
        choice_set_id=choice_set_id,
        choice_set_expires_at=choice_set_expires_at,
        rezka_count=rezka_count,
        prowlarr_count=prowlarr_count,
    )


def _optional_https_url(value: object, name: str) -> str | None:
    if value is None:
        return None
    url = _required_text(value, name, maximum=2048)
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
        raise NotificationParseError(f"invalid {name}")
    return url


def _format_bytes(value: int) -> str:
    units = (("Б", 1), ("КБ", 1024), ("МБ", 1024**2), ("ГБ", 1024**3))
    unit, divisor = units[0]
    for candidate, candidate_divisor in units:
        if value >= candidate_divisor:
            unit, divisor = candidate, candidate_divisor
    amount = value / divisor
    text = str(int(amount)) if amount.is_integer() else f"{amount:.1f}".replace(".", ",")
    return f"{text} {unit}"


def media_identity(notification: MediaNotification) -> str:
    progress = notification.progress
    if (
        notification.media.kind == "series"
        and progress is not None
        and progress.current_episode is not None
        and progress.total_episodes == 1
    ):
        season = notification.media.season or 0
        return f"{notification.media.title} · S{season:02}E{progress.current_episode:02}"
    if notification.media.kind == "series" and notification.media.season == 0:
        return f"{notification.media.title} · Спецвыпуски"
    if notification.media.kind == "series" and notification.media.season is not None:
        return f"{notification.media.title} · Сезон {notification.media.season}"
    return notification.media.title


def _title(notification: MediaNotification) -> str:
    if notification.media.origin == "tracked-episode" and notification.state in {"queued", "downloading"}:
        return f"🆕 Найдена новая серия · {media_identity(notification)}"
    return f"⬇️ {media_identity(notification)}"


def _stage_copy(stage: str | None, state: str) -> str:
    if state in _TERMINAL_STATES:
        return {
            "completed": "✅ Готово",
            "partial": "⚠️ Готово не полностью",
            "failed": "❌ Не удалось завершить загрузку",
            "cancelled": "⏹️ Загрузка отменена",
            "needs-action": "⛔ Требуется действие",
        }[state]
    return {
        "download": "🔄 Скачиваю исходное видео",
        "process": "⚙️ Обрабатываю видео",
        "publish": "📺 Добавляю в Plex",
    }.get(stage or "", {"queued": "⏳ Подготавливаю загрузку", "needs-action": "⛔ Требуется действие"}.get(state, "🔄 Обновляю статус"))


def _next_step_copy(next_step: str) -> str:
    return {
        "download": "скачивание исходного видео",
        "process": "обработка и добавление в Plex",
        "publish": "проверка доступности в Plex",
    }[next_step]


def _issue_copy(issue: Issue | None) -> str | None:
    if issue is None:
        return None
    return {
        "storage_blocked": "⛔ Недостаточно свободного места для продолжения",
        "needs_action": "⛔ Нужен ваш выбор, чтобы продолжить",
        "media_failed": "⚠️ Не удалось скачать или обработать видео",
        "subtitles_missing": "⚠️ Некоторые субтитры недоступны",
        "source_recovering": "🔄 Восстанавливаю соединение с источником",
        "plex_pending": "📺 Публикация в Plex ожидает повторной попытки",
    }.get(issue.code, "⚠️ Загрузка требует внимания")


def _progress_lines(notification: MediaNotification) -> list[str]:
    progress = notification.progress
    lines: list[str] = []
    if progress is None:
        lines.append("🎙 Rezka" if notification.media.provider == "rezka" else "🧲 Prowlarr")
        return lines
    if progress.completed_episodes is not None and progress.total_episodes is not None:
        prefix = "В Plex" if notification.terminal else "Готово"
        lines.append(f"📺 {prefix}: {progress.completed_episodes} из {progress.total_episodes} серий")
    if progress.missing_episodes:
        label = "серия" if len(progress.missing_episodes) == 1 else "серии"
        numbers = ", ".join(
            f"{item.episode} (S{item.season:02}E{item.episode:02})"
            if notification.media.season == item.season
            else (
                f"Спецвыпуск {item.episode}"
                if item.season == 0
                else f"Сезон {item.season}, серия {item.episode}"
            )
            for item in progress.missing_episodes
        )
        lines.append(f"⚠️ Не добавлена {label}: {numbers}")
    if notification.media.provider == "rezka":
        if notification.media.translation:
            lines.append(f"🎙 {notification.media.translation} · Rezka")
        else:
            lines.append("🎙 Rezka")
        transfer: list[str] = []
        if progress.downloaded_bytes is not None:
            downloaded = _format_bytes(progress.downloaded_bytes)
            if progress.total_bytes is not None:
                downloaded = f"{downloaded} из {_format_bytes(progress.total_bytes)}"
            transfer.append(downloaded)
        if progress.download_speed_bps is not None:
            transfer.append(f"{_format_bytes(progress.download_speed_bps)}/с")
        if transfer:
            prefix = f"Серия {progress.current_episode}: " if progress.current_episode is not None else ""
            lines.append(f"📦 {prefix}{' · '.join(transfer)}")
        return lines

    lines.append("🧲 Prowlarr")
    transfer = []
    if progress.percentage is not None:
        transfer.append(f"{progress.percentage}%")
    if progress.downloaded_bytes is not None:
        downloaded = _format_bytes(progress.downloaded_bytes)
        if progress.total_bytes is not None:
            downloaded = f"{downloaded} из {_format_bytes(progress.total_bytes)}"
        transfer.append(downloaded)
    if progress.download_speed_bps is not None:
        transfer.append(f"{_format_bytes(progress.download_speed_bps)}/с")
    if transfer:
        if progress.percentage is not None and len(transfer) > 1:
            lines.append(f"📦 {transfer[0]}: {' · '.join(transfer[1:])}")
        else:
            lines.append(f"📦 {' · '.join(transfer)}")
    return lines


def _transfer_detail_lines(notification: MediaNotification) -> list[str]:
    progress = notification.progress
    if progress is None:
        return []
    lines: list[str] = []
    if progress.eta_seconds is not None:
        lines.append(f"⏱ Осталось примерно: {_format_duration(progress.eta_seconds)}")
    if progress.seeds is not None or progress.peers is not None:
        connections = []
        if progress.seeds is not None:
            connections.append(f"источников: {progress.seeds}")
        if progress.peers is not None:
            connections.append(f"подключений: {progress.peers}")
        lines.append(f"🌐 {' · '.join(connections)}")
    if progress.source_state is not None:
        state = {
            "downloading": "скачивается",
            "stalleddl": "ожидает источники",
            "metadl": "получает сведения о раздаче",
            "queuedl": "ожидает в очереди",
            "checkingdl": "проверяет загруженные данные",
            "pauseddl": "приостановлена",
            "uploading": "раздаётся",
            "stalledup": "раздача ожидает подключений",
        }.get(progress.source_state.lower(), progress.source_state)
        lines.append(f"🧲 Состояние источника: {state}")
    return lines


def _format_duration(value: int) -> str:
    hours, remainder = divmod(value, 3600)
    minutes, seconds = divmod(remainder, 60)
    parts: list[str] = []
    if hours:
        parts.append(f"{hours} ч")
    if minutes:
        parts.append(f"{minutes} мин")
    if seconds or not parts:
        parts.append(f"{seconds} сек")
    return " ".join(parts)


def _display_value(value: str, mapping: Mapping[str, str]) -> str:
    return mapping.get(value.casefold(), value)


def _result_lines(notification: MediaNotification) -> list[str]:
    result = notification.result
    if result is None:
        return []
    lines: list[str] = []
    if result.video is not None:
        video = result.video
        fields = [f"{video.width}x{video.height}", _display_value(video.codec, {"hevc": "HEVC"})]
        if video.profile is not None:
            fields[-1] = f"{fields[-1]} {video.profile}"
        lines.append(f"🎞 Видео: {' · '.join(fields)}")
    if result.audio is not None:
        audio = result.audio
        fields: list[str] = []
        if audio.language is not None:
            fields.append(_display_value(audio.language, {"rus": "русский"}))
        codec = _display_value(audio.codec, {"aac": "AAC"})
        if audio.channel_layout is not None:
            codec = f"{codec} {_display_value(audio.channel_layout, {'stereo': 'Stereo'})}"
        elif audio.channels is not None:
            codec = f"{codec} · {audio.channels} каналов"
        fields.append(codec)
        if audio.title is not None:
            fields.append(audio.title)
        lines.append(f"🔊 Аудио: {' · '.join(fields)}")
    if result.subtitles is not None:
        subtitles = result.subtitles
        line = f"💬 Субтитры: {subtitles.downloaded} дорожки"
        if subtitles.missing:
            line += f" · недоступно: {subtitles.missing}"
        lines.append(line)
    if result.file_size_bytes is not None:
        lines.append(f"💾 Размер: {_format_bytes(result.file_size_bytes)}")
    if result.duration_seconds is not None:
        lines.append(f"⏱ Длительность: {_format_duration(result.duration_seconds)}")
    if result.processing is not None:
        processing = result.processing
        if processing.mode == "original":
            line = "⚙️ Обработка: Без перекодирования"
        else:
            line = "⚙️ Обработка: VAAPI upscale"
        if processing.elapsed_seconds is not None:
            line += f" · {_format_duration(processing.elapsed_seconds)}"
        lines.append(line)
    if result.publication is not None:
        publication = result.publication
        library = {"movies": "Фильмы", "tv-shows": "Сериалы"}[publication.library]
        fields = ["Plex", library, publication.title]
        if publication.season is not None:
            fields.append(f"Сезон {publication.season}")
        if publication.episode is not None:
            fields.append(f"Серия {publication.episode}")
        lines.append("📺 " + " → ".join(fields))
    return lines


def _recovery_lines(notification: MediaNotification) -> list[str]:
    progress = notification.progress
    if progress is None:
        return []
    lines: list[str] = []
    if (
        notification.issue is not None
        and notification.issue.code == "source_recovering"
        and progress.connection_attempt is not None
        and progress.connection_attempt_limit is not None
    ):
        lines.append(
            f"🔌 Попытка соединения: {progress.connection_attempt} из {progress.connection_attempt_limit}"
        )
    if progress.vpn_rotation_pending is True:
        lines.append("🛡 Ожидается смена VPN-маршрута")
    if progress.storage_required_bytes is not None and progress.storage_available_bytes is not None:
        lines.append(
            f"💾 Требуется: {_format_bytes(progress.storage_required_bytes)} · "
            f"Доступно: {_format_bytes(progress.storage_available_bytes)}"
        )
    return lines


def callback_data(
    action: str,
    job_id: str,
    *,
    lifecycle_cycle: int | None = None,
    revision: int | None = None,
) -> str:
    if action not in _ACTIONS:
        raise ValueError("unsupported media action")
    try:
        if str(uuid.UUID(job_id)) != job_id:
            raise ValueError("job id must be canonical")
    except (ValueError, AttributeError) as error:
        raise ValueError("job id must be a UUID") from error
    value = f"ma:{action}:{job_id}"
    if (
        action in {"cancel", "retry", "retry-missing", "resume-storage"}
        and isinstance(lifecycle_cycle, int)
        and not isinstance(lifecycle_cycle, bool)
        and lifecycle_cycle >= 1
    ):
        generation = hashlib.blake2s(
            str(lifecycle_cycle).encode("ascii"), digest_size=4
        ).hexdigest()
        value = f"{value}:{generation}"
    if len(value.encode("utf-8")) > 64:
        raise ValueError("callback data is too long")
    return value


def presentation_callback_data(command: str, job_id: str) -> str:
    command_code = {
        "expand": "e",
        "collapse": "b",
        "confirm-cancel": "c",
        "dismiss-cancel": "x",
    }.get(command)
    if command_code is None:
        raise ValueError("unsupported presentation command")
    try:
        if str(uuid.UUID(job_id)) != job_id:
            raise ValueError("job id must be canonical")
    except (ValueError, AttributeError) as error:
        raise ValueError("job id must be a UUID") from error
    value = f"hm:{command_code}:{job_id}"
    if len(value.encode("utf-8")) >= 64:
        raise ValueError("callback data is too long")
    return value


def parse_presentation_callback_data(value: object) -> tuple[str, str] | None:
    if not isinstance(value, str) or len(value.encode("utf-8")) >= 64:
        return None
    match = _PRESENTATION_CALLBACK_RE.fullmatch(value)
    if match is None:
        return None
    command_code, job_id = match.groups()
    return (
        {
            "e": "expand",
            "b": "collapse",
            "c": "confirm-cancel",
            "x": "dismiss-cancel",
        }[command_code],
        job_id,
    )


def source_choice_callback_data(
    action: str, tracking_id: str, season: int, episode: int
) -> str:
    action_code = {"all": "a", "rezka": "r", "prowlarr": "p"}.get(action)
    if action_code is None:
        raise ValueError("unsupported source choice action")
    try:
        if str(uuid.UUID(tracking_id)) != tracking_id:
            raise ValueError("tracking id must be canonical")
    except (ValueError, AttributeError) as error:
        raise ValueError("tracking id must be a UUID") from error
    if not isinstance(season, int) or isinstance(season, bool) or not 0 <= season <= _MAX_U32:
        raise ValueError("season is invalid")
    if not isinstance(episode, int) or isinstance(episode, bool) or not 1 <= episode <= _MAX_U32:
        raise ValueError("episode is invalid")
    value = f"ms:{action_code}:{tracking_id}:{season}:{episode}"
    if len(value.encode("utf-8")) >= 64:
        raise ValueError("callback data is too long")
    return value


def parse_source_choice_callback_data(
    value: object,
) -> tuple[str, str, int, int] | None:
    if not isinstance(value, str) or len(value.encode("utf-8")) >= 64:
        return None
    match = _SOURCE_CHOICE_CALLBACK_RE.fullmatch(value)
    if match is None:
        return None
    action_code, tracking_id, season, episode = match.groups()
    return (
        {"a": "all", "r": "rezka", "p": "prowlarr"}[action_code],
        tracking_id,
        int(season),
        int(episode),
    )


def render_source_choice(notification: SourceChoiceNotification) -> RenderedCard:
    actions = tuple(
        RenderedAction(
            "🌐 Rezka" if source == "rezka" else "🧲 Prowlarr",
            source_choice_callback_data(
                source,
                notification.tracking_id,
                notification.season,
                notification.episode,
            ),
        )
        for source in ("rezka", "prowlarr")
        if source in notification.actions
    )
    availability = []
    if "rezka" in notification.actions:
        availability.append(
            "✅ Rezka · "
            + (
                f"{notification.rezka_count} вариантов"
                if notification.rezka_count is not None
                else "серия и озвучки"
            )
        )
    if "prowlarr" in notification.actions:
        availability.append(
            "✅ Prowlarr · "
            + (
                f"{notification.prowlarr_count} раздач"
                if notification.prowlarr_count is not None
                else "раздачи"
            )
        )
    return RenderedCard(
        "\n".join(
            [
                f"🎬 {notification.title}",
                f"🆕 S{notification.season:02d}E{notification.episode:02d}",
                "",
                *availability,
            ]
        ),
        (actions,),
        notification.poster_url or _SOURCE_CHOICE_FALLBACK_PHOTO,
    )


def parse_callback_data(value: object) -> tuple[str, str] | None:
    if not isinstance(value, str) or len(value.encode("utf-8")) > 64:
        return None
    match = _CALLBACK_RE.fullmatch(value)
    return (match.group(1), match.group(2)) if match else None


def _compact_lines(notification: MediaNotification) -> list[str]:
    lines = [
        _title(notification),
        *_progress_lines(notification),
        _stage_copy(notification.stage, notification.state),
    ]
    if notification.media.origin == "tracked-episode" and notification.state in {"queued", "downloading"}:
        lines.append("⬇️ Автоматическое скачивание началось")
    issue_copy = _issue_copy(notification.issue)
    if issue_copy is not None:
        lines.append(issue_copy)
    if notification.issue is not None and notification.issue.code == "plex_pending":
        lines.append("✅ Подготовленный файл сохранён")
        lines.append("🔄 будет повторена только публикация в Plex")
    if notification.next_step and notification.next_step != "none":
        lines.append(f"➡️ Далее: {_next_step_copy(notification.next_step)}")
    return lines


def _detailed_lines(notification: MediaNotification) -> list[str]:
    lines = [*_compact_lines(notification), "", "ℹ️ Подробности"]
    transfer_lines = _transfer_detail_lines(notification)
    result_lines = _result_lines(notification)
    recovery_lines = _recovery_lines(notification)
    if transfer_lines:
        lines.extend(transfer_lines)
    if result_lines:
        lines.extend(result_lines)
    if recovery_lines:
        lines.extend(recovery_lines)
    if not transfer_lines and not result_lines and not recovery_lines:
        lines.append("Дополнительные измерения пока недоступны")
    return lines


def _has_presentation_details(notification: MediaNotification) -> bool:
    return bool(
        _transfer_detail_lines(notification)
        or _result_lines(notification)
        or _recovery_lines(notification)
    )


def _business_action(action: str, notification: MediaNotification) -> RenderedAction:
    labels = {
        "retry": "Повторить",
        "retry-missing": "Докачать недостающее",
        "resume-storage": "Проверить место",
        "details": "Диагностика",
        "search-alternative": "Выбрать другой источник",
    }
    return RenderedAction(
        labels[action],
        callback_data(
            action,
            notification.media.job_id,
            lifecycle_cycle=notification.lifecycle_cycle,
            revision=notification.revision,
        ),
    )


def _job_action_rows(
    notification: MediaNotification, view: CardView
) -> tuple[tuple[RenderedAction, ...], ...]:
    allowed = set(notification.actions)
    if notification.terminal:
        allowed.discard("cancel")
    job_id = notification.media.job_id
    if view == CardView.CONFIRM_CANCEL:
        if "cancel" not in allowed:
            return ()
        return (
            (
                RenderedAction(
                    "Да, отменить",
                    callback_data(
                        "cancel",
                        job_id,
                        lifecycle_cycle=notification.lifecycle_cycle,
                        revision=notification.revision,
                    ),
                ),
                RenderedAction(
                    "Назад", presentation_callback_data("dismiss-cancel", job_id)
                ),
            ),
        )

    rows: list[tuple[RenderedAction, ...]] = []
    recommended = next(
        (
            action
            for action in ("retry", "retry-missing", "resume-storage")
            if action in allowed
        ),
        None,
    )
    if recommended is not None:
        rows.append((_business_action(recommended, notification),))

    alternative = (
        _business_action("search-alternative", notification)
        if "search-alternative" in allowed
        else None
    )
    details = (
        RenderedAction("Подробнее", presentation_callback_data("expand", job_id))
        if view == CardView.COMPACT
        and "details" in allowed
        and (
            _has_presentation_details(notification)
            or notification.issue is not None
            or notification.state in {"failed", "partial", "needs-action"}
        )
        else None
    )
    cancel = (
        RenderedAction(
            "Отменить", presentation_callback_data("confirm-cancel", job_id)
        )
        if "cancel" in allowed
        else None
    )
    back = (
        RenderedAction("Назад", presentation_callback_data("collapse", job_id))
        if view == CardView.DETAILS
        else None
    )

    if view == CardView.COMPACT:
        related = tuple(action for action in (alternative, details, cancel) if action)
        if len(related) == 3:
            rows.extend(((related[0],), (related[1], related[2])))
        elif related:
            rows.append(related)
    else:
        navigation = tuple(action for action in (back, cancel) if action)
        if navigation:
            rows.append(navigation)
        if alternative is not None:
            rows.append((alternative,))
        if "details" in allowed and (
            notification.issue is not None
            or notification.state in {"failed", "partial", "needs-action"}
        ):
            rows.append((_business_action("details", notification),))
    return tuple(rows)


def _bounded_card_text(lines: list[str]) -> str:
    text = "\n".join(lines)
    if len(text) <= 1024:
        return text
    return text[:1021] + "..."


def normalize_card_view(
    notification: MediaNotification, view: CardView
) -> CardView:
    if (
        view == CardView.CONFIRM_CANCEL
        and (notification.terminal or "cancel" not in notification.actions)
    ):
        return CardView.COMPACT
    return view


def render_card(
    notification: MediaNotification, view: CardView = CardView.COMPACT
) -> RenderedCard:
    view = normalize_card_view(notification, view)
    if view == CardView.CONFIRM_CANCEL:
        lines = [
            "⚠️ Отменить загрузку?",
            media_identity(notification),
            "Уже загруженные и опубликованные файлы останутся на месте.",
        ]
    elif view == CardView.DETAILS:
        lines = _detailed_lines(notification)
    else:
        lines = _compact_lines(notification)
    return RenderedCard(
        _bounded_card_text(lines),
        _job_action_rows(notification, view),
        notification.media.poster_url or _SOURCE_CHOICE_FALLBACK_PHOTO,
    )


def render_push(notification: MediaNotification) -> str:
    title = media_identity(notification)
    if notification.state == "completed":
        return f"✅ {title} уже в Plex"
    prefix = {
        "completed": "✅ Готово",
        "partial": "⚠️ Готово не полностью",
        "failed": "❌ Не удалось",
        "cancelled": "⏹️ Отменено",
        "needs-action": "⛔ Требуется действие",
    }.get(notification.state, "🔔 Обновление")
    return f"{prefix}: {title}"


def render_event(notification: MediaNotification) -> RenderedCard:
    """Render one immutable lifecycle event with an in-place job opener."""
    return RenderedCard(
        render_push(notification),
        ((
            RenderedAction(
                "Открыть загрузку", f"mp:job:{notification.media.job_id}"
            ),
        ),),
    )


def card_fingerprint(rendered: RenderedCard) -> str:
    value = {
        "text": rendered.text,
        "photo": rendered.photo,
        "button_rows": [
            [action.callback_data for action in row]
            for row in rendered.button_rows
        ],
    }
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _action_callbacks(rendered: RenderedCard) -> tuple[str, ...]:
    return tuple(action.callback_data for action in rendered.actions)


def decide_update(
    stored: CardState | None,
    incoming: MediaNotification,
    *,
    fingerprint: str | None = None,
    action_callbacks: tuple[str, ...] | None = None,
    now: float | None = None,
) -> UpdateDecision:
    if stored is None or stored.message_id is None:
        return UpdateDecision.SEND
    if incoming.lifecycle_cycle < stored.lifecycle_cycle:
        return UpdateDecision.IGNORE
    if incoming.lifecycle_cycle > stored.lifecycle_cycle:
        return UpdateDecision.EDIT
    if stored.terminal or incoming.revision <= stored.revision:
        return UpdateDecision.IGNORE
    if action_callbacks is not None and stored.action_callbacks != action_callbacks:
        return UpdateDecision.EDIT
    if fingerprint is not None and stored.fingerprint and stored.fingerprint == fingerprint:
        return UpdateDecision.IGNORE
    current_time = time.time() if now is None else now
    if (
        not incoming.terminal
        and (incoming.stage or incoming.state) == stored.stage
        and current_time - stored.updated_at < PROGRESS_THROTTLE_SECONDS
    ):
        return UpdateDecision.RETRY
    return UpdateDecision.EDIT


def card_storage_key(chat_id: str, notification: MediaNotification) -> str:
    return f"{chat_id}:{notification.card_key}"


def update_card_state(
    state: NotificationState,
    key: str,
    notification: MediaNotification,
    message_id: str | None,
    *,
    rendered: RenderedCard | None = None,
    view: CardView = CardView.COMPACT,
    notification_payload: Mapping[str, Any] | None = None,
    has_photo: bool | None = None,
    now: float | None = None,
) -> None:
    if notification.lifecycle_cycle > (
        state.cards[key].lifecycle_cycle if key in state.cards else notification.lifecycle_cycle
    ):
        view = CardView.COMPACT
    normalized_view = normalize_card_view(notification, view)
    if rendered is None or normalized_view != view:
        rendered = render_card(notification, normalized_view)
    view = normalized_view
    stored_payload = None
    if notification_payload is not None:
        parse_notification(notification_payload)
        stored_payload = json.loads(
            json.dumps(notification_payload, separators=(",", ":"))
        )
    previous = state.cards.pop(key, None)
    state.cards[key] = CardState(
        message_id=message_id,
        revision=notification.revision,
        lifecycle_cycle=notification.lifecycle_cycle,
        terminal=notification.terminal,
        stage=notification.stage or notification.state,
        updated_at=time.time() if now is None else now,
        fingerprint=card_fingerprint(rendered),
        action_callbacks=_action_callbacks(rendered),
        view=view,
        notification_payload=stored_payload,
        has_photo=(previous.has_photo if previous is not None else bool(rendered.photo))
        if has_photo is None
        else has_photo,
    )
    while len(state.cards) > MAX_STATE_ITEMS:
        state.cards.pop(next(iter(state.cards)))


def push_receipt_key(notification: MediaNotification) -> str:
    if (
        notification.delivery_kind == DeliveryKind.FINAL_PUSH or notification.terminal
    ) and notification.card_key.startswith(("media-job:", "media-event:")):
        return (
            f"media-event:{notification.media.job_id}:"
            f"{notification.lifecycle_cycle}:{notification.revision}"
        )
    return f"{notification.card_key}:{notification.lifecycle_cycle}:{notification.revision}"


def has_push_receipt(state: NotificationState, notification: MediaNotification) -> bool:
    canonical = push_receipt_key(notification)
    aliases = {canonical}
    is_media_final = (
        notification.delivery_kind == DeliveryKind.FINAL_PUSH or notification.terminal
    ) and notification.card_key.startswith(("media-job:", "media-event:"))
    if is_media_final:
        aliases.add(
            f"media-job:{notification.media.job_id}:"
            f"{notification.lifecycle_cycle}:{notification.revision}"
        )
    else:
        aliases.add(
            f"{notification.card_key}:"
            f"{notification.lifecycle_cycle}:{notification.revision}"
        )
    if any(key in state.push_receipts for key in aliases):
        return True
    if not is_media_final:
        return False

    incoming = (notification.lifecycle_cycle, notification.revision)
    job_id = notification.media.job_id
    card_suffixes = (f":media-job:{job_id}", f":media-event:{job_id}")
    if any(
        (card.lifecycle_cycle, card.revision) > incoming
        for key, card in state.cards.items()
        if key.endswith(card_suffixes)
    ):
        return True

    receipt_prefixes = (f"media-job:{job_id}:", f"media-event:{job_id}:")
    for receipt in state.push_receipts:
        prefix = next(
            (value for value in receipt_prefixes if receipt.startswith(value)), None
        )
        if prefix is None:
            continue
        lifecycle, separator, revision = receipt.removeprefix(prefix).partition(":")
        if separator and lifecycle.isdigit() and revision.isdigit():
            if (int(lifecycle), int(revision)) > incoming:
                return True
    return False


def record_push_receipt(state: NotificationState, notification: MediaNotification) -> None:
    key = push_receipt_key(notification)
    if key not in state.push_receipts:
        state.push_receipts.append(key)
    del state.push_receipts[:-MAX_STATE_ITEMS]


def load_state(path: Path) -> NotificationState:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return NotificationState()
    if not isinstance(raw, Mapping):
        return NotificationState()
    if raw.get("version") in {2, 3, 4, 5, 6, 7}:
        raw_cards = raw.get("cards")
        raw_receipts = raw.get("push_receipts")
        raw_control_receipts = raw.get("control_receipts", [])
        raw_pending_card_deliveries = raw.get("pending_card_deliveries", [])
        if (
            not isinstance(raw_cards, Mapping)
            or not isinstance(raw_receipts, list)
            or not isinstance(raw_control_receipts, list)
            or not isinstance(raw_pending_card_deliveries, (list, Mapping))
        ):
            return NotificationState()
        cards: dict[str, CardState] = {}
        for key, value in raw_cards.items():
            if not isinstance(key, str):
                continue
            card = CardState.from_value(value)
            if card is not None:
                cards[key] = card
            if len(cards) == MAX_STATE_ITEMS:
                break
        receipts = [receipt for receipt in raw_receipts if isinstance(receipt, str)][:MAX_STATE_ITEMS]
        control_receipts = [
            receipt for receipt in raw_control_receipts if isinstance(receipt, str)
        ][:MAX_STATE_ITEMS]
        if isinstance(raw_pending_card_deliveries, list):
            pending_card_deliveries = {
                delivery: {"phase": "sending"}
                for delivery in raw_pending_card_deliveries
                if isinstance(delivery, str)
            }
        else:
            pending_card_deliveries = {
                key: dict(value)
                for key, value in raw_pending_card_deliveries.items()
                if isinstance(key, str)
                and isinstance(value, Mapping)
                and value.get("phase") in {"sending", "sent"}
            }
        pending_card_deliveries = dict(
            list(pending_card_deliveries.items())[:MAX_STATE_ITEMS]
        )
        return NotificationState(
            cards, receipts, control_receipts, pending_card_deliveries
        )

    cards = {
        key: CardState(str(value), 0, 0, False, "", 0.0)
        for key, value in raw.items()
        if isinstance(key, str) and str(value).isdigit()
    }
    return NotificationState(dict(list(cards.items())[-MAX_STATE_ITEMS:]), [], [])


def save_state(path: Path, state: NotificationState) -> None:
    while len(state.cards) > MAX_STATE_ITEMS:
        state.cards.pop(next(iter(state.cards)))
    del state.push_receipts[:-MAX_STATE_ITEMS]
    del state.control_receipts[:-MAX_STATE_ITEMS]
    payload = {
        "version": 6,
        "cards": {key: card.to_value() for key, card in state.cards.items()},
        "push_receipts": state.push_receipts,
        "control_receipts": state.control_receipts,
        "pending_card_deliveries": state.pending_card_deliveries,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(json.dumps(payload, sort_keys=True, separators=(",", ":")), encoding="utf-8")
    os.replace(temporary, path)


def is_missing_telegram_message(error: object) -> bool:
    text = str(error or "").lower()
    return "message to edit not found" in text or "message not found" in text


def media_callback_argv(action: str, job_id: str) -> tuple[str, ...] | None:
    if action == "cancel":
        return ("jobs", "cancel", job_id)
    if action in {"retry", "retry-missing", "resume-storage"}:
        return ("jobs", "retry", job_id)
    if action == "details":
        return ("jobs", "get", job_id)
    if action == "search-alternative":
        return ("jobs", "alternatives", job_id, "--json")
    return None


def sanitize_details(output: bytes | str) -> str:
    try:
        raw = json.loads(output.decode("utf-8") if isinstance(output, bytes) else output)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return "Не удалось получить технические сведения."
    if not isinstance(raw, Mapping):
        return "Не удалось получить технические сведения."
    lines = ["Технические сведения"]
    for key, label in (("id", "Задача"), ("state", "Статус"), ("attempt_count", "Попытка"), ("error_code", "Код")):
        value = raw.get(key)
        if isinstance(value, (str, int)) and not isinstance(value, bool):
            lines.append(f"{label}: {value}")
    return "\n".join(lines) if len(lines) > 1 else "Не удалось получить технические сведения."
