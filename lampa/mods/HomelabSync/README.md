# Household progress and history extension

`HomelabSync` is a local dynamic Lampac module. It serves its own JavaScript at
`/homelab-sync.js` (or `/homelab-sync/js/{token}`), without modifying Lampac or
Lampa source files. The response is `no-store`; its serialized configuration
uses Lampac's existing assigned identity and optional route token. Progress reads
go directly to the existing authenticated `/timecode/dump` endpoint once, then to
its incremental `/timecode/changelog?since=` (including tombstones; truncated
pages continue in the same pull). A full dump is repeated every six hours and on
profile change; a Lampac without the changelog (no rows, or a client error such as
404 on that route) falls back to dumps. The owned
Continue Watching row additionally reads/writes `/homelab-sync/resume`, using
Lampac’s existing identity and profile namespace. It introduces no account system
or direct connection to the native SQLite database.

The module is mounted read-only at `/lampac/mods/HomelabSync` and registered via
`LampaWeb.customPlugins`. In deployments requiring a token-bearing script URL,
configure its token route privately, as for native TimeCode; flat custom plugin
URLs are not automatically converted to token routes. Never commit tokens.

## Behavior

- Pull playback progress at startup, on focus/foreground/pageshow, on navigation
  and player close, and once a minute outside playback. Bursts share a request;
  scheduled attempts are at least 15 seconds apart, with a 10-second timeout.
  Every caller (screens, panels, the main row) reuses a result younger than
  10 seconds (3 seconds after a failure) instead of issuing another request.
- Preserve the native main/shared and non-main profile namespaces. Discard old
  responses and clear the extension's in-memory snapshot on profile changes.
- Repair older imports into native timeline storage through public Timeline
  `read`/`update` notifications, coalesced into one pass per native batch.
  Preserve newer local positions and retain delete
  timestamps/duration. Reading back storage rebuilds native indexes without
  echoing playback writes. Ambiguous hashes belonging to different cards are
  retained for our own history but are not imported into native hash storage.
- Add **История дома** through `Menu.addButton` and `Component.add`, using the
  public Category maker for mobile layouts, TV navigation and pagination.
  Combine Lampac progress with CUB's event history; refetch CUB events on refresh,
  including rewatches. The open owned panel updates without a PWA reload.
  Background polls repaint the progress line of shown cards in place, so TV
  focus, scroll and loaded pages are kept; new cards appear on the next visit.
  Cards show the newest position in Continue wording («С1 · Е20 · осталось
  12 мин»), the watched-episode count with relative time («вчера») and a poster
  progress bar. The per-card panel groups events under day headers («Сегодня»,
  «Вчера», «5 ноября») with the clock time; the newest event of each episode
  shows its saved progress bar or a watched mark. When the card is in Continue,
  the panel also offers **Продолжить**.
- Leave CUB's own history screen available. This extension does not replace its
  component or patch generated JavaScript. Snapshot-derived events are the latest
  saved position per file, not a reconstruction of every historical viewing;
  repeated viewing events come from CUB. Its native per-card API returns at most
  1,000 events. CUB requires its normal account authorization.

## Continue Watching

The owned **Продолжить просмотр** main row uses native Maker Card modules from
history, inside an owned Scroll/Controller row. Native poster proportions, focus,
TV badges, play icons and lazy image loading are reused. The row displays the
captured episode/progress and time rather than deriving another source's timeline;
refreshes preserve the page and focused card. The row is created at once from the
last list cached on the device for the same identity/profile (Main waits for its
first batch of rows) and updates when the pull and resume read complete.

