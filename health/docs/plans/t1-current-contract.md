# T1 — Current Family Health MCP / Hermes contract

Status: scout findings for T4  
Date: 2026-08-19  
Repo: `/Users/iamstubborn/Projects/homelab`  
Plan: `health/docs/plans/2026-08-19-family-health-wiki.md` (locked; this file does not re-litigate it)

There is **no** `MCP_SCHEMA.json` (or equivalent snapshot) under `health/`. The live schema is the rmcp `#[tool]` / `schemars` structs in `health/service/crates/health-service/src/mcp.rs` plus the skill table in `hermes/shared/skills/health/SKILL.md`.

A T4 Worker can implement the Python cashier from this document without opening the Rust crate. Postgres / `audit_log` / in-place UPDATE semantics below are **today’s** behaviour; the locked plan replaces storage with append-only jsonl. Call out every place T4 **must not** copy Postgres mutation.

---

## 1. Topology (names T4 must keep unless updating every reference in the same task)

| Item | Current value |
| --- | --- |
| Container name | `health-service` |
| Compose service name | `health-service` |
| Image | `family-health-service:local` (build context `health/service`) |
| Listen | `HEALTH_LISTEN_ADDR` default `0.0.0.0:8080`; Compose sets that explicitly |
| MCP URL (Hermes env) | `http://health-service:8080/internal/mcp` |
| MCP path | `POST /internal/mcp` (rmcp streamable HTTP, `json_response: true`) |
| Healthcheck path | `GET /healthz` → `200` body `ok` (unauthenticated) |
| Docker healthcheck | `CMD /usr/local/bin/health-service healthcheck` (loopback `GET /healthz` on the configured port) |
| Network | external `health-internal` (`Internal=true` + `Attachable=true` required; runbook fails closed) |
| Who joins `health-internal` | `health-service`, `health-postgres` (today), `hermes-andrii`, `hermes-valentyna` |
| Postgres (today only) | service `health-postgres`, volume `health-pg-data` (external), image `postgres:17.5-alpine@sha256:6567…` |
| Root include | `compose.yml` → `health/compose.yml` |

Streamable-HTTP host allowlist (rmcp rejects other `Host` headers):

- `health-service`, `health-service:{port}`
- `localhost`, `localhost:{port}`
- `127.0.0.1`, `127.0.0.1:{port}`

Compose hardening today: `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, `read_only: true`, `pids_limit: 128`, `tmpfs: /tmp` 32m, `expose: ["8080"]` (no published host port), Watchtower `enable: "false"`.

There is **no** `user:` in `health/compose.yml`. The image drops to UID/GID **10001:10001** (`Dockerfile` `groupadd`/`useradd` + `USER 10001:10001`). Hermes is **10000:10000** (see §8).

---

## 2. Auth and secrets (no values)

### Token → context

Bearer is the **only** identity. Models cannot supply `actor` / `via`. `person` on a tool is the clinical subject and may name the other spouse.

| Secret file on host | Compose secret name | health-service env | Container path |
| --- | --- | --- | --- |
| `health/secrets/andrii.health_api_token` | `andrii_health_api_token` | `HEALTH_TOKEN_FILE_ANDRII` | `/run/secrets/andrii_health_api_token` |
| `health/secrets/valentyna.health_api_token` | `valentyna_health_api_token` | `HEALTH_TOKEN_FILE_VALENTYNA` | `/run/secrets/valentyna_health_api_token` |

Hermes **reuses the same host files**:

```yaml
# hermes/compose.yaml
andrii_health_api_token:
  file: ../health/secrets/andrii.health_api_token
valentyna_health_api_token:
  file: ../health/secrets/valentyna.health_api_token
