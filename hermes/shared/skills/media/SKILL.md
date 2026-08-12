---
name: media
description: Use for media search, downloads, Plex, jobs, schedules, Rezka sessions, and personal or family tracking.
---

# Media

Use only discovered `mcp_media_admin_*` tools for media-service operations and
parse their structured results. Never use terminal, the human CLI, HTTP, or a
provider URL. If a required tool is absent, say it is not deployed; never invent
a tool name. For explicit public-web research, follow the shared `web-research` skill. Its managed
client searches and fetches bounded source evidence in one call. Use native `web_search`
and `web_extract` only if that client fails or returns insufficient evidence. Never use
terminal HTTP or browser search. Do not treat search-result snippets as verified evidence.

Never expose credentials, tokens, endpoints, signed URLs, raw JSON, or private
job/search/result/tracking/request IDs. Keep IDs as private state and show them
only after an explicit request for technical details.

## Invariants

- Natural-language messages are routed by the conversational agent before any
  media tool call. Resolve the intended work and a clean title first. Never
  forward command framing such as "find a movie about", "найди фильм про", or
  provider instructions as the `media_search.query`. If the intended title is
  not clear enough, ask one concise clarification instead of searching the raw
  phrase.
- For ordinary search, query Rezka and Prowlarr immediately, produce one
  unified ranked list, and continue without asking where to search. Label every
  result and keep it bound to its provider. `Only Rezka` and `only Prowlarr` are
  the explicit overrides. Never silently switch providers.
- Create a download only after an explicit provider result, Rezka translation
  when offered, and series coordinates. A request for one episode remains one
  episode; distinguish it from the whole season.
- Rezka availability and release-calendar counts are independent. Attribute
  each fact to its source.
- A `completed` state alone does not prove upscale or transcode. Claim those
  only from an explicit stage or verification field.
- Prefer compact `summary` list views. Use `card` for deterministic Telegram
  panels and `diagnostic` only for an explicit technical investigation. Follow
  `next_cursor` instead of requesting an unbounded list.

## Tool routing

| Intent | Tool |
| --- | --- |
| Search | `media_search` (`source=all` by default) |
| Cached episode choices | `media_episode_choice_set` |
| Refresh expired choices | `media_episode_choice_set_refresh` |
| Download cached choice | `media_episode_choice_set_download` |
| Continue search | `media_search` with `continuation`, no query |
| Download selected search result | `media_download` |
| Job / queue | `media_job_get` / `media_queue_status` |
| Schedule | `media_release_schedule` |
| Trends / details / similar | `media_trending` / `media_details` / `media_similar` |
| Tracking | `media_tracking_list`, `media_tracking_create`, `media_tracking_enable_download`, `media_tracking_set_baseline`, `media_tracking_check`, `media_tracking_remove` |
| Plex playback | `plex_now_playing` |

## Search and selection

For Prowlarr series searches, require a season. Show a maximum of five numbered,
labelled results per page. Preserve stable references privately. Rank provider
rank first (55%), then title/season match (25%), release preference (12%), and
availability such as seeders or translations (8%). Rezka shows title, year,
and translation count. Prowlarr shows release title, size, and seeders. Omit
unknown fields.

Keep continuation state scoped to the chat. Merge remote provider pages and
rerank rather than replacing the unified list. After result selection, ask
only for still-ambiguous translation or coordinates. "show more" follows the
same combined search cursor.

Tracked-episode notifications carry an opaque `choice_set_id`. Open it with
`media_episode_choice_set`; do not search providers again. Refresh only when it
reports expiry. Download with the same choice set, exact source/result, and
episode coordinates.

## Downloads

- Rezka episode: pass `translation_id`, `season`, and `episode`.
- Prowlarr episode: pass `season` and `episode` to `media_download`.
  qBittorrent downloads only the matching video file and same-episode subtitle
  sidecars.
- Season: pass `season` without `episode`; this downloads available episodes in
  that exact selected result/translation.
- Omit both coordinates only after explicit confirmation of the whole series.
- Notify the initiator unless family notification was explicitly requested.

After successful `media_download`, return exactly `NO_REPLY`. The deterministic
notifier immediately creates the authoritative live card. Reply normally only
when creation fails or another choice is required.

## Schedules and trends

Use `media_release_schedule` for released/expected counts, lifecycle, and next
airing. Include canonical/original title and year when known. On
`choice_needed`, retry a localized or season-suffixed title with the canonical
base title, original title, and year, then filter to the requested season. If
still ambiguous, ask rather than guess. Report precision and dates exactly as
returned. Schedule lookup never downloads or creates tracking.

