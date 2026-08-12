# Telegram Media Card UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace noisy, static Telegram media messages with one deterministic, editable card per user intent, complete inline actions, compact and detailed views, two-step cancellation, and restart-safe state without spending LLM tokens on progress updates.

**Architecture:** Keep `media-service` authoritative for job state and business actions. Extend the existing per-profile `media-notifier` processes to own card rendering, persisted presentation state, and a signed internal control endpoint. Split the Telegram plugin into focused modules; Hermes validates the Telegram user, forwards presentation commands to the matching notifier, and invokes `hermes-media` only for confirmed business actions.

**Tech Stack:** Python 3 standard library, Hermes Telegram plugin API, Telegram Bot API inline keyboards, timestamped HMAC-SHA256, JSON state files with atomic replacement, Docker Compose, `unittest`, Web Telegram.

## Global Constraints

- Do not create another container, database, or LLM workflow.
- Keep one isolated notifier state volume and HMAC secret per profile.
- Never expose job IDs, raw provider errors, filesystem paths, tokens, or internal error codes in compact or detailed cards.
- Preserve explicit source selection. Never fall back automatically between Rezka and Prowlarr.
- Preserve completed episodes and published files during retries and recovery.
- Do not recreate `media-service`, `download-runner`, Gluetun, or qBittorrent while test downloads are active.
- Keep all Telegram callback payloads below the 64-byte Bot API limit.
- Keep rendered card text below 4,096 UTF-8 characters and inline keyboards below 100 buttons.
- Keep progress rendering deterministic and independent of Hermes or an LLM.
- Keep the existing `md:` rich-search and `ms:` source-choice callback protocols compatible with already-sent messages.
- Leave the untracked `.superpowers/` directory untouched.
- Commit only intended repository files to `main`.

---

### Task 1: Split the Telegram Plugin Without Changing Behavior

**Files:**
- Create: `shared/plugins/telegram-home/media_models.py`
- Create: `shared/plugins/telegram-home/media_action_store.py`
- Create: `shared/plugins/telegram-home/media_search.py`
- Create: `shared/plugins/telegram-home/media_callbacks.py`
- Modify: `shared/plugins/telegram-home/__init__.py`
- Modify: `tests/test_telegram_home_plugin.py`
- Modify: `tests/test_scaffold.py`

**Interfaces:**
- `media_models.py` produces immutable `SearchAction`, `RenderedSearchPart`, and `RenderedSearch`.
- `media_action_store.py` produces restart-safe `MediaActionStore`.
- `media_search.py` produces pure search JSON parsing, text rendering, and inline-keyboard packing functions.
- `media_callbacks.py` produces callback regexes and pure CLI argument builders.
- `__init__.py` retains `HomeTelegramAdapter`, `_build_adapter`, `register`, and all runtime plugin entry points.

- [ ] Update `load_plugin()` in `tests/test_telegram_home_plugin.py` so the test module is loaded as a package and relative imports work:

  ```python
  spec = importlib.util.spec_from_file_location(
      "telegram_home_test",
      PLUGIN,
      submodule_search_locations=[str(PLUGIN.parent)],
  )
  ```

- [ ] Add a structural test in `tests/test_scaffold.py` that requires the four focused modules, limits `shared/plugins/telegram-home/__init__.py` to callback routing and adapter registration, and confirms `HomeTelegramAdapter` plus `register` remain in `__init__.py`.
- [ ] Run:

  ```bash
  python3 -m unittest -q tests.test_telegram_home_plugin tests.test_scaffold
  ```

  Confirm the new package/module assertions fail before files are extracted.

- [ ] Move the existing dataclasses without changing field names or JSON shapes:

  ```python
  @dataclass(frozen=True)
  class SearchAction:
      label: str
      kind: str
      payload: dict[str, Any]
      expires_at: float

  @dataclass(frozen=True)
  class RenderedSearchPart:
      text: str
      actions: tuple[SearchAction, ...]

  @dataclass(frozen=True)
  class RenderedSearch:
      text: str
      actions: tuple[SearchAction, ...]
      parts: tuple[RenderedSearchPart, ...]
  ```