```

Mounted into each Hermes service as target `health_api_token` → `/run/secrets/health_api_token`.

Mapping implemented in `TokenMap::resolve`:

| Token file | `actor` | `via` | `default_person` |
| --- | --- | --- | --- |
| Andrii | `andrii` | `hermes_andrii` | `andrii` |
| Valentyna | `valentyna` | `hermes_valentyna` | `valentyna` |

`via=system` exists on the enum but is **never** assigned from a bearer.

Rules:

- Tokens are trimmed; empty / missing file is a startup error.
- Identical Andrii/Valentyna tokens is a startup error.
- Byte rules: length 1–512, every byte in `0x21..=0x7e` (printable ASCII, no space).
- HTTP: exactly one `Authorization` header; scheme `bearer` case-insensitive; unknown/malformed → **401** `"unauthorized"` and **must not echo the secret**.
- `/healthz` is **not** behind auth; `/internal/mcp` is.

Postgres-only secrets T4 will drop (do not keep in the Python image):

- `health/secrets/health_pg_bootstrap_password` (root `0:0` mode `400`)
- `health/secrets/health_service_db_password` (UID `10001`, same password as bootstrap)

Runbook ownership for **API tokens** today: `10001:10001` mode `400` so the Rust process can read them. Hermes copies the same bytes to `/run/hermes-home-secrets/health_api_token` as `10000:10000` mode `0400`. After T4, if the cashier runs as a different UID, update host `install -o` accordingly; **filenames stay the same**.

---

## 3. Enums (exact strings)

`serde` / `FromStr` are snake_case. Invalid strings fail MCP parse as `invalid {field}: {value}`.

**`person`:** `andrii` | `valentyna`

**`via` (stored, not a tool argument):** `hermes_andrii` | `hermes_valentyna` | `system`

**`status` (`FactStatus`):**

- `confirmed_by_doctor`
- `confirmed_by_document`
- `user_reported` ← **default** when omitted
- `suspected`
- `model_inference`
- `historical_uncertain`
- `resolved`

Skill rule (agent, not server): never set status above `user_reported` unless the user cites a doctor or document.

**`kind` (`MeasurementKind`):** `blood_pressure` | `weight` | `pulse` | `temperature` | `spo2` | `glucose`

**Query `section` allowlist** (unknown → storage reject `unknown section: …`):

| `section` | Behaviour |
| --- | --- |
| `medications` | **Current** (unstopped, not deleted) meds only; fields `id`, `name`, `dose`, `schedule`, `started_at` |
| `blood_pressure`, `weight`, `pulse`, `temperature`, `spo2`, `glucose` | Latest `limit` measurement points, **oldest-first**; objects `{event_time, values}` |
| `measurements`, `meals`, `symptoms`, `sleep`, `conditions`, `allergies`, `labs` | Recent rows, **newest-first**, full stored object minus `deleted_at` / `dedup_hash` |

Note: query section `sleep` ≠ hash event type `sleep_record`.

---

## 4. MCP tools — names, fields, required, outcomes

Transport: JSON-RPC over streamable HTTP. Hermes profile:

```yaml
health:
  url: ${HEALTH_MCP_URL}
  lazy: true
  headers:
    Authorization: "Bearer ${HEALTH_API_TOKEN_FILE}"
  tools:
    resources: false
    prompts: false
```

`${HEALTH_API_TOKEN_FILE}` is replaced at container start from the copied secret file (never from `HEALTH_API_TOKEN` env). `${HEALTH_MCP_URL}` stays as Compose env interpolation.

All input structs use `#[serde(deny_unknown_fields)]`. `tools/list` asserts `inputSchema.additionalProperties == false`. Extra fields (e.g. `person_id`) are a **tool error**, not a 401, and **must not write**.

Times: RFC 3339 (`OffsetDateTime`). Dates: `YYYY-MM-DD`. `person` omitted → `ctx.default_person`. `status` omitted → `user_reported`. `event_time` omitted on routine writes → `now_utc()`.

`source_event_id` (optional on the four routine event tools): 1–200 printable ASCII bytes without spaces; else `invalid source_event_id: must be 1-200 printable ASCII bytes without spaces`.

