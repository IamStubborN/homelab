<!-- In-repo copy of the approved orchestration plan dated 2026-08-19. Body matches the source; do not rewrite locked decisions. -->
# Family Health + LLM Wiki — Execution Plan

Status: approved for orchestration  
Date: 2026-08-19  
Repo: `/Users/iamstubborn/Projects/homelab`  
Runtime host: `docker.local.iamstubborn.dev`  
After compact: treat this file as the only source of truth. Do not re-litigate locked decisions.

---

## 0. How to run this after compact

You are the **Orchestrator**. You do not implement code yourself. You walk the task DAG in section 5.

### 0.1 Roles

| Role | `spawn_subagent` | When |
|---|---|---|
| **Orchestrator** | (you) | Pick the next task, spawn roles, read review files, decide pass/fail, update todos, stop at human gates |
| **Scout** | `subagent_type: explore` if read-only repo/host; `general-purpose` + `capability_mode: read-only` if the task needs web docs | Large file research, current Hermes/health wiring, upstream MCP / Obsidian Headless / rclone Drive docs |
| **Worker** | `subagent_type: general-purpose`, description prefix `[worker]` | Implement one task only |
| **Reviewer** | `subagent_type: general-purpose`, description prefix `[reviewer]` | Review the Worker's diff against this plan and the task's Done criteria |

Prefix every spawn `description` with `[scout]`, `[worker]`, or `[reviewer]`.

### 0.2 Loop (mandatory for every implementation task)

```
for each task in DAG order:
  if task.needs_scout:
      spawn Scout → wait → read findings into Worker prompt
  spawn Worker with the task card + plan sections it needs
  wait
  LOOP:
      spawn Reviewer (resume_from previous reviewer after round 1)
      Orchestrator reads the review file
      if 0 open issues: mark task done; break
      if needs-user-input or stalemate (same issue wontfix then reopened): stop and ask the user
      resume Worker with the review file; then re-review
```

No round cap. Nits count. Worker may mark `wontfix` with a technical reason. Two disagreements on the same issue → escalate to the user.

Do **not** start the next task until the current one has Reviewer pass, unless the DAG marks two tasks as parallel.

### 0.3 Scout vs Worker

- Scout is read-only. It never edits.
- Use Scout when the Worker would otherwise guess: official MCP Python HTTP transport, `obsidian-headless` Docker/login, rclone Drive in Docker, current Hermes health tests, live host paths.
- Skip Scout when the task is local wiring already specified below (gitignore, skill text, jsonl schema).

### 0.4 Persist progress

Keep a todo list with these exact ids: `T0` … `T10`. After compact, rebuild that list from section 5 before doing anything else.

Also copy this plan into the repo on **T0** so later sessions do not depend on the session scratch path:

`health/docs/plans/2026-08-19-family-health-wiki.md`

### 0.5 Out of scope for the Orchestrator

- Do not invent Postgres, SQLite, Rust health-service features, NotebookLM CLI, or Drive bisync.
- Do not write medical advice. Ingest existing facts as stored.
- Do not commit vault contents, rclone tokens, or Obsidian credentials.
- Do not deploy to `docker.local` unless the task says so and the user is present for human gates.

---

## 1. Design (read this before any task)

### 1.1 Goal

Replace the unused Rust+Postgres `health-service` with a small Python MCP cashier that writes append-only jsonl into a family LLM wiki on the Docker host. Hermes agents use `llm-wiki` on personal trees plus a shared health section. Humans browse the same tree in Obsidian (official Obsidian Sync). Google Drive is a one-way rclone mirror, not the working copy.

This is a family knowledge system, not a second media-orchestrator.

### 1.2 Locked decisions