- [ ] Move `MediaActionStore` and its atomic bounded persistence helpers to `media_action_store.py`. Keep the existing `/opt/data/telegram-media-actions.json` path, maximum record count, expiry behavior, claim/release/consume semantics, and locking.
- [ ] Move pure search parsing and rendering helpers, including result splitting, button-label truncation, translation flags, Rezka episode ranges, Prowlarr rendering, and continuation creation, to `media_search.py`.
- [ ] Move callback regexes and pure argument builders to `media_callbacks.py`. Preserve the existing `ma:`, `ms:`, and `md:` callback formats byte-for-byte.
- [ ] Keep network/process execution and Telegram adapter methods in `__init__.py`; import focused helpers with relative imports.
- [ ] Re-run the focused tests and confirm every existing rich-search, deduplication, pagination, exact-argv, source-choice, and authorization test passes unchanged.
- [ ] Run a syntax smoke test with the same mount style used by Hermes; the focused plugin test above remains the executable import check:

  ```bash
  docker run --rm \
    -v "$PWD/shared/plugins:/plugins:ro" \
    python:latest \
    python -m py_compile \
      /plugins/telegram-home/__init__.py \
      /plugins/telegram-home/media_models.py \
      /plugins/telegram-home/media_action_store.py \
      /plugins/telegram-home/media_search.py \
      /plugins/telegram-home/media_callbacks.py
  ```

- [ ] Commit the behavior-preserving extraction:

  ```bash
  git add shared/plugins/telegram-home tests/test_telegram_home_plugin.py tests/test_scaffold.py
  git commit -m "refactor: split telegram media plugin"
  ```

---

### Task 2: Add Card Views and Explicit Button Rows

**Files:**
- Modify: `scripts/hermes_media_notifications.py`
- Modify: `tests/test_media_notifications.py`

**Interfaces:**
- Produces `CardView` with `compact`, `details`, and `confirm-cancel`.
- Changes `RenderedCard` to own explicit `button_rows`.
- Extends `CardState` with persisted `view` and the last validated notification payload.
- Changes `render_card(notification, view=CardView.COMPACT)` to render the requested presentation state.
- Preserves `RenderedCard.actions` as a flattened compatibility property.

- [ ] Add failing tests for all three views and exact row layout:

  ```python
  compact = module.render_card(notification, module.CardView.COMPACT)
  self.assertEqual(
      [[action.label for action in row] for row in compact.button_rows],
      [["Подробнее", "Отменить"]],
  )

  details = module.render_card(notification, module.CardView.DETAILS)
  self.assertEqual(
      [[action.label for action in row] for row in details.button_rows],
      [["Назад", "Отменить"], ["Диагностика"]],
  )
  ```

- [ ] Add failing tests proving:
  - compact view omits unknown values, job IDs, internal codes, paths, and invented HLS percentages or ETA;
  - details view includes measured episode progress, bytes, speed, quality, output dimensions, audio, subtitles, VAAPI processing, VPN attempts, and Plex destination only when present;
  - a complete season renders aggregate progress rather than one message per episode;
  - completed, cancelled, failed, partial, and storage-blocked states receive the approved action rows;
  - source-choice buttons appear in one `All | Rezka | Prowlarr` row;
  - long translation or release labels remain one button per row;
  - text stays at or below 4,096 characters and keyboards stay at or below 100 buttons.
- [ ] Add state migration tests proving version 2 and version 3 files load with `view=compact` and no cached payload, while malformed cached payloads are discarded without losing the message ID.
- [ ] Run:

  ```bash
  python3 -m unittest -q tests.test_media_notifications
  ```

  Confirm the view, row, and migration tests fail.

- [ ] Introduce the view and row models:

  ```python
  class CardView(str, Enum):
      COMPACT = "compact"
      DETAILS = "details"
      CONFIRM_CANCEL = "confirm-cancel"

  @dataclass(frozen=True)
  class RenderedCard:
      text: str
      button_rows: tuple[tuple[RenderedAction, ...], ...] = ()

      @property
      def actions(self) -> tuple[RenderedAction, ...]:
          return tuple(action for row in self.button_rows for action in row)
  ```

- [ ] Add short presentation callback helpers with a strict UUID parser:

  ```python
  def presentation_callback_data(command: str, job_id: str) -> str:
      code = {
          "expand": "e",
          "collapse": "b",
          "confirm-cancel": "c",
          "dismiss-cancel": "x",
      }[command]
      return f"mc:{code}:{job_id}"
  ```

  Assert every callback remains below 64 bytes.

- [ ] Split card rendering into pure helpers:
  - `_render_compact_card(notification)`;
  - `_render_detailed_card(notification)`;
  - `_render_cancel_confirmation(notification)`;
  - `_job_action_rows(notification, view)`;
  - `_bounded_card_text(lines)`.