### Tool list

Exact `tools/list` names (sorted as the HTTP test expects):

`add_allergy`, `add_condition`, `add_lab_result`, `add_meal`, `add_measurement`, `add_medication`, `add_sleep_record`, `add_symptom`, `correct_measurement`, `generate_chart`, `query_health_data`, `stop_medication`

| Tool | Description (rmcp) | Required | Optional | Success structured content |
| --- | --- | --- | --- | --- |
| `add_measurement` | Record a typed health measurement. | `kind: string`, `values: JSON` | `person`, `source: string`, `status`, `event_time`, `source_event_id` | `{outcome: "created", id}` or `{outcome: "duplicate", existing_id}` |
| `correct_measurement` | Correct a measurement after explicit user confirmation. | `measurement_id: uuid-string`, `new_values: JSON`, `reason: string` | `confirmed: bool` | `{outcome: "updated", id}` |
| `add_meal` | Record a meal. | `description: string` | `person`, `items: JSON`, `calories: i32`, `status`, `event_time`, `source_event_id` | created / duplicate |
| `add_symptom` | Record a symptom. | `description: string` | `person`, `severity: i32`, `status`, `event_time`, `source_event_id` | created / duplicate |
| `add_sleep_record` | Record a sleep interval. | `start_time`, `end_time` (RFC3339) | `person`, `quality: i32`, `notes`, `status`, `source_event_id` | created / duplicate |
| `add_medication` | Add a medication after explicit user confirmation. | `name: string` | `person`, `dose`, `schedule`, `started_at`, `status`, `confirmed` | created / duplicate (no server dedup today) |
| `stop_medication` | Stop a medication after explicit user confirmation. | `medication_id: uuid-string` | `person`, `stopped_at`, `reason`, `confirmed` | `{outcome: "updated", id}` |
| `add_condition` | Record a health condition. | `name: string` | `person`, `notes`, `diagnosed_at: date`, `status`, `confirmed` | created |
| `add_allergy` | Record an allergy. | `allergen: string` | `person`, `reaction`, `severity: string` (free text), `status` | created |
| `add_lab_result` | Record a laboratory result. | `test_date: date`, `test_name: string`, `value: f64` | `person`, `unit`, `reference_min/max: f64`, `flag`, `laboratory`, `source_document`, `status` | created / duplicate |
| `query_health_data` | Query recent health rows or a measurement series. | `section: string` | `person`, `limit: u32`, `from`, `to` (RFC3339) | `{rows: [...]}` |
| `generate_chart` | Render a measurement series as a PNG chart. | `kind: string` | `person`, `days: u32`, `title: string` | **not** structured JSON: MCP image content `type=image`, `mimeType=image/png`, `data` = standard base64 |

`source_event_id` JSON-schema description (must stay if the skill/tests keep asserting it) on `add_measurement`, `add_meal`, `add_symptom`, `add_sleep_record`:

> Stable transport source identity plus a deterministic per-fact ordinal.

Labs / meds / conditions / allergies **do not** take `source_event_id` today.

### Confirmation gate (server)

`confirmed` must be JSON `true` for:

- `add_medication`
- `stop_medication`
- `add_condition`
- `correct_measurement`

`None` or `false` → tool error text **exactly**:

```text
confirmation_required: ask the user to confirm with the ✅ card, then retry with confirmed=true
```

No write. Hermes skill shows native clarify `✅ Записать / ✏️ Исправить / 🚫 Отмена` first and only then calls with `confirmed=true`.

### Person resolution (server)

`person.unwrap_or(ctx.default_person)`. Either token may write either person. Concurrent MCP calls with different bearers stay isolated (Andrii token + omitted person → Andrii row).

### Validation of `values` (`add_measurement` / `correct_measurement`)

Unknown keys rejected. Integer fields reject floats.