1. **No Postgres. No SQLite. No Rust health binary.** Facts are jsonl.
2. **Keep MCP** as the write seam. Hermes never edits `data/` or `generated/` with the terminal.
3. **Python sidecar** (same shape as `vaultwarden-broker`), official image digest pinned — not `python:latest`.
4. **Two personal wikis + one shared health tree.** Full spouse access to health; personal notes stay in that person's tree.
5. **Canonical files live on the Docker host**, gitignored / outside git. SSH-visible.
6. **Obsidian Sync** (official, via `obsidian-headless`) syncs the **entire** wiki root so laptops/phones see Andrii + Valentyna + shared.
7. **rclone container**, one-way `vault → Drive`. Never bisync. Never rsync.
8. **NotebookLM is not automated.** Optional later: point notebooks at the Drive mirror of `generated/` + selected PDFs.
9. **Actor identity is the container token**, not a model-supplied field. `person` may be overridden when the user names the other spouse.
10. **Do not delete current Google Docs/Sheet** until ingest is verified.

### 1.3 Target topology

```text
Telegram Andrii  → hermes-andrii  ─┐
Telegram Valentyna → hermes-valentyna ─┼─ HTTP MCP ─ health (Python)
                                       │
                                       └─ writes only:
                                            ${WIKI_ROOT}/shared/health/data/**/*.jsonl
                                            ${WIKI_ROOT}/shared/health/generated/*.md

${WIKI_ROOT}  (host, canonical, not in git)
  andrii/                 Hermes Andrii WIKI_PATH  (personal llm-wiki)
    SCHEMA.md index.md log.md raw/ entities/ concepts/
    shared → ../shared    bind-mount, not a copy
  valentyna/              Hermes Valentyna WIKI_PATH
    … same …
    shared → ../shared
  shared/
    health/
      SCHEMA.md index.md log.md
      data/{andrii,valentyna}/*.jsonl
      generated/*.md          MCP-owned, overwrite-safe
      people/{andrii,valentyna}/*.md
      family/
      raw/{andrii,valentyna,family}/
  .obsidian/              vault config for the parent folder

obsidian-sync container  mounts ${WIKI_ROOT}  → official Obsidian Sync
health-drive   container mounts ${WIKI_ROOT}  → rclone copy to Drive
both Hermes              mount personal dir + shared
health MCP               mounts shared/health (rw)
```

Default host path:

```text
WIKI_ROOT=/opt/data/wiki
```

Override with env if the host uses another disk. Do **not** put the live vault under the git clone. Still add `wiki/` and `/opt/data/wiki/` notes to `.gitignore` as a safety net if anyone ever creates `homelab/wiki/`.

SSH check after deploy: `ssh docker.local.iamstubborn.dev 'ls -la /opt/data/wiki'`.

Hermes runs as UID/GID `10000:10000`. The host directory must be writable by that uid. `obsidian-headless` must use the same ownership or a shared group; Scout T3 must pick a uid map that does not fight Hermes writes.

### 1.4 Data contract (cashier)

Append-only JSON Lines. One object per line. Never rewrite a previous line.

```text
shared/health/data/<person>/
  measurements.jsonl
  meals.jsonl
  symptoms.jsonl
  sleep.jsonl
  medications.jsonl
  conditions.jsonl
  allergies.jsonl
  labs.jsonl
```

Every event object:

```json
{
  "id": "uuid",
  "person": "andrii|valentyna",
  "actor": "andrii|valentyna",
  "via": "hermes_andrii|hermes_valentyna|system",
  "event_time": "RFC3339",
  "created_at": "RFC3339",
  "status": "user_reported|confirmed_by_document|confirmed_by_doctor|suspected|model_inference|historical_uncertain|resolved",
  "source_event_id": "optional-stable-transport-id:fact:N",
  "corrects": "optional-uuid",
  "...type-specific fields..."
}
```

Corrections: new line with `corrects` set to the original `id`. Readers use the latest non-deleted correction. No physical delete.

Dedup: if `source_event_id` matches an existing active row, return `outcome=duplicate` and do not append. Without `source_event_id`, exact match of `(person, type, event_time, normalized payload)` is a duplicate. Concurrent writers: one MCP process + `fcntl` lock on the target jsonl file.

After every successful write, regenerate the affected `generated/*.md` files from jsonl (deterministic templates). Hermes and NotebookLM (manual) read those files, not jsonl.

Minimum generated set (keep names stable):

