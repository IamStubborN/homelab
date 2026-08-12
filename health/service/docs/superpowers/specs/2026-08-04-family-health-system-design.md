# Family Health System — Design

Date: 2026-08-04
Status: approved umbrella architecture; phase 1 is implemented in this repository

## 1. Goal

A family health-tracking system for two people, Andrii and Valentyna. Both spouses
interact through their existing personal Hermes agents (Telegram). The system stores
the complete health history — measurements, labs, medications, conditions, allergies,
symptoms, meals, sleep, cycle, documents — in a structured database, keeps a full
readable backup in Google Drive, feeds NotebookLM with always-fresh sources, and
(in later phases) generates diets with a multi-step critical validation pass.

Both spouses and both Hermes agents have full access to both profiles. Profile
separation exists to prevent AI mistakes (profile mixing, wrong-person writes),
not to restrict the spouses.

## 2. Context

Existing infrastructure this design builds on:

- `homelab/hermes`: two isolated Hermes profiles (`hermes-andrii`,
  `hermes-valentyna`) already deployed on the homelab, each with its own Telegram
  bot, skills installed from profile sources, and secrets isolated per profile.
- `homelab`: the canonical repository and Compose project on
  `docker.local.iamstubborn.dev`; already runs
  `media-service` (Rust + MCP + Postgres pattern), `traefik`, `firecrawl`, `searxng`,
  `samba`, `glance`, `watchtower`, `vaultwarden`.
- `media-orchestrator`: Rust workspace whose service/MCP/auth/CI patterns are the
  template for the new service.
- Google AI Plus: Drive, Docs, Sheets, Gemini, NotebookLM available to both spouses.
- Current Drive folder `Здоровье/` is small (2 profile Docs, 1 diary Sheet, 1 lab
  PDF, 1 prescription photo) — it becomes the first ingest batch, not a migration
  problem.

## 3. Decisions (agreed 2026-08-04)

1. **Source of truth: local PostgreSQL from day one.** Google Sheets/Docs are
   generated views only. No source-of-truth migration later.
2. **Core: Rust `health-service` exposing MCP**, following the `media-service`
   pattern. The service owns the database; Hermes agents are clients.
3. **Repository layout (superseded 2026-08-12).** The original design selected a
   new `family-health` repository for the service, with Hermes skills/config in
   `hermes-home` and the compose stack in `homelab`. The canonical one-repository
   decision now keeps the service workspace in `homelab/health/service`, its
   Compose stack in `homelab/health/compose.yml`, and Hermes skills/config in
   `homelab/hermes`.
4. **Everything backs up to Google Drive in plain readable form** — originals,
   generated reports/profiles, and database dumps (SQL + per-table CSV). Nothing
   is stored encrypted-only; recovery must be possible from Drive alone.
5. **NotebookLM has two layers**: (a) reliable — auto-refreshed snapshot documents
   connected once by the spouses as Drive sources; (b) non-critical automation —
   an unofficial-CLI broker that auto-adds new files as sources and serves
   `/notebook` commands. If the broker breaks, only layer (b) degrades.
6. **All sync processes run in Docker containers** (rclone, broker, backups) — no
   host-level cron jobs or host rclone installs.
7. **Drive is semantically bidirectional, but implemented as one-way flows plus
   reconciliation** — never `rclone bisync`. A file manually added anywhere under
   the system's Drive root enters the system; deletions require confirmation.
8. **All folders and files the system creates are named in English** (Drive tree
   root `Health/`, snapshot documents, reports, dumps). Russian appears only in
   user-facing Telegram text and in pre-existing user files, which keep their
   original names.

## 4. Architecture

```text
Telegram Andrii ──→ hermes-andrii ─┐
                                   ├─→ health-service (Rust, MCP) ─→ health-postgres
Telegram Valentyna → hermes-valentyna ─┘        │
                                                ├─→ original files (homelab volume)
                                                │
                    one-way Google flows        │
                    ┌───────────────────────────┤
                    │ push: originals, reports, │ pull: full-tree scan,
                    │ profile Docs, SQL/CSV     │ new-file ingest,
                    │ dumps, snapshot docs      │ deletion reconciliation
                    ↓                           │
               Google Drive ←───────────────────┘
                    ↓ (connected once, manually)
               NotebookLM Andrii / Valentyna / Family
```