| kind | object fields | ranges | unit |
| --- | --- | --- | --- |
| `blood_pressure` | `systolic` (req int), `diastolic` (req int), `pulse` (optional int) | sys 50–300, dia 30–200, pulse 20–250 | — |
| `weight` | `value` (number), optional `unit` | 20–400 | if present: exactly `kg` |
| `pulse` | `value` (int) | 20–250 | — |
| `temperature` | `value` (number), optional `unit` | 34.0–43.0 | if present: exactly `c` |
| `spo2` | `value` (int) | 50–100 | — |
| `glucose` | `value` (number), optional `unit` | 1.0–40.0 | if present: exactly `mmol_l` |

Correction validates `new_values` against the **existing row’s kind**. Full object replace (skill: never send `{value:83}` for BP).

### Other server checks

- Sleep: `end_time` must be **strictly after** `start_time` → `invalid end_time: must be after start_time`.
- Symptom `severity` / sleep `quality`: DB CHECK 1–10 today; ops does **not** pre-validate (invalid ints fail at insert).
- Stop medication: not found / already stopped → `not found`; `stopped_at < started_at` → `rejected: stopped_at must not be before started_at`. Person filter is the resolved `person` (default owner unless overridden).
- Query `limit` default **20**, max **200** → `invalid limit: maximum is 200` (checked before storage).
- Chart `days` default **30**, max **3650** → `invalid days: maximum is 3650`.
- Query `from`/`to` are inclusive. Measurement-kind sections default `from` = Unix epoch, `to` = now. Conditions without `diagnosed_at` use UTC date of `created_at`. Allergies filter on `created_at`. Labs filter on `test_date` vs UTC date of `from`/`to`.
- Medications **query** hides stopped rows even though `recent_in_range("medications")` would include them; ops special-cases the section.

---

## 5. Dedup and correction — as implemented today vs T4 jsonl

### Dedup (today)

Routine tools hash into a unique `dedup_hash` (`ON CONFLICT DO NOTHING` → `outcome=duplicate` **without** treating it as an MCP error).

If `source_event_id` is present (measurements, meals, symptoms, sleep):

```text
SHA256("source-event-v1" + 0x1f + person + 0x1f + event_type + 0x1f + source_event_id)
```

Payload and timestamp are **ignored**. Retry with the same id and different values returns the **original** row. Different ordinals (`:fact:1` vs `:fact:2`) are independent. Same id on a **different event_type** (symptom vs meal) or **different person** is not a duplicate.

If `source_event_id` is absent:

```text
SHA256(person + 0x1f + event_type + 0x1f + unix_timestamp_seconds + 0x1f + canonical_json(normalized) + 0x1f + optional_attachment_hex)
```

Timestamp is **unix seconds** (Kyiv vs UTC same instant collide). JSON key order does not matter (`serde_json` BTree map). Nanoseconds within the same second collapse. Attachment is unused (always `None`).

Normalized payloads:

| Type | `event_type` | Hash payload |
| --- | --- | --- |
| measurement | kind string | full `values` object |
| meal | `meal` | `{description, calories}` — **`items` ignored** |
| symptom | `symptom` | `{description, severity}` |
| sleep | `sleep_record` | `{start, end}` as UTC RFC3339; hash time = `start_time`; **quality/notes ignored** |
| lab | `lab_result` | `{test_name, test_date, value}`; time = `test_date` midnight UTC; **unit/flag/lab ignored**; **no `source_event_id`** |

**No server dedup** for medications, conditions, allergies.

Canonical no-source weight hash used as a lock-in test vector:

- person `andrii`, type `weight`, time `2026-08-04 14:30 +03:00`, values `{"value": 120.5}`
- SHA256 hex `ad5b15733dfdc8e4b49038c5dc839c179b87f752ae4d4a5cb4bb6b453b12eb4e`