- `ANDRII_CURRENT_PROFILE.md`, `VALENTYNA_CURRENT_PROFILE.md`
- `ANDRII_CURRENT_MEDICATIONS.md`, `VALENTYNA_CURRENT_MEDICATIONS.md`
- `ANDRII_RECENT_MEASUREMENTS.md`, `VALENTYNA_RECENT_MEASUREMENTS.md`
- `ANDRII_RECENT_LABS.md`, `VALENTYNA_RECENT_LABS.md`
- `ANDRII_DIET_CONTEXT.md`, `VALENTYNA_DIET_CONTEXT.md`
- `VALENTYNA_ALLERGIES.md`, `VALENTYNA_CYCLE_CONTEXT.md` (cycle page may be stub until T8)
- `FAMILY_DIET_SNAPSHOTS.md`

MCP tool names stay compatible with the current skill so Telegram behaviour does not churn:

`add_measurement`, `correct_measurement`, `add_meal`, `add_symptom`, `add_sleep_record`, `add_medication`, `stop_medication`, `add_condition`, `add_allergy`, `add_lab_result`, `query_health_data`, `generate_chart`

Charts: render PNG from jsonl (matplotlib or a tiny SVG→PNG path). Keep `MAX_CHART_DAYS` and query limits in the same order of magnitude as today's Rust service (200 rows / 3650 days).

Auth: two bearer tokens, same files as now (`health/secrets/andrii.health_api_token`, `valentyna.health_api_token`). Token → `(actor, via, default_person)`.

### 1.5 Hermes and llm-wiki

- Remove `llm-wiki` from `skills.platform_disabled.telegram` in both profiles.
- Set `WIKI_PATH` (and `OBSIDIAN_VAULT_PATH` if the bundled obsidian skill is left enabled) per container.
- Keep the official Hermes image unmodified. Mount wiki dirs; do not pip-install into the agent image.
- One shared `hermes/shared/skills/health/SKILL.md`: MCP-only for facts; wiki for synthesis; person resolution + confirmation cards unchanged.
- Personal `SCHEMA.md` must say: medical facts go through MCP + `shared/health`; do not store BP/labs as personal journal pages.
- `shared/health/SCHEMA.md` is stricter: `person` on every page, no mixing Andrii and Valentyna on one synthesis page, never edit `data/` or `generated/`.

`health-internal` stays: Hermes + health MCP only. `obsidian-sync` and `health-drive` do not need that network.

### 1.6 Obsidian Sync

One Obsidian vault = `${WIKI_ROOT}` (the parent). That is how “access to the entire LLM wiki” works: one remote vault, both people, shared health included.

Implementation: `obsidian-headless` (or current equivalent found by Scout T3) as a Compose service:

- mounts `${WIKI_ROOT}`
- official Obsidian Sync, continuous
- Watchtower off
- credentials in ignored secret files, never in the vault and never in Drive
- documented login is a **human gate** (Obsidian account + Sync subscription)

Samba share of `${WIKI_ROOT}` is a LAN fallback, not a second SoT. Do not enable Syncthing + Obsidian Sync + Drive bisync together.

If Scout finds `obsidian-headless` is abandoned or cannot run headless in this image policy, stop and ask the user before substituting Syncthing. Do not silently drop official Sync.

### 1.7 rclone (the “rsync container”)

Service `health-drive`:

- image: official `rclone/rclone` pinned by digest
- cron/loop: every 15–30 min or nightly — pick nightly unless T3 finds a reason
- `rclone copy` or `rclone sync` **from** `${WIKI_ROOT}` **to** `drive:HealthWiki/` (new English folder; do not overwrite the existing `Здоровье/` Docs)
- exclude `.obsidian/cache`, OS junk
- copy-not-delete on first rollout (`copy`); switch to `sync` only after a dry-run the user accepts
- OAuth lives in `health/secrets/rclone/` (gitignored), same ownership story as other health secrets

Existing Mac remote `healthdrive` is a laptop read tool. The server needs its own config.

### 1.8 What happens to today's health stack

