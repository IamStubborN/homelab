# Household progress and history extension

## Unified playback sources

`online.js` loads the independent `plugins/common-sources.js` picker from the
existing read-only plugins mount. It adds **Общий** first in the native Watch
source chooser through `full/complite`; upstream code and source settings are
not modified. Quality tabs filter a progressive list of online voices and
native parser torrent releases for the selected title.

Online catalog requests have concurrency two; all metadata requests and polls
are paced at least 350 ms apart. Traversal is limited to the selected season
and episode, a 60-second deadline and 32 pages per provider. Online rows of
unknown quality stay visible under every quality tab, labelled «Качество
уточняется»; torrents without a quality remain hidden under a specific tab. Ambiguous titles/seasons, RCH and failed metadata
probes offer native-source selection instead of declaring the source dead.
Torrent releases with explicit incompatible season/episode coverage are
excluded; unknown-coverage packs retain the native file chooser. Discovery
never adds torrents or resolves video URLs. Results and stream URLs are not
persisted.

Selection uses native Lampac fresh resolution, headers, subtitles and complete
playlists through the online bridge. Explicit quality is passed as a single
quality so native Player cannot override it with the global default. Global
settings remain unchanged. Torrent selection passes the original parser result
and full movie card to `Torrent.start`. Leaving the activity or changing
profile cancels searches; returning keeps collected results with Refresh.
Tests: `common-sources.test.cjs` and `online-resume.test.cjs`. Native-frontend
compatibility still needs validation after upstream updates.

The same loader installs `playlist-thumbnails.js`. It fills only a missing
next-episode thumbnail (including native `w300null` placeholders) with the exact
TMDB episode still from public `Api.seasons` (tmdb/cub ids or `card.tmdb_id`).
The card backdrop/poster is shown only as a provisional fallback when the still
is slow (>1.5 s) or absent, and is upgraded when the still arrives. Season stills
are cached per app session (bounded, survives episode switches; misses retry
after 5 min). Valid existing thumbnails are preserved. A guarded re-set of the
same native playlist updates the Next renderer without changing media URLs,
order, or the current index. Closing the player, replacing the playlist, or
changing profile invalidates late callbacks.

`HomelabSync` is a local dynamic Lampac module. It serves its own JavaScript at
`/homelab-sync.js` (or `/homelab-sync/js/{token}`), without modifying Lampac or
Lampa source files. The response is `no-store`; its serialized configuration
uses Lampac's existing assigned identity and optional route token. Progress reads
go directly to the existing authenticated `/timecode/dump` endpoint once, then to
its incremental `/timecode/changelog?since=` (including tombstones; truncated
pages continue in the same pull). A full dump is repeated every six hours and on
profile change; a Lampac without the changelog falls back to dumps. The owned
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
the provider/voice within the season. A long press offers **Убрать из «Продолжить
просмотр»**: the server stores a tombstone and a later viewing brings the card back.

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

The explicit position is applied once, before native continuation prompts can
interfere. Re-selecting a playlist item does not repeat its original jump. The saved
voice is matched across every row of a native draw (movies list translations as
rows); only a whole draw without it reports a change, and a draw of another season
(a shifted season index) reports a missing episode at once. Movie rows are also
identified by their translation text, because some providers put a release tag in
`voice_name`; several equal rows are never guessed between, and the saved voice
name is not seeded for movies (native display would rename unlabeled rows). A movie
row chosen in the source picker is reopened by its exact URL, else by its index when
the page has the same row count, each confirmed by translation/text/tag; a capture
saves only index, count and texts (never the resolver URL). Any key, click or touch
in the opened component cancels the automatic start. After the component opens,
failures and the 60-second timeout show a notice and leave the user there; only a
launch that never opened falls back to the picker. Explicit quality labels map to
heights as in the picker (`4K`/`UHD` is 2160).

External players (Android, webOS, Apple TV) receive the continuation point through
the timeline they read at launch. Their launch is captured, and the position the
native timeline records on return (within 24 hours) is captured again. Online
support for unrelated third-party components is not implemented. The integration is checked against native frontend `1992839` and
Lampac NextGen online plugin `1.9.1`; presence guards cannot guarantee arbitrary
future changes to those method contracts.