- [ ] Use the following deterministic action policy:
  - active compact: `Details | Cancel`;
  - active details: `Back | Cancel`, then `Diagnostics`;
  - cancellation confirmation: `Yes, cancel | Back`;
  - failed: `Retry`, then `Choose another source | Details`;
  - partial: `Download missing`, then `Choose another source | Details`;
  - storage blocked: `Check storage again | Details`;
  - completed/cancelled: `Details`;
  - source choice: `All | Rezka | Prowlarr`.
- [ ] Keep `ma:details:<job-id>` exclusively for diagnostics. Use `mc:e:<job-id>` and `mc:b:<job-id>` for same-message presentation changes.
- [ ] Extend `CardState`:

  ```python
  @dataclass
  class CardState:
      ...
      view: CardView = CardView.COMPACT
      notification_payload: dict[str, Any] | None = None
  ```

  Persist only a deep JSON copy of a payload that has already passed `parse_notification`; revalidate it during `load_state`.

- [ ] Extend `update_card_state()` with an explicit `notification_payload` argument. The dispatcher must pass the validated webhook payload; tests that construct state directly may omit it and receive `None`.
- [ ] Change `save_state()` to write version 4, retain migration support for versions 2 and 3, and use the existing temporary-file plus `os.replace()` atomic write.
- [ ] Change card fingerprints to include row boundaries as well as callback values:

  ```python
  "button_rows": [
      [action.callback_data for action in row]
      for row in rendered.button_rows
  ]
  ```

- [ ] Normalize view transitions on lifecycle updates:
  - keep `details` through non-terminal and terminal updates;
  - keep `confirm-cancel` while a job remains cancellable;
  - reset `confirm-cancel` to `compact` when a terminal update arrives;
  - default new lifecycle cycles to `compact`.
- [ ] Re-run `python3 -m unittest -q tests.test_media_notifications` and confirm all legacy and new tests pass.
- [ ] Commit:

  ```bash
  git add scripts/hermes_media_notifications.py tests/test_media_notifications.py
  git commit -m "feat: add persistent telegram card views"
  ```

---

### Task 3: Add the Signed Notifier Control API

**Files:**
- Modify: `scripts/media-notifier`
- Modify: `scripts/hermes_media_notifications.py`
- Modify: `tests/test_media_notifier.py`
- Modify: `tests/test_media_notifications.py`

**Interfaces:**
- Adds `POST /control/card`.
- Consumes:

  ```json
  {
    "command": "expand",
    "job_id": "00000000-0000-0000-0000-000000000999",
    "message_id": "77"
  }
  ```

- Produces JSON with `status` equal to `updated` or `unchanged`.
- Uses the existing `X-Webhook-Timestamp`, `X-Webhook-Signature-V2`, and `X-Request-ID` envelope.

- [ ] Extend `FakeTelegram` so tests capture row-shaped keyboards and allow injected Telegram failures.
- [ ] Add failing dispatcher tests for:
  - compact to details;
  - details to compact;
  - compact to cancellation confirmation;
  - dismissal back to compact;
  - progress update while details is open stays detailed;
  - notifier restart reloads the selected view;
  - terminal progress exits cancellation confirmation;
  - unknown card returns 404;
  - mismatched Telegram message ID returns 409;
  - invalid command and malformed UUID return 400;
  - a Telegram edit failure returns 502 without persisting the requested view.
- [ ] Add failing HTTP tests for valid HMAC, stale timestamp, invalid signature, oversized body, repeated request ID, and a request signed with the other profile's secret.
- [ ] Run:

  ```bash
  python3 -m unittest -q tests.test_media_notifier tests.test_media_notifications
  ```

  Confirm the control-route tests fail.

- [ ] Extract one shared request-authentication helper from `_handler()`:

  ```python
  def _verify_signed_request(
      body: bytes,
      timestamp: str,
      signature: str,
      secret: bytes,
      *,
      now: int,
  ) -> bool:
      expected = hmac.new(
          secret,
          timestamp.encode("ascii", errors="ignore") + b"." + body,
          hashlib.sha256,
      ).hexdigest()
      ...
  ```