### Containers (homelab, new `health/` stack)

| Container | Role |
|---|---|
| `health-service` | Rust; owns DB and file store; MCP endpoint + internal REST |
| `health-postgres` | dedicated Postgres — independent from `media-postgres` so medical data has its own backup/restore lifecycle |
| `health-drive-sync` | rclone in Docker; scheduled one-way push and pull jobs |
| `health-notebooklm` | broker wrapping the unofficial NotebookLM CLI; queue-driven; non-critical |

Watchtower does not manage these containers; deployment is manual from the operator
workstation, matching the `homelab/hermes` deployment policy.

### Repository layout (`homelab`)

- Rust workspace under `homelab/health/service` (`crates/health-service`,
  `crates/health-core`, and `crates/health-migration`).
- `mise` as the only dev entry point (`check` / `lint` / `test` / `test-integration`),
  mirroring `media-orchestrator`.
- `homelab/health/service/docs/superpowers/specs|plans` for design docs and plans
  (this file).

## 5. Data model (Postgres)

Entity tables: `people`, `measurements`, `labs`, `medications`, `conditions`,
`allergies`, `symptoms`, `meals`, `sleep`, `cycle`, `doctor_visits`, `documents`.
Service tables: `corrections`, `audit_log`, `notebook_sources`, `notebook_queue`,
`inbox_queue`, `reminders` (check-in and medication schedules, delivery/response
log — medication reminders double as an adherence history).

Rules that apply to every record:

- Mandatory fields: `person_id` (`andrii | valentyna`), `actor`, `via`
  (`hermes_andrii | hermes_valentyna | system`), `event_time`, `created_at`,
  `status`. Timestamps are `timestamptz`; display timezone `Europe/Kyiv`.
- Fact status enum: `confirmed_by_doctor | confirmed_by_document | user_reported |
  suspected | model_inference | historical_uncertain | resolved`. AI inference is
  never written as a confirmed diagnosis.
- Corrections are append-only: the original value is preserved in `corrections`
  (old value, new value, reason, actor, via, timestamp); the entity row holds the
  current value.
- Deletion is soft only (`deleted_at`); the API has no physical DELETE.
- Every mutating operation writes an `audit_log` row: actor, via, target person,
  action, event date, entry date, result, old/new values, source.
- Deduplication before insert: SHA-256 for files;
  `hash(person_id + event_type + event_time + normalized_values + attachment_hash)`
  for events. An identical existing record makes the insert a no-op reported back
  to the caller.
- Labs store value, unit, reference range, flag, laboratory, and a link to the
  source document.

## 6. MCP operations

Typed operations only — Hermes never edits files or SQL directly:

```text
add_measurement, correct_measurement, add_lab_result, add_symptom, add_meal,
add_sleep_record, add_cycle_record, add_medication, stop_medication,
add_condition, add_allergy, attach_document, move_document,
query_health_data, generate_chart, generate_report, update_current_profile,
set_reminder, list_reminders, cancel_reminder,
list_notebook_sources, add_notebook_source, remove_notebook_source,
query_notebook, generate_diet, validate_diet
```

(`generate_diet` / `validate_diet` and notebook operations arrive in their phases;
the operation names are reserved now so skills stay stable.)

### Person resolution

