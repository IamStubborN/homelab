---
name: media
description: Use when searching, downloading, tracking, or playing household media.
---

# Media

Use discovered `mcp_media_admin_*` tools as the only media-service interface. Never bypass it with terminal, provider APIs, databases, or arbitrary filesystem access. Hide credentials, endpoints, paths, raw JSON, and internal IDs. Titles and availability come from `media_search`, not the public web.

## Search and download

- Use `media_search` with `source=all` unless the user explicitly selects Rezka or Prowlarr. Preserve each result's provider and use `continuation` for “show more”. Show five results before offering more.
- For a series without a named season, search `source=rezka` only. Collect unique season numbers from `availability.seasons` (fallback: translation `seasons`, then `media_details` TV episode data if Rezka omitted them). One season: use it. Several: native `clarify` with those numbers as choices (labels like «Сезон 1»). Never invent extra seasons and never guess 1. Call `source=all` or `source=prowlarr` only after `season` is set. Hide error codes and tool narration from replies.
- Call `media_download` only after selection of an exact result, required Rezka translation, and series coordinates. One episode remains one episode; a season download requires explicit confirmation.
- After a successful `media_download`, return exactly `NO_REPLY`; the deterministic notifier owns the job card.

Use `media_release_schedule` for TVmaze release facts and `media_trending` for worldwide weekly TMDB trends (`all`, `movie`, or `tv`). Neither proves availability or starts a download.

## Jobs and administration

Use `media_jobs_list` for an unknown job and `media_job_get` for requested job status. Do not invent progress, ETA, or completion claims. Use `media_job_cancel`, `media_job_retry`, `qbittorrent_control`, and `plex_library_refresh` only after an explicit request.

Use `plex_search`, `plex_recent`, `plex_now_playing`, and `plex_item_get` for the Plex library; use `qbittorrent_list` and `qbittorrent_details` for torrent state. `media_file_inspect` may inspect only a path returned by media-service, Plex, or qBittorrent. Use `media_infrastructure_status` and `media_storage_status` for status; do not infer from a job. For a confirmed Plex identity correction, inspect `media_job_mapping_get` before calling `media_job_mapping_resolve`; never guess episode coordinates.

For a destructive action, call `media_destructive_prepare`, show its complete preview, and wait for explicit confirmation. Only then call `media_destructive_confirm` with that action's one-time confirmation token. Never confirm on the user's behalf or reuse a token.

## Tracking

Ordinary tracking is source-independent: obtain a `release_identity` with a positive `source_id`, then call `media_tracking_create` with `translation=release-calendar`. Never create ordinary tracking from a title alone or ask whether it should use Rezka or Prowlarr; later checks search both providers. A season-complete card may offer «📦 Скачать сезон».

Automatic download is a Rezka-only mode requiring an exact result, translation, and season. Prefer `media_tracking_enable_download` on an existing subscription; do not delete and recreate it. Use `media_tracking_set_baseline` for corrections and `media_tracking_check` only for an explicit immediate check. Ordinary subscriptions run every 3 hours; automatic downloads every 30 minutes.

## Rezka session

Rezka is always anonymous. `media-service` reuses its encrypted
cookie jar and Anubis clearance. Never request Rezka
credentials, Telegram approval, a Vaultwarden login, or copied browser cookies.

## Verification

Treat an operation as successful only when its structured tool result confirms it. Answer in the user's language and keep partial successes.