- [ ] Add a bounded persisted replay receipt list to `NotificationState` for control requests. Key each receipt by `X-Request-ID`, retain at most 1,000 values, save it in state version 4, and return HTTP 409 with `replayed_request` for a repeated receipt.
- [ ] Implement `NotificationDispatcher.control(payload, request_id)` under the existing dispatcher lock:
  1. validate the command, UUID, and numeric message ID;
  2. locate exactly one stored card whose validated cached notification has the requested job ID;
  3. require the stored Telegram message ID to match;
  4. compute the new `CardView`;
  5. render from the cached validated notification;
  6. edit Telegram first;
  7. persist view, fingerprint, callback rows, and replay receipt only after a successful edit.
- [ ] Reject a control request if the cached notification is absent or fails revalidation. Do not query `media-service` or reconstruct state from user-supplied text.
- [ ] Route requests in `_handler()`:

  ```python
  if self.path == "/webhooks/media-notify":
      status = dispatcher.deliver(payload, request_id)
  elif self.path == "/control/card":
      status = dispatcher.control(payload, request_id)
  else:
      return self._json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
  ```

- [ ] Return stable, non-sensitive response errors:
  - `invalid_body`;
  - `invalid_signature`;
  - `invalid_payload`;
  - `card_not_found`;
  - `stale_card`;
  - `telegram_unavailable`.
- [ ] Change `TelegramClient._markup`, `send`, and `edit` to consume explicit button rows:

  ```python
  "inline_keyboard": [
      [
          {"text": action.label, "callback_data": action.callback_data}
          for action in row
      ]
      for row in button_rows
  ]
  ```

- [ ] Update webhook delivery to render with the stored view and pass `rendered.button_rows` to Telegram. Preserve the existing progress throttling and completion-push deduplication.
- [ ] Re-run the focused tests and confirm they pass.
- [ ] Commit:

  ```bash
  git add scripts/media-notifier scripts/hermes_media_notifications.py tests/test_media_notifier.py tests/test_media_notifications.py
  git commit -m "feat: add notifier card control api"
  ```

---

### Task 4: Forward Presentation Callbacks Without an LLM

**Files:**
- Create: `shared/plugins/telegram-home/notifier_client.py`
- Modify: `shared/plugins/telegram-home/media_callbacks.py`
- Modify: `shared/plugins/telegram-home/__init__.py`
- Modify: `tests/test_telegram_home_plugin.py`

**Interfaces:**
- `NotifierControlClient` consumes `MEDIA_NOTIFIER_CONTROL_URL` and `WEBHOOK_SECRET_FILE`.
- `NotifierControlClient.control(command, job_id, message_id)` calls `/control/card`.
- `HomeTelegramAdapter._handle_callback_query()` routes `mc:` callbacks before any LLM or media CLI path.

- [ ] Add failing client tests that patch `urllib.request.urlopen` and assert:
  - exact `POST /control/card` URL;
  - compact JSON body;
  - numeric timestamp;
  - HMAC signature over `timestamp + "." + body`;
  - unique request ID;
  - 10-second timeout;
  - no Telegram token, media API token, or raw message text in the request.
- [ ] Add failing adapter tests for authorized and unauthorized `mc:` callbacks. Assert an authorized callback invokes only the notifier client, while `_run_media`, LLM hooks, and `reply_text` are not called.
- [ ] Add failing tests for user-facing callback acknowledgements:
  - expand: `Показываю подробности`;
  - collapse/dismiss: `Возвращаю краткий вид`;
  - confirm-cancel: `Подтвердите отмену`;
  - stale card: `Карточка устарела. Запросите текущий статус.`;
  - notifier unavailable: `Не удалось обновить карточку. Попробуйте ещё раз.`
- [ ] Run:

  ```bash
  python3 -m unittest -q tests.test_telegram_home_plugin
  ```

  Confirm the notifier-client and `mc:` routing tests fail.

- [ ] Implement the strict presentation callback parser:

  ```python
  _PRESENTATION_CALLBACK_RE = re.compile(
      r"mc:(e|b|c|x):"
      r"([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\\Z"
  )

  _PRESENTATION_COMMANDS = {
      "e": "expand",
      "b": "collapse",
      "c": "confirm-cancel",
      "x": "dismiss-cancel",
  }
  ```