| Now | After |
|---|---|
| `health-postgres` + volume `health-pg-data` | Remove from Compose. Volume is empty of medical rows (only `people`). Do not `docker volume rm` in code; document as a later operator command |
| `family-health-service:local` Rust | Delete or stop shipping. Replace with `health` Python package under `health/service` **or** `health/mcp/` — Worker T4 chooses the smaller layout and Reviewer checks it stays one module |
| MCP URL `http://health-service:8080/internal/mcp` | Same path on the new service name `health-service` (keep the container name to avoid a Hermes config flag day) or update Hermes + tests in the same task |
| `hermes/tests/test_health_integration.py` | Rewrite assertions for jsonl cashier + wiki mounts + rclone/obsidian services |

Keep token files and `health-internal` create instructions, updated for the new process.

### 1.9 First ingest (existing Drive data)

Source of truth for history today:

- `/tmp/zdorovie-export/Andrii.txt`, `Valentyna.txt`
- xlsx sheets: Andrii BP, Сон Andrii, Valentyna BP, Вес, Приём препаратов Andrii
- PDFs + prescription JPEG in Drive `Здоровье/`

Ingest is a **one-shot operator/Worker script**, not a chat hallucination:

1. Copy binaries into `shared/health/raw/...`
2. Parse sheet rows into jsonl via MCP or a trusted CLI that uses the same writer module
3. Build synthesis pages from profile sections **excluding** the garbled “журнал обновлений / хронология” (that text is already corrupted in Docs)
4. Mark lab/condition statuses honestly (`confirmed_by_document` vs `user_reported` vs `suspected`)
5. Leave Google Docs in place as archive

Do not ingest `valentyna-teeth/Data.zip` in this plan.

### 1.10 Failure modes

- Health MCP down → Hermes says the tool is missing / write failed. No silent wiki-as-ledger fallback.
- Obsidian Sync down → vault on disk and Telegram still work.
- rclone down → local vault is fine; Drive ages.
- One Hermes down → the other still writes shared health.

---

## 2. Human gates (Orchestrator must stop and ask)

These are not Worker tasks.

| Gate | When | What the user does |
|---|---|---|
| G1 Obsidian Sync account | before T7 deploy | Confirm Sync subscription; complete `ob login` in the container (or the documented equivalent) |
| G2 Server rclone OAuth | before T6 deploy | Create Drive client (rclone shared id retires in 2026) and authorize on `docker.local` |
| G3 Host directory | before first deploy | `sudo mkdir -p /opt/data/wiki && sudo chown -R 10000:10000 /opt/data/wiki` (adjust if Scout finds a different data root) |
| G4 Keep Google archive | after T8 | User confirms ingest sample before anyone deletes Docs/Sheet |
| G5 Recreate Hermes | after T5/T7 | Manual `docker compose up` — no Watchtower, no GH Actions |

---

## 3. Repo / runtime file map (expected)

Tracked:

- `health/mcp/` (or rewritten `health/service` Python) — cashier
- `health/compose.yml` — health MCP, drop postgres
- `health/README.md` — new runbook
- `health/docs/plans/2026-08-19-family-health-wiki.md` — this plan
- `health/docs/wiki-SCHEMA.example.md` — templates for personal + health SCHEMA
- `hermes/compose.yaml` — wiki mounts, `WIKI_PATH`, drop llm-wiki disable
- `hermes/profiles/*/config/config.yaml`
- `hermes/shared/skills/health/SKILL.md`
- `hermes/tests/test_health_integration.py` (+ new cashier unit tests)
- `.gitignore` — vault paths
- root `compose.yml` include stays; add obsidian-sync / health-drive either in `health/compose.yml` or `wiki/compose.yml` included from root
- `wiki/README.md` — “live vault is on the host, not here”

Ignored / host-only:

- `/opt/data/wiki/**`
- `health/secrets/**` (already)
- rclone.conf, Obsidian login store

---

## 4. Explicitly not in this plan

- Diet generation + critic pass (later, after facts flow)
- Cycle MCP type beyond a generated stub
- Reminders / weekly digest
- Apple Health
- Grafana
- NotebookLM broker / `/notebook` commands
- Web UI
- Dual-write to the old Rust DB
- Moving media/hindsight into the wiki