- Each profile token maps server-side to its owner and `default_person`
  (Andrii's token → `default_person = andrii`, etc.). No model-supplied identity
  field is accepted — same rule as `media-service`.
- An explicit name in the request always overrides the default.
- If the target person cannot be determined reliably, the service returns
  `needs_clarification`; Hermes asks "Это относится к Andrii или Valentyna?" and
  nothing is written.

### Confirmation-required actions

Immediate writes: routine measurements, weight, sleep, meals, symptoms, activity.
Explicit user confirmation required for: record deletion, notebook source removal,
diagnosis changes, medication/dosage changes, lab-result corrections, low-confidence
photo/PDF extraction, bulk changes, moving data between profiles.

## 7. Google Drive flows (all in Docker)

### Push (one-way, homelab → Drive, ~15 min schedule + on-demand)

Mirrors to `Drive/Health/`: original documents (organized per person), generated
profile Docs and reports, snapshot documents for NotebookLM, and backups. Push uses
copy semantics with a registry — it never deletes unknown Drive files.

### Pull + full-tree reconciliation (~5 min schedule)

- `00_Inbox/` (per-person subfolders + `Unassigned/`) is the explicit inbox:
  files are moved into the processing queue.
- Additionally the entire `Drive/Health/` tree is scanned; any file whose SHA-256
  is unknown to the `documents` registry is ingested regardless of location — a
  manually added file works in the full pipeline.
- A moved/renamed known file (same hash, new path) updates the registry path; it is
  not re-ingested.
- A registered file missing from Drive is never auto-deleted on homelab: the owner
  is asked via Telegram to choose soft-delete or restore-to-Drive.
- Generated artifacts (profiles, reports, snapshots) are system-owned: manual edits
  to them are overwritten on regeneration; data changes go through Telegram.

Ingest pipeline (phase 2): `new file → determine person → determine type → hash →
dedup check → Hermes extracts data → confirmation if needed → typed operations →
original moved to permanent folder → profile updated → notebook_queue entry`.
Statuses: `NEW | PROCESSING | WAITING_CONFIRMATION | COMMITTED | FAILED | QUARANTINED`.
Unrecognized files go to quarantine and the owner is asked in Telegram.

### Backup (nightly)

`pg_dump` (SQL) plus per-table CSV exports, pushed readable to Drive. Recovery from
Drive alone must be possible: originals + SQL dump = full restore.

## 8. NotebookLM

Three notebooks: **Andrii Health**, **Valentyna Health**, **Family Health**
(compact current snapshots of both people, shared menu/recipes/products — not the
full medical history of either person).

**Layer 1 — reliable.** `health-service` regenerates snapshot documents from the
database (`ANDRII_CURRENT_PROFILE`, `ANDRII_DIET_CONTEXT`, `ANDRII_CURRENT_MEDICATIONS`,
`ANDRII_RECENT_LABS`, `VALENTYNA_*` incl. `ALLERGIES` and `CYCLE_CONTEXT`,
`FAMILY_DIET_SNAPSHOTS`, `AVAILABLE_PRODUCTS`, `APPROVED_RECIPES`,
`CURRENT_MEAL_PLAN`, `SHARED_NUTRITION_RULES`) and pushes them to Drive. The spouses
connect them once as Drive sources; content stays fresh.

**Layer 2 — non-critical automation.** Committing a new document enqueues a
`notebook_queue` row (target notebook derived from person/type). The
`health-notebooklm` broker consumes the queue via the unofficial CLI and also serves
Hermes commands: `/notebook list | sources <nb> | add <nb> <file> | remove <nb> <src> |
ask <nb> <question>`. The specific CLI is a pluggable adapter chosen during
implementation planning. Broker failure only pauses layer 2: the queue accumulates
and drains after recovery; nothing else depends on it. Source removal requires user
confirmation.

## 9. Hermes skills (`homelab/hermes`)

One shared health skill under `homelab/hermes/shared/skills/health` is installed
into both profiles (no per-profile copies). It documents the MCP operations,
person-resolution and confirmation rules, and the extraction discipline: LLM work
(reading PDFs/photos, parsing free-form messages) happens in Hermes; the service
stays deterministic. Profile differences are env only: `HEALTH_DEFAULT_PERSON`,
the per-profile health API token (delivered via the existing `/run` private-secrets
mechanism). The MCP endpoint is discovered on the internal Docker network
(`health-service:8080/internal/mcp`), same as `media_admin`.

### Telegram UX (in scope)

- **Card-based confirmations.** Every write that needs review is a Telegram card
  with buttons (`✅ Записать / ✏️ Исправить / 🚫 Отмена`); person ambiguity is
  resolved with an `Andrii / Valentyna` button pair. Reuses the card pattern from
  `telegram-media-card-ux` in `homelab/hermes`.
- **Voice input.** Voice messages are transcribed by Hermes and flow into the same
  parse → typed operation → confirmation-card pipeline as text.
- **Charts in chat.** `generate_chart` renders a PNG server-side (weight, blood
  pressure, sleep, any measurement series over a period) and Hermes sends it in the
  chat. Charts are the primary trend view; no web UI is required for this.
- **Reminders & check-ins.** `health-service` runs the schedules (`reminders`
  table): morning check-in (pressure/weight), evening check-in (sleep, meals,
  symptoms), per-medication reminders with a `принято` button. Delivery goes
  through the deterministic per-profile notifier pattern already used by
  `media-notifier-*`; responses flow back through normal Hermes parsing. Missed
  responses are recorded, not nagged more than once.
- **Weekly digest.** A scheduled Sunday-evening summary to both spouses: trends,
  what was logged and what was missed, medication adherence, weight-goal progress.
  Built on `generate_report` and delivered like a reminder.

## 10. Diets (phase 4, design summary)

The multi-step process from the handoff is kept:

1. Fact extraction from the database (diagnoses, allergies, medications, recent
   labs, current symptoms, today's meals, weight/calorie goal, available products).
2. Menu generation (Hermes).
3. Adversarial critique pass — a separate request instructed to find every reason
   the menu may be unsuitable; no auto-agreement.
4. Persist only after the critique passes.

Answers use graded statuses (`подходит | подходит с ограничением | сейчас лучше не
стоит | противопоказано по зафиксированным данным | недостаточно данных | нужно
согласовать с врачом`) with explicit reasoning. Shared meals: intersect both
people's constraints, one common base, per-person portions and substitutions.

## 11. Failure modes

- Postgres down → Hermes reports the write failed; no silent loss, no local queues
  pretending success.
- Drive unreachable → push/pull retry with backoff; homelab data is unaffected.
- NotebookLM CLI broken → only layer 2 degrades; queue drains later.
- Unrecognized inbox file → quarantine + Telegram question to the owner.
- Low extraction confidence → `WAITING_CONFIRMATION`, never a silent commit.

## 12. Security

- Separate Telegram tokens and per-profile health API tokens; server-side
  token→owner mapping.
- No secrets in Google Drive, ever (no `99_System` secrets folder in Drive).
- Secrets live in the homelab secrets mechanism already used by the stacks;
  runtime copies use the `/run` private-directory pattern from `homelab/hermes`.
- Logs never contain full tokens.
- Soft deletes only; Drive backup is the second full copy of all data.
- rclone's Google OAuth credentials are mounted into `health-drive-sync` only.

## 13. Testing & acceptance

Unit tests plus integration tests against Docker Postgres
(`mise run test-integration`, as in `media-orchestrator`).

Phase 1–2 acceptance (from the handoff, items 1–8, 13–14):

1. Andrii sends his bot his blood pressure → it lands in Andrii's profile.
2. Valentyna sends her bot her blood pressure → it lands in her profile.
3. Valentyna sends Andrii's blood pressure → it lands in Andrii's profile.
4. Andrii can add Valentyna's data.
5. A device photo is stored and linked to its measurement.
6. Re-sending the same file creates no duplicate.
7. A recognition error is corrected without losing history.
8. A new lab PDF is stored, parsed, and added to the database.
9. Every action records `actor`, `via`, and target person.
10. Data keeps being recorded when the NotebookLM CLI is down.

Notebook/diet scenarios (handoff items 9–12) are accepted with phases 3–5.

## 14. Phases

Each phase gets its own spec → plan → implementation cycle; this document is the
umbrella architecture.

1. **Core**: `health-service` + Postgres + MCP write/read operations + shared
   Hermes skill + measurement/meal/symptom scenarios end-to-end via Telegram,
   including confirmation cards, voice input, and `generate_chart` PNGs in chat.
2. **Document ingest + reminders**: Telegram files + Drive inbox + full-tree
   reconciliation + quarantine; import of the current `Здоровье/` folder as the
   first batch. Reminder/check-in schedules and medication reminders go live here
   (notifier-pattern delivery).
3. **Google showcase**: push mirror, generated profile Docs and reports, nightly
   readable dumps, snapshot documents (NotebookLM layer 1), weekly digest.
4. **Diets**: generation, multi-step validation, shared meals.
5. **NotebookLM broker**: queue-driven source automation + `/notebook` commands
   (layer 2, non-critical).

Deferred candidates recorded for later phases: threshold alerts, one-command
doctor report (PDF), shopping-list checklists, Apple Health import
(Health Auto Export → REST), read-only Glance/web dashboard.

## 15. Out of scope (for now)

- Google Sheets as a maintained view (readable CSV dumps + generated Docs cover it;
  can be added later if the spouses miss spreadsheets).
- Web UI / Grafana dashboards.
- Any GitHub Actions deployment of household agents (policy: manual deploys).
- Official NotebookLM API (none exists; revisit if Google ships one).