- [ ] Implement `NotifierControlClient` with Python standard library only. Read the HMAC secret from `/run/secrets/webhook_hmac` by default, fail closed on an empty secret or non-HTTP internal URL, and never log the secret or complete signed headers.
- [ ] Add lazy client construction to `HomeTelegramAdapter`, mirroring the existing media action store pattern.
- [ ] Route `mc:` before `md:`, `ms:`, and `ma:`. Apply the same private-chat, chat-ID, thread-ID, and allowlisted-user authorization already used for other media callbacks.
- [ ] Require the callback's Telegram message ID in the control body. Never accept a message ID from callback data.
- [ ] Keep `ma:details:<job-id>` as the existing sanitized diagnostics action for already-sent cards. Never reinterpret it as a view change. Newly rendered same-message expansion uses only `mc:e:<job-id>`.
- [ ] Re-run the focused plugin tests and confirm all callback and search behavior passes.
- [ ] Commit:

  ```bash
  git add shared/plugins/telegram-home tests/test_telegram_home_plugin.py
  git commit -m "feat: forward telegram card presentation actions"
  ```

---

### Task 5: Implement Two-Step Cancellation and Deterministic Business Actions

**Files:**
- Modify: `shared/plugins/telegram-home/media_callbacks.py`
- Modify: `shared/plugins/telegram-home/media_action_store.py`
- Modify: `shared/plugins/telegram-home/__init__.py`
- Modify: `scripts/hermes_media_notifications.py`
- Modify: `tests/test_telegram_home_plugin.py`
- Modify: `tests/test_media_notifications.py`

**Interfaces:**
- `mc:c:<job-id>` opens confirmation.
- `mc:x:<job-id>` dismisses confirmation.
- `ma:cancel:<job-id>` is emitted only by the confirmation view and executes `hermes-media jobs cancel <job-id> --json`.
- Existing retry, retry-missing, resume-storage, diagnostics, and alternative-source actions remain media-service business actions.

- [ ] Add failing rendering tests proving compact/details cards never expose a direct `ma:cancel` callback and confirmation view exposes exactly `Yes, cancel | Back`.
- [ ] Add failing adapter tests proving:
  - first Cancel press only edits the card;
  - Back only restores the compact view;
  - Yes invokes exactly one cancel CLI command;
  - duplicate Yes callbacks do not execute cancellation twice;
  - unauthorized users cannot open or confirm cancellation;
  - a terminal or no-longer-cancellable job returns a user-friendly stale-action acknowledgement.
- [ ] Run:

  ```bash
  python3 -m unittest -q tests.test_media_notifications tests.test_telegram_home_plugin
  ```

  Confirm the two-step flow tests fail.

- [ ] Map the confirmation button to the existing strict business callback:

  ```python
  RenderedAction("Да, отменить", callback_data("cancel", notification.media.job_id))
  RenderedAction(
      "Назад",
      presentation_callback_data("dismiss-cancel", notification.media.job_id),
  )
  ```

- [ ] Keep the existing `MediaActionStore` single-use semantics for search downloads and add a restart-safe `BusinessActionReceiptStore` in `media_action_store.py`. Persist it atomically at `/opt/data/telegram-media-business-actions.json`, bound it to 500 receipts, and key claims by callback data plus Telegram message ID. Release a claim on transient execution failure and consume it after success so repeated or concurrent callbacks cannot execute the command twice.
- [ ] Render business actions from the authoritative `notification.actions` list only. Never add Retry, Download missing, Resume, or Cancel when media-service did not advertise it.
- [ ] Keep action labels user-facing:
  - `Повторить`;
  - `Докачать недостающее`;
  - `Проверить место`;
  - `Выбрать другой источник`;
  - `Диагностика`.
- [ ] On a successful cancel command, acknowledge `Отменяю загрузку…` and let the next media-service webhook update the notifier-owned card. Do not create a second status message.
- [ ] On a failed business command, answer the callback with a bounded user-facing explanation and leave the current card intact.
- [ ] Re-run the focused tests and confirm they pass.
- [ ] Commit:

  ```bash
  git add shared/plugins/telegram-home scripts/hermes_media_notifications.py tests/test_telegram_home_plugin.py tests/test_media_notifications.py
  git commit -m "feat: add safe telegram media actions"
  ```

---

### Task 6: Complete the Card, Tracking, and Recovery Matrix

**Files:**
- Modify: `scripts/hermes_media_notifications.py`
- Modify: `shared/plugins/telegram-home/media_search.py`
- Modify: `shared/plugins/telegram-home/__init__.py`
- Modify: `shared/skills/media/SKILL.md`
- Modify: `tests/test_media_notifications.py`
- Modify: `tests/test_media_notifier.py`
- Modify: `tests/test_telegram_home_plugin.py`
- Modify: `tests/test_media_skill.py`

