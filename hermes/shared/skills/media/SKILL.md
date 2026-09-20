---
name: media
description: Use when searching, downloading, tracking, or playing household media.
---

Use discovered `mcp_media_admin_*` tools as media interface; never bypass with terminal, provider APIs, databases, or files. Hide credentials, endpoints, paths, raw JSON, and internal IDs. Titles/availability come from `media_search`, not the public web.

## Search

- Use `media_search` with `source=all` unless the user explicitly selects Rezka or Prowlarr. Preserve each provider; use `continuation` for “show more”; show five results before more.
- For an unnamed-season series, search `source=rezka` only; collect seasons from `availability.seasons` (fallback: translation `seasons`, then `media_details` TV episode data). One: use it. Several: native `clarify` choices such as «Сезон 1». Never invent seasons; never guess 1. Call `source=all` or `source=prowlarr` only after `season` is set.
- Call `media_download` only after an exact result, required Rezka translation, and series coordinates. One episode remains one episode; a season download requires explicit confirmation.
- After successful `media_download`, return exactly `NO_REPLY`; deterministic notifier owns the job card.

Use `media_release_schedule` for TVmaze facts; `media_trending` for worldwide weekly TMDB trends (`all`, `movie`, or `tv`). Neither proves availability or downloads.

## Jobs

Unknown job: `media_jobs_list`; status: `media_job_get`. Do not invent progress, ETA, or completion claims. Use `media_job_cancel`, `media_job_retry`, `qbittorrent_control`, and `plex_library_refresh` only after an explicit request.

Plex: `plex_search`, `plex_recent`, `plex_now_playing`, `plex_item_get`; torrents: `qbittorrent_list`, `qbittorrent_details`. `media_file_inspect` accepts only service-returned paths. Use `media_infrastructure_status` and `media_storage_status`; never infer from a job. For Plex correction, inspect `media_job_mapping_get` before `media_job_mapping_resolve`; never guess coordinates.

For destructive actions, call `media_destructive_prepare`, show its complete preview, and wait for explicit confirmation. Then call `media_destructive_confirm` with its one-time confirmation token. Never confirm for the user or reuse a token.

## Tracking

Ordinary tracking is source-independent: obtain a `release_identity` with positive `source_id`, then call `media_tracking_create` with `translation=release-calendar`. Never create ordinary tracking from a title alone or ask for a provider; later checks search both providers. A season-complete card may offer «📦 Скачать сезон». Missing positive TVmaze identity is rejected (`missing_release_identity` / invalid params).

`media_tracking_create` is idempotent per owner payload. On `already_exists`, use its `tracking_id` and **do not recreate**. Operation-key retries reuse it.

`check_status=awaiting_source` means aired content is not downloadable yet. Views expose `status_reason`, `last_error`, `pending_episodes`, `pending_since`, and `pending_age_seconds`; failures are `enqueue_search_failed`, `enqueue_verify_failed`, `enqueue_persist_failed`, or `enqueue_job_failed`. Use `media_tracking_check` for recheck; **do not** recreate while awaiting source or reporting those codes.

Automatic download is a Rezka-only mode requiring an exact result, translation, and season. Prefer `media_tracking_enable_download`; do not delete and recreate. Use `media_tracking_set_baseline` for corrections and `media_tracking_check` for immediate checks. Ordinary subscriptions run every 3 hours; automatic downloads every 30 minutes; no backfill below the baseline.

## Rezka

Rezka is always anonymous: `media-service` reuses its cookie jar and Anubis clearance. Never request Rezka
credentials, Telegram approval, Vaultwarden, or browser cookies.

## Verify

Trust structured results. Answer in user's language; preserve partial successes.