An episode past 90% (Lampa's own watched mark) is offered as the next episode
from its start: within the season, or episode 1 of the next season when TMDB
season counts say the season ended; a finished series and watched movies leave the
row. A torrent continuation finds that episode in the same release; online keeps
the provider/voice within the season.

Each tile is drawn from the cached record alone (no request): a poster progress
bar, «С1 · Е29 · осталось 12 мин» (or «Следующая: Е30» once the previous episode
is past 90%), a source badge (online provider or «Торрент») and relative time
(«вчера», «3 дня назад») with the year. The focus overlay lists up to five
episodes from the current one: the current episode is highlighted with its
progress, other episodes of the same season show a watched mark or partial
progress from the native timeline rows.

A long press opens **Убрать из ряда** (the server stores a tombstone and a later
viewing brings the card back), **Отметить просмотренным** (stores the shown episode
or movie at its end with the captured source, so the row advances to the next
episode or drops the movie; offered only for records with a server-valid captured
source, and not for an online next episode in another season, whose captured
season index would not match; it updates only the Continue record, not Lampa's
native Timeline marks) and **Выбрать источник** (opens `HomelabSources.resume` for the exact
episode and position, or the card when the picker is unavailable). Focus moves
to a neighbour only when the card leaves the row. `window.homelabContinue` also
exposes `watched(item)` and `resume(item, {choose: true})`.

Records distinguish torrent and online sources. A newer observation replaces the
whole source for the same card, so switching from a torrent to online cannot leave
the old torrent active. Legacy records without `kind` retain torrent semantics.
Only clients with this extension can capture the source; progress without source
metadata opens the source picker with its exact episode and position (or the card
when the picker is unavailable). Cards from non-TMDB catalogues are not captured.

Torrent records retain the hash/file index, exact position and track preferences.
Direct continuation checks the existing TorrServer file without adding a torrent,
then rebuilds the naturally ordered release playlist and external subtitles using
canonical native timeline identities. A missing source opens the card for source
choice. Full-card metadata failure retains selected-file playback with a warning.

Online continuation supports the installed Lampac NextGen `lampac` component and
built-in player. A side decorator uses public Component get/add registration and
the component's methods; upstream files are never edited. It captures the provider,
exact voice label, semantic episode and native season-selector index for every
playlist item. Resume reopens the native component, selects the saved source and
voice by name, and lets its normal resolver obtain fresh links, headers, quality,
RCH and subtitles. Media/resolver URLs, headers, tokens and credentials are never
stored in resume records. Missing or different providers/voices never autoplay an
alternative. Cancellation, profile changes and departed activities block late
responses; successful manual playback retires an earlier automatic intent.

Online continuation accepts the MVC wire representation of a first-season source:
`season_index: 0` can be omitted by Lampac's default-value serializer. Only a
missing index is normalized to zero; explicit invalid values are rejected. The
native folder index is never inferred from the semantic season number.

The explicit position is applied once, before native continuation prompts can
interfere. Re-selecting a playlist item does not repeat its original jump. The saved
voice is matched across every row of a native draw (movies list translations as
rows); only a whole draw without it reports a change, and a draw of another season
(a shifted season index) reports a missing episode at once. Movie rows are also
identified by their translation text, because some providers put a release tag in
`voice_name`; several equal rows are never guessed between. The saved voice name is
seeded for movies too, so providers with voice buttons open that voice (native
display names every row after the active button). A movie
row chosen in the source picker is reopened by its exact URL, else by its index when
the page has the same row count, each confirmed by translation/text/tag; a capture
saves only index, count and texts (never the resolver URL). Any key, click or touch
in the opened component cancels the automatic start. After the component opens,
failures and the 60-second timeout show a notice and leave the user there. Only a
saved online source that cannot launch (the component never opened) falls back:
to the owned source picker with the original card, exact S/E, saved voice and
position, or to the native full card when the picker is unavailable. Explicit quality labels map to
heights as in the picker (`4K`/`UHD` is 2160).

External players (Android, webOS, Apple TV) receive the continuation point through
the timeline they read at launch. Their launch is captured, and the position the
native timeline records on return (within 24 hours) is captured again. Online
support for unrelated third-party components is not implemented. Presence guards
cannot guarantee future changes to the native frontend or Lampac online plugin
method contracts.

The client observes progress every 15 seconds, on pause/preferences changes and
player close. Unchanged paused playback keeps its original observation time.
Writes share one request and retry after 5, 15 and 60 seconds; a visible warning
marks failures. Foreground and profile changes refresh the owned row. The server
reports older observations as `stale` (the client then keeps the server record),
clamps a client stamp more than five minutes from its clock to its own time and
returns the stored stamp, and rejects invalid identities and oversized requests
(16 KiB, including chunked bodies). An unreadable store file is set aside as
`*.corrupt-<time>` and replaced, and at most 500 user/profile files are created (a new one beyond that is answered
507, which clients retry; rejected writes are dropped and not shown as saved). Atomic JSON files under the existing writable
`database/homelab-sync-resume/` bind retain at most 50 entries per hashed user/profile.
The updater’s database snapshot therefore includes this state.

Captured records keep their source for their own episode. Native TimeCode can
assign a new time to a stale paused player’s close, so:

- newer native progress of the captured episode or movie (same cut) moves the
  position forward only when it is watched (90%) or more than 30 s further, and
  keeps the source; a rewind or another cut does not;
- another episode replaces the record (without the captured source) only when it is
  a later episode, or a special involved on either side, viewed at least a minute,
  and stamped more than two minutes after the capture (the native player saves
  every two minutes, so an active viewing keeps stamping);
- after a dismissal, any newer viewing brings the card back; a dismissal is stamped
  after the newest native viewing of the card.

Any key, click or touch while a torrent or picker launch is still being prepared
cancels it. Native
progress supplies historical fallback for cards never captured by the extension;
matching deletion markers remain honoured.
Audio/subtitle restoration requires the matching track to exist in that source.

## Compatibility and failure handling

Missing public client APIs or an incompatible dump shape disable this extension,
not Lampa. Network failures remain retryable; cached progress is identified as
not refreshed rather than presented as a successful synchronization.

The runtime updater canary-tests a copy of this module against every candidate
image and can ship a healthy core with the module disabled
(`manifest.enable: false`), retrying it on the next update; see the `check` and
`apply` steps in [UPDATE.md](../../UPDATE.md). Lampa's native frontend
downloader is independent of the image updater; the JavaScript guards check
required entry points only, so keep behavioral checks against the latest web
client. No changes or pull requests are submitted to upstream repositories.

## Installation and verification

The module needs the read-only `./mods/HomelabSync` bind and its registration
in `LampaWeb.customPlugins`, both in the tracked Lampa configuration. Runtime
updates test it as described in [UPDATE.md](../../UPDATE.md); do not bypass the
updater's mount or config-hash checks.

```bash
node --test lampa/tests/
python3 tests/lampac-optional-module-test.py
# Against a separately started, isolated synthetic canary only:
python3 tests/lampac-resume-api-test.py --container homelab-ux-check
python3 tests/lampac-update-runtime-ready-test.py
sh tests/lampac-auto-update-drift-test.sh
```

The regression fixtures are synthetic and contain no household viewing records. The bundle parts and
account-sync wait for native app readiness before touching Menu or Favorite.