**Interfaces:**
- Produces one compact card plus deterministic actions for every supported lifecycle state.
- Preserves notify-only and automatic-download tracking as two explicit modes.
- Keeps conversational Hermes output secondary to notifier-owned cards.

- [ ] Add a table-driven test covering all supported states and expected primary actions:

  | State | Expected first action |
  |---|---|
  | queued/downloading/processing/publishing | Details |
  | failed | Retry |
  | partial | Download missing |
  | needs-action with storage issue | Check storage |
  | completed/cancelled | Details |

- [ ] Add season aggregation tests for:
  - 0 of 12;
  - 7 of 12 with episode 8 active;
  - 11 of 12 with episode 12 missing;
  - 12 of 12 completed;
  - retry after a failed episode preserves completed count.
- [ ] Add provider-specific truthfulness tests:
  - Rezka may show transfer bytes and speed without percentage/ETA;
  - Prowlarr may show torrent size and percentage only when qBittorrent reports them;
  - VAAPI upscale appears only when structured processing state confirms it;
  - source-advertised 1080p is not presented as probed 1080p;
  - subtitle absence is not an error;
  - partial subtitles identify downloaded and missing track counts.
- [ ] Add recovery tests for connection attempt `5 of 20`, VPN rotation pending, retry exhaustion, expired search results, blocked storage, partial publication, and failed Plex import. Assert raw codes and IDs are absent outside Diagnostics.
- [ ] Add notify-only tracking tests proving one source-choice card is sent with `All | Rezka | Prowlarr` and no download job is created.
- [ ] Add automatic-download tracking tests proving the card begins at `New episode found`, advances in place through download and Plex, uses the configured source policy, and emits exactly one completion push.
- [ ] Add family/personal ownership tests proving personal tracking updates one profile and family tracking is delivered independently to both notifier endpoints without shared message IDs.
- [ ] Run:

  ```bash
  python3 -m unittest -q \
    tests.test_media_notifications \
    tests.test_media_notifier \
    tests.test_telegram_home_plugin \
    tests.test_media_skill
  ```

  Confirm the matrix tests fail before renderer and copy changes.

- [ ] Implement bounded compact copy that follows this shape when values exist:

  ```text
  ⬇️ Магия и мускулы · Сезон 1
  📺 7 из 12 серий
  🎙 AniLibria · Rezka
  📦 Серия 8 · 186 МБ · 5,2 МБ/с
  🔄 Скачивание
  ```

- [ ] Implement detailed sections in this order:
  1. episode progress;
  2. transfer measurements;
  3. advertised and probed quality;
  4. video/audio/subtitles;
  5. VAAPI or original processing;
  6. connection attempt and VPN rotation;
  7. Plex destination and preserved/missing artifacts;
  8. safe issue explanation and recommended next action.
- [ ] Keep Diagnostics as a separate `ma:details` business callback that replies with sanitized bounded CLI output. It must not edit the compact/details card or reveal secrets.
- [ ] Ensure search cards expose every translation/release action, preserve one long action per row, add continuation buttons when available, and split text before Telegram limits without dropping associated buttons.
- [ ] Update `shared/skills/media/SKILL.md`:
  - Hermes must not repeat notifier-owned progress cards;
  - Hermes may explain a requested diagnostic result;
  - buttons are generated by structured code, never by `<telegram-quick-replies>`;
  - source choices always contain All, Rezka, and Prowlarr;
  - automatic tracking downloads use the stored explicit source policy;
  - provider failure never triggers automatic fallback.
- [ ] Re-run the focused tests and confirm they pass.
- [ ] Commit:

  ```bash
  git add scripts shared/plugins/telegram-home shared/skills/media tests
  git commit -m "feat: complete telegram media card lifecycle"
  ```

---

### Task 7: Wire Per-Profile Control URLs and Document Operations

**Files:**
- Modify: `compose.yaml`
- Modify: `README.md`
- Modify: `tests/test_scaffold.py`

**Interfaces:**
- `hermes-andrii` receives `MEDIA_NOTIFIER_CONTROL_URL=http://media-notifier-andrii:8644`.
- `hermes-valentyna` receives `MEDIA_NOTIFIER_CONTROL_URL=http://media-notifier-valentyna:8644`.
- Both Hermes containers reuse their own mounted `/run/secrets/webhook_hmac`.
- No notifier port is published to the host.

