# Telegram Media Card UX Design

## Goal

Make Telegram the primary, predictable media workflow surface without relying
on an LLM for progress updates or action generation.

The design must:

- reduce notification noise;
- minimize manual text input;
- expose useful media and download details without overwhelming the compact
  view;
- keep actions deterministic and safe;
- preserve the explicit Rezka/Prowlarr source policy;
- work independently for Andrii and Valentyna.

## Existing Components

This design extends the deployed services. It does not introduce another
container.

- `media-service` owns jobs, tracking, progress, errors, and allowed actions.
- `media-notifier-andrii` owns Andrii's Telegram media messages.
- `media-notifier-valentyna` owns Valentyna's Telegram media messages.
- Hermes receives Telegram callbacks and executes media commands without an
  LLM round trip.
- `download-runner` performs downloads and processing but does not own
  Telegram presentation.

## Message Model

### One card per user intent

- A movie download has one card.
- A single episode download has one card.
- A complete season has one shared card with aggregate episode progress.
- Separate seasons or separate releases have separate cards.
- Retry and recovery update the existing card.
- Search creates a temporary selection card. It stops changing after a
  download action is accepted.

### Notification budget

Progress and lifecycle transitions edit the existing card. They do not create
new Telegram messages.

A successful job produces:

1. one editable job card;
2. one short completion push after the card reaches its final state.

Errors and user choices remain in the job card. A separate push is allowed only
when user attention is required and the card edit alone would not generate a
Telegram notification.

## Card Views

### Compact view

The compact view is optimized for scanning:

```text
⬇️ Mashle · Season 1
📺 7 of 12 episodes
🎙 AniLibria · Rezka
📦 Episode 8 · 186 MB · 5.2 MB/s
🔄 Downloading
```

It contains:

- media title and season or episode identity;
- completed and total episode count;
- selected provider and translation or release;
- current episode transfer summary when available;
- current user-facing stage.

Unknown values are omitted. A missing HLS total must not produce an invented
percentage or ETA.

### Detailed view

`Details` edits the same Telegram message. `Back` restores its compact view.

The detailed view may include:

- current and completed episodes;
- downloaded size, total size, speed, and ETA when measured;
- advertised source quality and probed output resolution;
- video, audio, and subtitle metadata;
- processing mode, including VAAPI upscale for Rezka;
- connection attempt and VPN rotation state;
- Plex publication destination;
- preserved files and missing artifacts;
- user-facing error explanation and recommended next action.

Internal job IDs, raw provider errors, paths, tokens, and internal error codes
remain hidden. They are available only through a separate `Diagnostics` action.

The selected compact or detailed mode survives notifier restarts and subsequent
progress updates.

## Button Layout

Buttons are generated deterministically from structured state. The LLM may
explain a result conversationally, but it does not invent callbacks, labels, or
allowed actions.

Layout rules:

- `All | Rezka | Prowlarr` share one row.
- Short related actions use at most two buttons per row.
- Long translation and release labels use one row each.
- The recommended action appears first.
- Active cards end with `Details | Cancel`.
- Completed cards keep `Details`.
- Diagnostic actions are visually secondary.

Search responses remain bounded by Telegram's message and keyboard limits.
Every visible translation or release retains its corresponding action. Large
responses are split without losing buttons.

## Action Matrix

### Source choice

- `All`
- `Rezka`
- `Prowlarr`

`All` searches both providers independently. One provider failure does not hide
the other provider's results. There is no automatic source fallback.

### Search results

Rezka:

- one direct download button per translation;
- `Show more` when a continuation exists.

Prowlarr:

- one direct download button per release;
- `Show more` when a continuation exists.

Download selection is single-use and restart-safe. A repeated callback cannot
create another job.

### Active job

- `Details`
- `Cancel`

`Cancel` is destructive and therefore uses an inline confirmation state:

- `Confirm cancellation`
- `Yes, cancel`
- `Back`

The confirmation edits the same card. It does not create a new message.

### Failed job

- `Retry`
- `Choose another source`
- `Details`

### Partial job

- `Download missing`
- `Choose another source`
- `Details`

### Storage blocked

- `Check storage again`
- `Details`

### Completed or cancelled job

- `Details`

## Tracking

Tracking has two explicit modes.

### Notify only

When a new episode appears, Telegram receives a source-choice card with:

- the series and episode identity;
- `All`, `Rezka`, and `Prowlarr`.

### Automatic download

The tracking record contains the selected source and translation or release
policy. When an episode appears:

- a job card is created immediately;
- the card starts with `New episode found`;
- the same card advances through search, download, processing, and Plex;
- one short completion push is sent after success;
- provider failure does not trigger an automatic fallback.

Personal tracking notifies its owner. Family tracking notifies both profiles.

## Error and Recovery UX

Errors update the current card and preserve completed work:

```text
⚠️ Download paused
🎬 Mashle · Episode 8
✅ Episodes 1–7 are ready
❗ The CDN is temporarily not transferring video
➡️ Retry or choose another source
```

Rules:

- completed episodes and published files remain visible;
- retry downloads only missing or invalid artifacts;
- connection attempts and VPN rotations update inside the card;
- exhausted retries expose recovery actions;
- an expired search result offers `Search again`;
- partial results list what succeeded and what remains;
- raw diagnostics remain behind `Diagnostics`;
- the system never silently switches between Rezka and Prowlarr.

## Notifier Control API

The existing media notifier gains an internal control API. Hermes forwards
presentation callbacks to the notifier rather than editing notifier-owned
cards independently.

Supported presentation commands:

- `expand`;
- `collapse`;
- `confirm-cancel`;
- `dismiss-cancel`.

The notifier:

- validates the command and card ownership;
- persists view state in its existing state store;
- edits the Telegram message;
- retains the selected view during later progress updates;
- keeps Andrii and Valentyna state isolated.

The control endpoint is reachable only on the internal Docker network. Requests
use timestamped HMAC authentication and bounded request bodies. Replays,
unknown commands, unknown cards, and cross-profile requests are rejected.

Business actions such as cancel, retry, and download continue to use
media-service. The notifier control API owns presentation state only.

## Code Boundaries

The current Telegram plugin is split into focused modules:

- callback routing and authorization;
- media command actions;
- search-card rendering and callback storage;
- notifier control client.

`media-notifier` remains responsible for:

- Telegram message creation and editing;
- compact and detailed rendering;
- card view persistence;
- completion and attention pushes;
- presentation control authentication.

The media-service contract remains the authoritative source for job state and
allowed business actions.

## Verification

Automated coverage must include:

- every job state and action matrix row;
- compact and detailed rendering;
- `compact -> details -> progress update -> details -> back`;
- two-step cancellation and cancellation dismissal;
- repeated and concurrent callback deduplication;
- restart-safe callback and view state;
- HMAC validation, replay rejection, and cross-profile isolation;
- Telegram message and keyboard limits;
- exact Rezka and Prowlarr CLI contracts;
- notify-only and automatic-download tracking;
- completion push deduplication;
- omission of unknown progress values and internal identifiers.

Live Web Telegram verification must cover:

- source choice;
- Rezka translation selection;
- Prowlarr release selection when the provider is available;
- single episode;
- complete season;
- detailed view persistence during progress;
- cancellation confirmation;
- partial or failed recovery;
- completion card and single final push.

Test jobs must be cancelled after verification and leave no staging artifacts.

## Out of Scope

- automatic Rezka/Prowlarr fallback;
- LLM-generated buttons or progress text;
- deletion of published Plex media;
- redesigning media-service job orchestration;
- adding another notifier container or presentation database.