T4 plan wording: duplicate `source_event_id` among **active** (non-corrected) rows → `outcome=duplicate` and do not append; without it, exact `(person, type, event_time, normalized payload)`. Concurrent writers: one process + `fcntl` on the jsonl file.

### Correction (today — do not copy)

Today `correct_measurement`:

1. Requires `confirmed=true`.
2. `SELECT … FOR UPDATE` the live row (`deleted_at IS NULL`).
3. Inserts a `corrections` row (`old_value` / `new_value` / `reason`).
4. **`UPDATE measurements SET values_json = new_values`** in place (same `id`, **same `dedup_hash`**).
5. Re-adding the original values still returns `duplicate` of that id.
6. Missing id → `not found`.
7. MCP success `{outcome: "updated", id}`.

Locked T4 behaviour: **never rewrite a previous jsonl line**. New object with `corrects` = original `id`. Readers use the latest non-deleted correction. MCP tool name/args stay `correct_measurement`. Preserve confirmation + full `new_values` replace. `outcome=updated` vs a new `created` id is a T4 choice; Hermes skill only needs a successful correction after ✅.

Stop medication today is also an in-place UPDATE (`stopped_at`, `stop_reason`). T4 should append a stop/correction event rather than mutate.

---

## 6. Chart contract

- Tool: `generate_chart`.
- Args: `person?`, `kind` (MeasurementKind), `days?` (default 30, max 3650), `title?` (default `"{person} — {kind}"`).
- Window: `now_utc - days` … `now_utc`.
- Series: latest **2000** points (`MAX_CHART_POINTS`), then chronological oldest-first.
- **PNG in the MCP response**, not a filesystem path. Base64 in `ContentBlock::image`, mime `image/png`. Skill: send that PNG to Telegram.
- Empty series → error `measurement series is empty`.
- Size 900×500 RGB, DejaVu Sans (vendored `health/service/assets/DejaVuSans.ttf`).
- BP: two series `systolic` (red) + `diastolic` (blue). Other kinds: field `value`.
- X labels: Europe/Kyiv `DD.MM` (DST-aware).
- Cyrillic titles must render (test: `"Андрей — давление, 30 дней"`).
- T4 may switch to matplotlib; keep PNG + mime + args + limits in the same order of magnitude.

---

## 7. Hermes wiring T4/T5 must not break accidentally

### Compose (`hermes/compose.yaml`)

Both `hermes-andrii` and `hermes-valentyna`:

- `HEALTH_MCP_URL: http://health-service:8080/internal/mcp`
- `HEALTH_DEFAULT_PERSON: andrii` / `valentyna`
- networks include `health-internal` (external, name `health-internal`)
- secret `{profile}_health_api_token` → target `health_api_token`
- `HERMES_UID` / `HERMES_GID`: `"10000"`
- official image digest currently `nousresearch/hermes-agent@sha256:1eafbbd7357ef92265ab2ba3e11edd0ff550b36bd7a1643ca88a142d5a4d4f8f`
- Watchtower `enable: "false"` on Hermes services
- shared skills volume: `./shared/skills` → `/etc/hermes-home/skills:ro`

Hermes services do **not** set Compose `user:`; they rely on image + `HERMES_UID/GID`. `vaultwarden-broker-andrii` **does** set `user: "10000:10000"`.

### Entrypoint (`hermes/scripts/hermes-home-entrypoint`)

- `unset HEALTH_API_TOKEN` immediately (must never export it).
- Copies Docker secrets into `/run/hermes-home-secrets` with `install -o 10000 -g 10000 -m 0400` for: `media_api_token health_api_token broker_api_token webhook_hmac search_ladder_api_key`.
- `materialize_hermes_config` merges managed profile YAML, **sanitizes** persistent `mcp_servers.health.headers`, writes runtime config `0600` owned by 10000 containing the Bearer, symlinks `/opt/data/config.yaml` → runtime file. Persistent base must not keep the bearer across restarts.
- Invalid health secret: fail without printing it; delete legacy unsanitized `config.yaml` first.
- Skill install catalog **currently in the script**: `shared_skills="health home-assistant media search-ladder"` plus tombstones `media-admin movies series trending watching`.
- **Mismatch:** `hermes/tests/test_health_integration.py` still asserts `["health", "home-assistant", "media", "web-research"]`. T5 must pick one; do not silently drop `health`.

