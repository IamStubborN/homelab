---
name: media-admin
description: Use for media search and administration through media-service: jobs, tracking, Plex, qBittorrent, scoped file diagnostics, and infrastructure health.
---

# Media Administration

Use the discovered `mcp_media_admin_*` tools for ad hoc media administration.
The MCP server is the media-service facade; it is not a second provider client.
Every tool published by this server is available to both Hermes profiles. The
server discovers capabilities dynamically; never maintain a client-side tool
allowlist or invent an undiscovered tool name.

## Rules

- Use `media_jobs_list` before guessing a job identifier.
- Use `media_job_get` for the full current state of one user-owned job.
- Use `media_queue_status` when the user asks whether the runner or queue is working.
- Use `media_job_cancel` only after the user explicitly asks to cancel a job.
- Use `media_job_retry` only after the user explicitly asks to retry a failed or partial job.
- Use `media_tracking_list` to inspect subscriptions and `media_tracking_check` only when the user asks for an immediate check.
- Use `media_tracking_create`, `media_tracking_enable_download`,
  `media_tracking_set_baseline`, and `media_tracking_remove` for explicit
  subscription changes. Never recreate a subscription just to change its baseline.
- Use `media_search` for a conversational search or continuation. Prefer
  `source=all` unless the user explicitly asks for Rezka or Prowlarr only. Keep
  provider results separate and never start a download without a concrete selection.
- Use `media_download` only after the user selects the exact result and all
  required translation and episode coordinates.
- Use `media_release_schedule` for release calendars, `media_trending` for
  weekly TMDB trends, `media_details` for one title card, and `media_similar`
  for related titles. These tools never start a provider search or download.
- Use `media_job_alternatives`, `media_job_mapping_get`, and
  `media_job_mapping_resolve` for failed-source recovery and explicitly
  confirmed Plex episode identity corrections.
- Use `plex_search`, `plex_recent`, `plex_now_playing`, and `plex_item_get` for questions about the actual Plex library or current playback. Use `plex_library_summary` for configured library names and item counts. Tracking state and completed jobs are not proof that media is present in Plex.
- Use `qbittorrent_list` and `qbittorrent_details` for the actual torrent state, progress, speed, ETA, peers, and selected files. Use `qbittorrent_control` only after the user explicitly asks to pause, resume, or recheck a torrent.
- Use `media_file_inspect` only for a path returned by Plex, qBittorrent, or media-service. It is restricted to configured media roots; never invent or probe unrelated paths.
- Use `media_infrastructure_status` for application-level Plex/qBittorrent/media-service health. It does not expose Docker and cannot claim container-level health.
- Use `media_storage_status` for media-root capacity and free-space questions. Do not infer free space from a job state alone.
- Use `plex_library_refresh` only after the user explicitly asks to rescan a configured Plex library.
- For `plex_delete`, `torrent_delete`, or `file_quarantine`, first call `media_destructive_prepare` and show the complete preview in plain language. Call `media_destructive_confirm` only after the user explicitly confirms that exact preview. Never infer confirmation from the original request, never confirm on the user's behalf, and never reuse a token. File actions quarantine data instead of permanently deleting it.
- Explain the result in user-facing language; hide internal IDs unless the user asks for technical details or a specific job identifier is needed for the next action.
- MCP ownership is enforced by media-service. Never pass an owner, user, token, provider credential, endpoint, or filesystem path to bypass it.
- Do not use Docker, curl, direct provider APIs, database access, or arbitrary filesystem access from Hermes. All controls are routed through media-service and provider credentials stay behind that boundary.

## Response style

- Answer the user's question first. Do not narrate tool names, hashes, rating keys, paths, or raw JSON unless requested.
- For active downloads show title, state, progress, speed, ETA, and the next useful action when those fields exist.
- For Plex results show title, year, media type, season/episode, playback state, and library location when relevant.
- If a provider is unavailable, name only that provider and keep successful results from the other provider.
- Keep ordinary Telegram responses compact. Offer details instead of dumping full provider payloads.