---

## 5. Task DAG

Execute in id order except where `parallel_with` is set. Every `T*` with `impl` uses the Worker/Reviewer loop.

### T0 — Persist the plan in-repo

- **Roles:** Worker → Reviewer  
- **Depends:** none  
- **Scout:** no  
- **Work:** Copy this plan to `health/docs/plans/2026-08-19-family-health-wiki.md`. Add a short pointer in `health/README.md` and `CLAUDE.md` (one paragraph: vault is host-side, cashier is Python MCP, no Postgres).  
- **Done:** File exists, English, no secrets, README points at it.

### T1 — Scout: current health + Hermes contracts

- **Roles:** Scout only  
- **Depends:** T0  
- **Work:** Inventory exact MCP input schemas, tests that will break, compose secret/network names, Hermes entrypoint token copy for health, UID 10000 volume pattern. Write findings under `health/docs/plans/t1-current-contract.md` (tracked, no secrets).  
- **Done:** A Worker can implement T4 without opening the Rust crate again.

### T2 — Scout: Python MCP HTTP server

- **Roles:** Scout only  
- **Depends:** T0  
- **Work:** Primary sources only: official MCP Python SDK streamable-HTTP, auth header pattern compatible with Hermes `mcp_servers.health.url` + Bearer. Recommend pinned packages. Note image digest strategy. Write `health/docs/plans/t2-mcp-python.md`.  
- **Done:** Concrete package names + a minimal server sketch the Worker can copy.

### T3 — Scout: Obsidian Headless + rclone Docker on this host

- **Roles:** Scout only  
- **Depends:** T0  
- **Work:**  
  1. Current `obsidian-headless` install, Docker, login, `sync --continuous`, vault = directory.  
  2. rclone official image, crypt-less Drive copy, config file mount, shared client_id retirement.  
  3. Host path: confirm `/opt/data` exists on `docker.local` (SSH). If not, recommend the real data root.  
  4. UID collision: Hermes 10000 vs node/rclone user.  
  Write `health/docs/plans/t3-sync-and-host.md`. If official Sync cannot run, stop the DAG at G1 and ask the user.  
- **Done:** Exact compose snippets and a host path decision.

### T4 — Python health MCP + jsonl cashier

- **Roles:** Worker → Reviewer (loop)  
- **Depends:** T1, T2  
- **Scout:** no (use T1/T2 notes)  
- **Work:** Implement the cashier: HTTP MCP, token map, tools listed in 1.4, jsonl + lock, generated markdown, PNG charts, tests (unit + temp-dir integration). No Postgres. Replace Rust workspace usage in Compose build with the Python image. Keep container name `health-service` if that is cheaper; otherwise update every reference in the same task.  
- **Done:** `pytest` (or `mise` equivalent) green locally; invalid person/status rejected; correction is append-only; duplicate `source_event_id` is a no-op; generated files refresh.

### T5 — Hermes: wiki mounts + health skill + enable llm-wiki

- **Roles:** Worker → Reviewer  
- **Depends:** T4, T3 (for mount path / uid)  
- **Work:**  
  - Bind `${WIKI_ROOT}/andrii` and `.../shared` into hermes-andrii; same for Valentyna.  
  - `WIKI_PATH=/wiki` (personal root).  
  - Remove `llm-wiki` from Telegram `platform_disabled`.  
  - Rewrite `hermes/shared/skills/health/SKILL.md` for jsonl-backed MCP + wiki synthesis rules.  
  - Update `hermes/tests/test_health_integration.py`.  
  - Seed example SCHEMA files in-repo; live SCHEMA is created on the host in T7.  
- **Done:** Tests assert wiki mounts, env, skill contract, llm-wiki enabled. Hermes image still official digest.

### T6 — rclone one-way Drive mirror

- **Roles:** Worker → Reviewer  
- **Depends:** T3  
- **parallel_with:** T4 (may proceed once T3 is done; merge carefully with T7)  
- **Work:** `health-drive` service, example rclone.conf, README auth steps (G2), exclude lists, destination `HealthWiki/`. No bisync.  
- **Done:** `docker compose config` includes the service; dry-run documented; secrets not interpolated into env.