### Config merge (`hermes/scripts/merge_hermes_config.py`)

- Path `mcp_servers.health` is **replaced wholesale** from the managed profile (stale `transport`/`command`/`tools.include` discarded).
- Token loaded from file (same 1–512 printable-ASCII rules). Env `HEALTH_API_TOKEN` is ignored.
- Output mode `0600`. Failures return exit 2 with empty stdout/stderr.

### Skill (`hermes/shared/skills/health/SKILL.md`)

MCP-only (`mcp_health_*` discovered tools). No terminal/HTTP/SQL. Russian UX, English tool args. Person default = bot owner; explicit name wins; ambiguous → clarify Andrii/Valentyna. Routine facts write immediately; meds/conditions/corrections need the three-button card. `source_event_id` = stable transport id + `:fact:N`. Agent-side verbatim-repeat preflight via `query_health_data` (not a substitute for server dedup). Chart: send PNG. Duplicate: tell the user, do not retry.

### `llm-wiki`

Both profiles currently list `llm-wiki` under `skills.platform_disabled.telegram`. **T5** removes it. T4 does not touch profiles except if a URL/container rename is unavoidable.

---

## 8. UID map

| Process | UID:GID | Notes |
| --- | --- | --- |
| Hermes gateway | `10000:10000` | env `HERMES_UID/GID`; secrets copied to that owner; named volumes `/opt/data` |
| vaultwarden-broker-andrii | `10000:10000` | Compose `user:` |
| health-service (Rust today) | `10001:10001` | image `USER`; host token files `install -o 10001` |
| health-postgres | image default | bootstrap password file `0:0` |

Wiki vault (plan) is `chown 10000:10000`. If T4’s Python process stays 10001, it cannot write `/opt/data/wiki/shared/health` without a shared group. Prefer running the cashier as **10000:10000** (or a shared group with Hermes) so jsonl + `generated/*.md` + PNG (if ever written to disk) are Hermes-readable. Do **not** make the wiki world-writable.

---

## 9. Tests that will break — inventory and assertions to preserve or replace

### `hermes/tests/test_health_integration.py` (T5 rewrites; T4 Dockerfile/README changes already fail some of these)

**`HEALTH_TOOLS` set** — keep exact names unless skill+server change together.

`EmbeddedHealthComposeTests`:

- Both Hermes services: `HEALTH_MCP_URL == http://health-service:8080/internal/mcp`, `HEALTH_DEFAULT_PERSON == profile`, network `health-internal`, secret `{profile}_health_api_token` → `health_api_token`, shared skills volume ro, Watchtower false, **pinned Hermes image digest**.
- Root compose: `health-service`, `hermes-andrii`, `hermes-valentyna` all on `health-internal`.
- Hermes and health Compose secrets resolve to the **same** files `health/secrets/{profile}.health_api_token`.
- Profiles `_config_version == 34`.
- **Postgres runbook strings** (will die at T9, currently asserted): `docker compose up --wait health-postgres` before `pg_dump`; unique `health_restore_verify_…` DB; `set -eu` / `umask 077` / `install -d -m 0700 health/backups`; fail-closed network (`Internal=true` and `Attachable=true`); no in-place rollback / `family-health-service:rollback`.
- **Dockerfile cargo-chef clean** of `health-core` / `health-migration` / `health-service` and `health/service/scripts/test-docker-cache.sh` — **T4 replacing the Rust image will fail this test**. Update in T4 if the Dockerfile is rewritten, or land T5 in the same PR.
- Entrypoint: `health_api_token` in the copy loop; `install -o 10000 -g 10000 -m 0400`; `unset HEALTH_API_TOKEN`; runtime path `"$runtime_secret_dir/health_api_token"`; sanitize/install-fail/invalid-secret probes (no bearer in persistent yaml, no leak on stdout/stderr).
- Skill catalog split assertion currently `web-research` vs live `search-ladder` (see §7).