- [ ] Add failing Compose tests proving:
  - each Hermes profile points only to its own notifier;
  - each Hermes profile and notifier share the matching HMAC secret;
  - notifier ports are internal only;
  - notifier state volumes remain separate;
  - Valentyna cannot address Andrii's notifier through configuration;
  - no new service is introduced.
- [ ] Add a failing README contract test or explicit string assertions for the internal control endpoint, profile isolation, same-message card behavior, and operational recovery.
- [ ] Run:

  ```bash
  python3 -m unittest -q tests.test_scaffold
  ```

  Confirm the new Compose wiring tests fail.

- [ ] Add these environment values:

  ```yaml
  hermes-andrii:
    environment:
      MEDIA_NOTIFIER_CONTROL_URL: http://media-notifier-andrii:8644

  hermes-valentyna:
    environment:
      MEDIA_NOTIFIER_CONTROL_URL: http://media-notifier-valentyna:8644
  ```

- [ ] Add healthy notifier dependencies without coupling profile startup to the other profile:

  ```yaml
  hermes-andrii:
    depends_on:
      media-notifier-andrii:
        condition: service_healthy

  hermes-valentyna:
    depends_on:
      media-notifier-valentyna:
        condition: service_healthy
  ```

- [ ] Document:
  - compact/detail/back behavior;
  - one card per movie, episode, or season;
  - final push budget;
  - two-step cancellation;
  - notifier state location and restart behavior;
  - HMAC and replay protection;
  - safe manual health and control checks;
  - rollback by reverting the deployment commit and recreating only Hermes/notifiers.
- [ ] Re-run `python3 -m unittest -q tests.test_scaffold` and confirm it passes.
- [ ] Validate Compose without printing secrets:

  ```bash
  docker compose config --quiet
  ```

- [ ] Commit:

  ```bash
  git add compose.yaml README.md tests/test_scaffold.py
  git commit -m "ops: wire telegram notifier controls"
  ```

---

### Task 8: Verify, Push, Deploy, and Exercise Web Telegram

**Files:**
- Modify if verification finds a confirmed defect: only files listed in Tasks 1-7
- Do not modify: `.superpowers/`

**Interfaces:**
- Verifies the complete local and deployed contract.
- Deploys only `media-notifier-andrii`, `media-notifier-valentyna`, `hermes-andrii`, and `hermes-valentyna`.

- [ ] Confirm no active media job is in a stage that would be disrupted:

  ```bash
  ssh docker.local.iamstubborn.dev \
    'docker exec hermes-andrii /usr/local/bin/hermes-media jobs list --json'
  ```

  If downloads are active, continue local verification and defer container recreation until they finish. Do not cancel user jobs.

- [ ] Run the complete local suite:

  ```bash
  ./scripts/check
  ```

- [ ] Run focused syntax/import checks:

  ```bash
  python3 -m py_compile \
    scripts/media-notifier \
    scripts/hermes_media_notifications.py \
    shared/plugins/telegram-home/__init__.py \
    shared/plugins/telegram-home/media_models.py \
    shared/plugins/telegram-home/media_action_store.py \
    shared/plugins/telegram-home/media_search.py \
    shared/plugins/telegram-home/media_callbacks.py \
    shared/plugins/telegram-home/notifier_client.py
  ```

- [ ] Run the media-service notification integration test from `/Users/iamstubborn/Projects/personal/media-orchestrator`:

  ```bash
  cargo test -p media-storage --features integration-tests \
    --test orchestration_repository \
    detailed_notification_projects_retry_recovery_and_terminal_actions
  ```

- [ ] Review the final diff for accidental secrets, IDs, paths, placeholders, and unrelated changes:

  ```bash
  git diff --check
  git status --short
  rg -n 'TODO|TBD|telegram-quick-replies|execution_failed|Job ID|🆔 Job' \
    scripts shared tests README.md compose.yaml
  ```

  Every remaining match must be an intentional test fixture, diagnostics-only code path, or explicit prohibition.

- [ ] Push the completed `main` history:

  ```bash
  git push origin main
  ```

- [ ] Fast-forward the deployed checkout and verify the exact commit:

  ```bash
  ssh docker.local.iamstubborn.dev \
    'cd /home/iamstubborn/hermes-home && git pull --ff-only origin main && git rev-parse HEAD'
  ```

- [ ] Recreate only the presentation services:

  ```bash
  ssh docker.local.iamstubborn.dev \
    'cd /home/iamstubborn/hermes-home && docker compose up -d --no-deps --force-recreate media-notifier-andrii media-notifier-valentyna hermes-andrii hermes-valentyna'
  ```