### T7 — Obsidian Sync service + host vault bootstrap

- **Roles:** Worker → Reviewer  
- **Depends:** T3, T5  
- **Human gates:** G1, G3 before live up  
- **Work:**  
  - Compose service for official Sync against `${WIKI_ROOT}`.  
  - Bootstrap script (tracked) that creates `andrii/`, `valentyna/`, `shared/health/{data,generated,people,family,raw}` and writes initial SCHEMA/index/log from examples. Idempotent.  
  - `.gitignore` entries.  
  - `wiki/README.md` for SSH + Obsidian.  
  - Optional Samba share of `${WIKI_ROOT}` only if it does not require rewriting the existing share layout; otherwise document `sshfs`/`smb` as a follow-up.  
- **Done:** Fresh host dir + script produces a valid llm-wiki layout; Sync service is documented; vault is not in git.

### T8 — Ingest existing Здоровье data

- **Roles:** Scout (parse export + sheet columns) then Worker → Reviewer  
- **Depends:** T4, T7  
- **Human gate:** G4 after a sample  
- **Work:** One-shot ingest using the **same writer module** as MCP (not a second formatter). Sources: exported Docs + xlsx + PDFs/JPEG. Weight sheet has broken columns — Scout must map rows carefully, skip garbage, do not invent. Chronology/journal sections of Docs are not ingested as facts. Copy originals to `raw/`.  
- **Done:** jsonl counts match accepted rows; `generated/` profiles list current meds/allergies/labs; a short ingest report lists skipped/ambiguous rows for the user.

### T9 — Deploy runbook + tear down Rust/Postgres from Compose

- **Roles:** Worker → Reviewer  
- **Depends:** T5, T6, T7  
- **Human gate:** G5  
- **Work:** Update `health/README.md` deploy/rollback. Stop shipping postgres + Rust image from root compose. Document `docker volume rm health-pg-data` as a **manual** later step. `make` / `CLAUDE.md` health paragraphs. Fail-closed if wiki path missing.  
- **Done:** `docker compose config --quiet` from repo root succeeds with the new graph; runbook lists G1–G5.

### T10 — Live verification on docker.local

- **Roles:** Orchestrator + Worker (commands only) + Reviewer of logs  
- **Depends:** T8, T9, G1–G3, G5  
- **Work:** On the host: bootstrap vault, up health-service, recreate both Hermes, one read-only MCP query from each bot (or curl MCP), confirm `llm-wiki` can read SCHEMA, confirm rclone dry-run, confirm Obsidian Sync connected if G1 passed.  
- **Done:** Written verification notes in `health/docs/plans/t10-verify.md` (no medical payloads, only counts/status). No data loss vs Google archive.

---

## 6. Reviewer checklist (every impl task)

- Matches locked decisions in §1.2  
- No secrets in git  
- No SQLite/Postgres/Rust reintroduced  
- Hermes image digest unchanged  
- Tests exist for the new behaviour  
- Medical files not committed  
- Compose is still `docker compose config --quiet` clean  
- User-facing Telegram strings stay Russian; identifiers English  

---

## 7. Suggested Worker/Reviewer prompt fragments

Worker: implement only `{task id}`. Read this plan §1 and the task card. Do not start the next task. Do not deploy unless the task says so.

Reviewer: review the git diff against plan `{task id}` Done criteria and §6. Write issues as:

```
### Issue N — Severity: bug|major|minor|nit
- Section:
- Description:
- Suggestion:
- Status: open
```

If clean: `Open issues: 0`.

---

## 8. Order after compact (cheat sheet)

```
T0
T1, T2, T3          (Scouts; T1/T2/T3 parallel)
T4                  (after T1+T2)
T6                  (after T3; can overlap T4)
T5                  (after T4+T3)
T7                  (after T5; stop for G1/G3)
T9                  (after T5+T6+T7)
T8                  (after T4+T7; stop for G4)
T10                 (after T8+T9 + gates)
```