`EmbeddedHealthConfigTests`:

- `--sanitize-health` strips `headers` from `mcp_servers.health`.
- Generated health server **exactly**:

```python
{
    "url": "${HEALTH_MCP_URL}",
    "lazy": True,
    "headers": {"Authorization": f"Bearer {secret}"},
    "tools": {"resources": False, "prompts": False},
}
```

- Invalid secret / failed atomic replace: exit 2, empty stdio, no leftover private temp.

`EmbeddedHealthSkillContractTests` — string locks on SKILL.md (person clarify, confirmation card, duplicate/voice/PNG/status/Russian, worked examples including BP `values={systolic,diastolic,pulse}`, weight `unit:"kg"`, `generate_chart(kind=weight, days=30)`, `source_event_id` / `:fact:1`, agent preflight). Preserve these unless T5 rewrites the skill for wiki synthesis (plan still wants MCP-only facts + same confirmation cards).

### `hermes/tests/test_scaffold.py` (health-adjacent)

- Each Hermes profile secrets include `{profile}_health_api_token`.
- `HERMES_UID/GID == 10000`; entrypoint copy loop includes `health_api_token`.

### Rust unit tests (crate dies with T4; **re-implement as pytest**)

| File | What it asserts |
| --- | --- |
| `health-core/src/types.rs` | person/status/kind snake_case round-trip; unknown person fails |
| `health-core/src/values.rs` | ranges, extra keys, integer-vs-float, optional units `kg`/`c`/`mmol_l` |
| `health-core/src/dedup.rs` | deterministic hash, key-order independence, TZ normalize, canonical hex, source-id namespace |
| `health-service/src/auth.rs` | token trim, map to actor/via/default_person, reject unknown/identical/empty/whitespace/non-ascii/>512 |
| `health-service/src/config.rs` | listen default `0.0.0.0:8080`; healthcheck loopback; token file env names |
| `health-service/src/ops.rs` | `source_event_id` charset/length |
| `health-service/src/charts.rs` + `lib.rs` | PNG magic `89 50 4E 47 0D 0A 1A 0A`; empty series error; single-point visible; BP + Cyrillic title; Kyiv labels `29.03` / `25.10` across DST |
| `tests/http.rs` | `/healthz` unauthenticated `ok`; MCP 401 no secret echo; **exact 12 tool names**; `additionalProperties: false`; `source_event_id` description; Host `localhost:{port}` allowed |
| `tests/healthcheck.rs` | HTTP 200 vs 503 |
| `tests/postgres.rs` (feature `integration-tests`) | behavioural suite below |

`postgres.rs` behaviours T4 should keep as **jsonl/tempdir** tests (drop SQL/audit/migration-only cases):

- Default person/status/event_time from token + now; explicit overrides work.
- Invalid measurement values do not write.
- Meds / stop / condition / correction require `confirmed=true` with the exact error string.
- Sleep end ≤ start rejected before write.
- Query medications = current only (stopped excluded).
- Inclusive `from`/`to` on every section listed in §3.
- Measurement-kind query: limit applies to **latest** N, returned oldest-first.
- `limit=201` / `days=u32::MAX` fail **before** storage: `invalid limit: maximum is 200`, `invalid days: maximum is 3650`.
- MCP `stop_medication` → `{outcome: "updated", id}`.
- Concurrent different tokens do not mix `default_person`.
- Unknown field `person_id` is a tool error and writes nothing.
- Same `source_event_id` + changed payload = duplicate of original; different ids/types/persons create; no-source same unix second = duplicate.
- Per-fact ordinals from one message both create; retry `:fact:1` duplicates first.
- MCP duplicate is **non-error JSON** `{outcome: "duplicate", existing_id}`; chart content is PNG.
- Identical measurement/meal/sleep/lab (normalized) duplicate; concurrent identical create-once.
- Correction: readers see new values; T4: original jsonl line remains; latest correction wins.
- Unknown correction id → not found.
- Series/query omit deleted/superseded facts; recent meals newest-first.
- Unknown query section rejected.