The client observes progress every 15 seconds, on pause/preferences changes and
player close. Unchanged paused playback keeps its original observation time.
Writes share one request and retry after 5, 15 and 60 seconds; a visible warning
marks failures. Foreground and profile changes refresh the owned row. The server
reports older observations as `stale` (the client then keeps the server record),
clamps a client stamp more than five minutes from its clock to its own time and
returns the stored stamp, and rejects invalid identities and oversized requests
(16 KiB, including chunked bodies). An unreadable store file is set aside as
`*.corrupt-<time>` and replaced, and at most 500 user/profile files are created. Atomic JSON files under the existing writable
`database/homelab-sync-resume/` bind retain at most 50 entries per hashed user/profile.
The updater’s database snapshot therefore includes this state.

Captured records keep their source for their own episode. Native TimeCode can
assign a new time to a stale paused player’s close, so a newer native row replaces
a captured record only when it is a later episode (or a special, or a viewing after
a dismissal); the row then shows that episode without the captured source, whose
release or voice belonged to another episode. Native progress for the captured
episode itself (another cut, a stale close) never replaces its position. Native
progress supplies historical fallback for cards never captured by the extension;
matching deletion markers remain honoured.
Audio/subtitle restoration requires the matching track to exist in that source.

## Compatibility and failure handling

Missing public client APIs or an incompatible dump shape disable this extension,
not Lampa. Network failures remain retryable; cached progress is identified as
not refreshed rather than presented as a successful synchronization.

The controlled runtime updater tests a copied module against each candidate in
an isolated canary. If compilation, script delivery or the authenticated resume read fails, it retests with the
module still mounted but disabled. A healthy core update can proceed with
`manifest.enable: false`; the existing update report identifies the disabled
extension. The manifest is changed only after the rollback snapshot. A later
update retries the enabled module and can restore it automatically.

These checks cannot guarantee arbitrary future frontend semantics. Lampa's native
frontend downloader is independent of the image updater; the JavaScript guards
check required entry points. Keep behavioral checks against the latest web client
as well. No changes or pull requests are submitted to upstream repositories.

## Initial installation and verification

The extra bind changes the supported mount layout. Initial installation needs an
idle maintenance window and a backup of the existing Compose/configuration and
application state. Provision this directory, add the read-only bind, register the
plugin, and install the matching updater and nightly wrapper before recreating
only Lampa through the root Compose project. Do not bypass an old updater's mount
or config-hash checks. Subsequent runtime updates use the normal staged workflow.
Existing clients need one reload to load the new plugin.

```bash
node --test lampa/tests/
python3 tests/lampac-optional-module-test.py
# Against a separately started, isolated synthetic canary only:
python3 tests/lampac-resume-api-test.py --container homelab-ux-check
python3 tests/lampac-update-runtime-ready-test.py
sh tests/lampac-auto-update-drift-test.sh
```

Before deployment, also compile/probe the module in an isolated container from
the actual candidate image with synthetic configuration and no production state,
then test the screen against the actual latest Lampa web client. The regression
fixtures are synthetic and contain no household viewing records.

The combined UX implementation was **deployed on 2026-11-01 after explicit
approval**. The API contract test passed against Lampac 1.87.4 in an isolated
container with synthetic state. The rollout saved the previous configuration and
all bind contents, added only the module mount, and recreated only Lampa with its
existing immutable image. Generated script/API probes, HTTPS source integrity,
health, root Compose ownership and the updater mount guard passed. The preview
worker was not restarted, and the nightly update timer was restored. Rollback
state and the operation journal remain private and outside Git. Each client
needs one reload; physical TV/iPhone PWA playback remains a device check.


The2026-11-01 startup correction explicitly waits for native app readiness in
all three bundle parts and account-sync. Actual cached browser reloads exposed
Menu/Favorite initialization races; regressions now exercise that real lifecycle
with methods present before their internal state is initialized.

Online continuation accepts the MVC wire representation of a first-season source:
`season_index: 0` can be omitted by Lampac's default-value serializer. Only a
missing index is normalized to zero; explicit invalid values are rejected. The
native folder index is never inferred from the semantic season number.
If a saved online source cannot launch or times out, continuation opens the owned
source picker with its original card, exact S/E, voice and absolute position.
The original provider remains available because a launch refusal can reflect a
loading/schema problem. If the picker is unavailable, the native full card opens.
Profile changes, another navigation or a new player suppress stale redirects.