- [ ] Verify all four containers are healthy and the internal endpoints are not host-published:

  ```bash
  ssh docker.local.iamstubborn.dev \
    'docker inspect --format "{{.Name}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}" media-notifier-andrii media-notifier-valentyna hermes-andrii hermes-valentyna'
  ```

  ```bash
  ssh docker.local.iamstubborn.dev \
    'docker port media-notifier-andrii; docker port media-notifier-valentyna'
  ```

  The first command must report running/healthy. The second must print no published ports.

- [ ] Verify each Hermes container resolves only its configured notifier URL and receives a healthy response:

  ```bash
  ssh docker.local.iamstubborn.dev \
    'docker exec hermes-andrii python3 -c "import urllib.request; print(urllib.request.urlopen(\"http://media-notifier-andrii:8644/health\", timeout=3).read().decode())"'
  ```

  ```bash
  ssh docker.local.iamstubborn.dev \
    'docker exec hermes-valentyna python3 -c "import urllib.request; print(urllib.request.urlopen(\"http://media-notifier-valentyna:8644/health\", timeout=3).read().decode())"'
  ```

- [ ] Use Chrome control with the existing authorized Web Telegram session and test an Andrii source-choice card:
  1. trigger or reuse a notify-only tracked episode;
  2. confirm one row contains `All`, `Rezka`, and `Prowlarr`;
  3. press `All`;
  4. confirm each provider result retains all translation/release buttons;
  5. confirm no literal `<telegram-quick-replies>` markup appears.
- [ ] Start one small, disposable single-episode Rezka job through a direct translation button. Verify:
  - one compact job card appears;
  - progress edits the same Telegram message;
  - `Details` edits that message;
  - a later progress update remains detailed;
  - `Back` restores compact view;
  - `Cancel` opens confirmation;
  - `Back` dismisses confirmation without cancelling.
- [ ] Reopen cancellation confirmation and press `Yes, cancel`. Verify exactly one cancel request, one cancelled card, no duplicate progress message, and no staging artifact after cleanup.
- [ ] Start a second small disposable episode and allow it to complete. Verify:
  - compact stage changes remain in one card;
  - measured fields are truthful;
  - Rezka VAAPI processing is shown only after confirmation;
  - the final card names Plex publication;
  - exactly one short completion push replies to that card.
- [ ] If Prowlarr is available, choose one harmless small result, verify a direct release button creates one job, and cancel it before content transfer completes. If Prowlarr is unavailable, verify the Rezka results remain usable and the card reports only the Prowlarr failure.
- [ ] Restart `media-notifier-andrii` while the test card is in detailed view, send one subsequent job update, and verify the same message remains detailed after restart.
- [ ] Inspect notifier and Hermes logs for the test interval:

  ```bash
  ssh docker.local.iamstubborn.dev \
    'docker logs --since 30m media-notifier-andrii 2>&1; docker logs --since 30m hermes-andrii 2>&1'
  ```

  Confirm there are no invalid signatures, replay false positives, Telegram edit loops, duplicate callbacks, raw secrets, or cross-profile requests.

- [ ] Cancel any remaining test jobs and verify no staging artifacts remain. Do not delete published user media.
- [ ] If live verification required a fix, repeat the affected focused test, `./scripts/check`, commit, push, fast-forward the host, recreate only the affected Hermes/notifier services, and repeat the failed Web Telegram scenario.
- [ ] Record the deployed commit and final verification evidence in the implementation handoff.

---

## Plan Self-Review Checklist

- [x] Every requirement in `docs/superpowers/specs/2026-07-27-telegram-media-card-ux-design.md` maps to at least one task and verification step.
- [x] Every created or modified file has an exact path.
- [x] Every new interface has a concrete request, response, model, or callback shape.
- [x] Every behavior change starts with a failing test and an exact test command.
- [x] No step asks an implementer to invent unspecified copy, policy, error handling, or persistence behavior.
- [x] Compact/details state survives notifier restart and later progress events.
- [x] Cancellation is two-step and business actions remain media-service-owned.
- [x] Profile isolation, HMAC validation, replay protection, callback authorization, Telegram limits, and deduplication are tested.
- [x] Search, tracking, progress, recovery, completion, source choice, and diagnostics are covered.
- [x] Deployment does not interrupt user downloads or recreate media infrastructure.
- [x] Verification includes Web Telegram, one cancellation, one completion, cleanup, logs, and exact deployed commit evidence.