Runner today: `health/service/scripts/test-integration.sh` (ephemeral Postgres 17.5 on `127.0.0.1:54329`, `cargo nextest -p health-service --features integration-tests`). T4: `pytest` against a temp dir.

---

## 10. Compose build today (for T4 replacement)

`health/compose.yml` `health-service.build.context: ./service` → `health/service/Dockerfile`:

- chef/planner/builder on `rust:1.97.0-bookworm@sha256:7d07…`
- runtime `debian:bookworm-slim@sha256:60ea…`
- `USER 10001:10001`
- binary `/usr/local/bin/health-service`
- `EXPOSE 8080`

Depends on `health-postgres` healthy. Env: `HEALTH_DB_*`, token files, `HEALTH_LISTEN_ADDR`, `RUST_LOG=info`.

T4: drop postgres service from this file (T9 may be the Compose teardown; plan T4 already “replace Rust workspace usage in Compose build with the Python image”). Keep `container_name: health-service`, port 8080, `/internal/mcp`, `/healthz`, `health-internal`, token secret names.

---

## 11. T4 must preserve (checklist)

1. **MCP URL** `http://health-service:8080/internal/mcp` (or rename container **and** Hermes env + tests in the same task).
2. **Container name** `health-service` if cheaper.
3. **Bearer files** `health/secrets/andrii.health_api_token` and `valentyna.health_api_token`; token → `(actor, via, default_person)` as in §2. No model-supplied identity. Identical tokens fail closed. 401 on bad auth without echoing secrets.
4. **Exact tool names** in §4; `deny_unknown_fields`; RFC3339 times; `YYYY-MM-DD` dates.
5. **Write outcomes** `created` / `duplicate` (non-error); stop (and today’s correct) use `updated`. Duplicate `source_event_id` is a no-op returning `existing_id`.
6. **Confirmation** tools + exact `confirmation_required: … confirmed=true` string.
7. **Person/status/via/kind enums** in §3; default status `user_reported`; default person from token.
8. **Measurement `values` schemas and ranges** in §4.
9. **`source_event_id`** optional, 1–200 printable ASCII, namespaced by person+event_type; retry does not overwrite.
10. **No-source dedup** of `(person, type, event_time-second, normalized payload)` for measurements/meals/symptoms/sleep/labs; meds/conditions/allergies remain non-deduped unless T4 documents a change.
11. **Query** sections, default limit 20, max 200, inclusive bounds, medications = current only, measurement kinds chronological after latest-N.
12. **Charts**: PNG MCP image, default 30 days, max 3650, ~2000 points, Kyiv labels, BP two series.
13. **Network** `health-internal` external; Hermes still the only clients.
14. **Healthcheck** `GET /healthz` → `ok`.
15. **No Postgres / SQLite / Rust binary** in the new module. Corrections are **append-only** (`corrects`), not UPDATE.
16. After each successful write, regenerate the locked `generated/*.md` names from the plan §1.4 (new vs Rust; there is no generated markdown today).
17. Do not commit vault contents or token values. Do not deploy.

Hermes image digest, `llm-wiki` enablement, wiki bind-mounts, and most of `test_health_integration.py` belong to **T5**, except anything T4’s Compose/Dockerfile change immediately falsifies (Rust `cargo clean` assertion, postgres healthcheck binary).