Attribute schedule facts to TVmaze and actual download availability to Rezka or
Prowlarr; neither proves the other. If the user explicitly asks for a web
comparison, first run the schedule lookup, then use the managed `web-research`
client with at least two source pages. Search snippets alone are not evidence.

Use `media_trending`: `all` by default, `movie` for `/movies` and popular movies,
`tv` for `/series`. Preserve TMDB order and show up to five items with title, original
title when distinct, year, kind, and rating. A trend is not a download result;
start a separate provider search when asked to find it.

For `/watching`, use `plex_now_playing`, never trends or recent additions. Show
title, S/E, Plex user, player, state, and measured progress when present.

## Jobs and notifier cards

Translate job status and stages into plain language. For an explicit user status
question, use `media_job_get`. Its 10-cell progress bar may use only measured
`downloaded_bytes`, `total_bytes`, `download_speed_bps`, `eta_seconds`, `seeds`,
`peers`, and `updated_at`. Do not invent a percentage or ETA.

Each job has one Telegram status card for its complete lifecycle; a season still
uses one card. `media-notifier` updates that card at most every ten seconds when
progress changes, without an LLM call or model-token usage; do not answer these
edits. On a terminal transition the existing card is edited into the final
result and one short reply is sent; details remain in the card. Direct notifier
cards must not be answered or summarized by the agent. Partial seasons offer
`retry-missing`, which retries only those missing episodes without invoking the
conversational agent or consuming model tokens.
Never repeat or summarize notifier-owned progress unless explicitly asked.

Job-card actions are owned by `media-notifier`. Buttons on job cards are deterministic
and never generated by the LLM. `Details` edits the existing card. `Back` restores its compact view;
technical IDs are shown only after `Подробнее`.

For a stalled queued job, fetch queue status. Report sanitized `blocked_reason`.
`vpn_rotation_failed` needs operator recovery. For `identity_ambiguous`, use
`media_job_mapping_get`, ask for canonical Plex coordinates, then call
`media_job_mapping_resolve`; never guess specials/OVA numbering.

## Tracking

Ordinary tracking is source-independent. Never ask whether
ordinary tracking should use Rezka or Prowlarr. Obtain a `release_identity` with
a positive `source_id`, then create with canonical title,
`translation=release-calendar`, latest known episode, and personal/family scope.
Never create ordinary tracking from a title alone. One subscription later will
search Rezka and Prowlarr and show one unified ranked result set.

Automatic-download tracking is an explicit Rezka-only download mode. Require one exact
Rezka result and translation. First list tracking, match series and season, and
enable download on the existing subscription; do not delete and recreate it.
Pass the numeric media reference without the `rezka:` prefix. If absent, create
with nested download selection. The exact translation is mandatory;
`release-calendar` is invalid for automatic-download tracking. Never silently
substitute Prowlarr.

The latest available episode is the initial high-water mark. Do not enumerate
old episodes or create a Hermes cron. For corrections, call
`media_tracking_set_baseline` rather than recreate. For an immediate recheck,
call `media_tracking_check`; do not claim completion until `last_checked_at`
changes. Ordinary subscriptions are checked once per hour; automatic downloads
every 15 minutes.
`awaiting_source` means the calendar episode cannot yet be downloaded and no
notification is sent. Offer tracking when the schedule says `ongoing`.

Tracking check meanings: `never` has not run; `no_new_episode` found nothing
new; `episode_found` found a provider-available episode; `download_queued`
queued it; `release_error` failed at the schedule source; `source_error` failed
at a download provider. The scheduler qualifies newly due work roughly once per
minute; this is scheduling granularity, not each subscription's check interval.

## Rezka authentication

The session is renewed automatically by `media-service`. Never ask
for Telegram approval or use the browser for routine renewal. Only after an
operator explicitly approves a fresh Vaultwarden request may you call
`media_rezka_session_refresh` with its one-time `credential_request_id`. Never
request or expose credentials. Otherwise report a redacted provider failure
and operator attention requirement.

## Telegram response

Use one status emoji, a short bold heading, short lines, no tables/prose walls,
and at most three emoji types. Add `➡️ **Дальше:**` only for a concrete action.

For two to five clear choices, you MUST use Hermes' native `clarify`: provider
result, one episode versus whole season, or up to five translations. Do not ask any of these questions as a plain-text list.
For more translations, show five
plus `Показать ещё`. Do not use choices for destructive actions, credentials,
open questions, or a single obvious action. Never print XML-like Telegram quick-reply markup.
