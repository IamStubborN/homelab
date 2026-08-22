---
name: health
description: Use when managing family health records and charts.
---

# Family health

Use only discovered `mcp_health_*` tools for facts. Either spouse may read or
write either person's data. Medical facts go through MCP. Never use terminal,
direct HTTP, SQL, or jsonl as a health ledger. Never edit `data/` or
`generated/`. Read current medical state with `llm-wiki` on
`shared/health/generated/*.md` and SCHEMA. Hide tokens, endpoints, raw JSON,
and internal record IDs unless explicitly requested for technical details.

All user-facing health text and buttons are in Russian. Internal identifiers
and tool arguments stay in English.

## Facts vs synthesis

MCP-only for facts. Do not treat the wiki as a ledger and do not read jsonl.

- Writes (measurements, meals, symptoms, sleep, medications, conditions,
  allergies, labs, corrections, charts, structured queries) go through MCP.
- Current-state reading for those facts: use `llm-wiki` on
  `shared/health/generated/*.md` and `shared/health/SCHEMA.md`, not jsonl.
  Typical generated pages include `ANDRII_CURRENT_PROFILE.md`,
  `VALENTYNA_CURRENT_MEDICATIONS.md`, `ANDRII_RECENT_MEASUREMENTS.md`,
  `ANDRII_RECENT_LABS.md`, `VALENTYNA_ALLERGIES.md`, and
  `FAMILY_DIET_SNAPSHOTS.md` under `/wiki/shared/health/generated/`.
- Wiki is for synthesis only: people pages, family notes, and narrative
  summaries that cite generated facts. Put `person` on every health page. Do
  not mix Andrii and Valentyna on one synthesis page. Do not store blood
  pressure, labs, meals, or other medical facts as personal journal pages.
- Never edit `data/` or `generated/`. The cashier owns those paths.
- If a required tool is absent or a write fails, say health-service is not
  deployed or the write failed. No silent wiki-as-ledger fallback. Do not
  substitute another transport or invent a tool name.

`WIKI_PATH` is `/wiki` (this person's tree). Family health is nested at
`/wiki/shared/health`.

## Resolve the person

- The bot owner is the default person.
- An explicitly named person always wins.
- When genuinely ambiguous, use native `clarify` to ask exactly «Это относится
  к Andrii или Valentyna?» with two buttons: `Andrii` and `Valentyna`. Never
  guess. Do not write until the person is resolved.

Omit `person` for the owner default. Pass `person=andrii` or
`person=valentyna` only after an explicit name or completed clarification.

## Operations

Times use RFC 3339; dates use `YYYY-MM-DD`.

| Tool | Parameters |
| --- | --- |
| `add_measurement` | `person?`, `kind`, `values`, `source?`, `status?`, `event_time?`, `source_event_id?` |
| `correct_measurement` | `measurement_id`, `new_values`, `reason`, `confirmed?` |
| `add_meal` | `person?`, `description`, `items?`, `calories?`, `status?`, `event_time?`, `source_event_id?` |
| `add_symptom` | `person?`, `description`, `severity?`, `status?`, `event_time?`, `source_event_id?` |
| `add_sleep_record` | `person?`, `start_time`, `end_time`, `quality?`, `notes?`, `status?`, `source_event_id?` |
| `add_medication` | `person?`, `name`, `dose?`, `schedule?`, `started_at?`, `status?`, `confirmed?` |
| `stop_medication` | `person?`, `medication_id`, `stopped_at?`, `reason?`, `confirmed?` |
| `add_condition` | `person?`, `name`, `notes?`, `diagnosed_at?`, `status?`, `confirmed?` |
| `add_allergy` | `person?`, `allergen`, `reaction?`, `severity?`, `status?` |
| `add_lab_result` | `person?`, `test_date`, `test_name`, `value`, `unit?`, `reference_min?`, `reference_max?`, `flag?`, `laboratory?`, `source_document?`, `status?` |
| `query_health_data` | `person?`, `section`, `limit?`, `from?`, `to?` |
| `generate_chart` | `person?`, `kind`, `days?`, `title?` |

## Writes and confirmations

Write routine measurements, meals, symptoms, and sleep immediately. Echo the
recorded fact and offer `✏️ Исправить`.

For medication, condition, and correction operations, first use native
`clarify` with exactly three buttons:
`✅ Записать / ✏️ Исправить / 🚫 Отмена`. Call no write tool before the choice.
Only after `✅ Записать`, call the tool. Pass `confirmed=true` to
`add_medication`, `stop_medication`, `add_condition`, and
`correct_measurement`. Edit returns to correction; cancel writes nothing.

For routine event writes, pass `event_time` from the Telegram source message
timestamp. When transport metadata exposes a stable source update/message ID,
form `source_event_id` as a stable per-fact identity: append a deterministic
fact ordinal such as `:fact:1`, `:fact:2` to that source ID. Two facts parsed
from one message must use different ordinals, and a retry must reuse the same
ordinal for the same fact. Never pass the raw message/update ID alone and never
invent either value when the live gateway does not expose that metadata;
without `source_event_id`, the service makes no retry-deduplication promise.
Reusing a per-fact source ID with changed values returns the original record as
a duplicate and does not overwrite it.

Before writing a user-intended verbatim repeat with no new time or context,
call `query_health_data` for the same person and matching section or
measurement kind with a small recent limit. Compare the complete typed values
or content, not a summary. If the latest matching record is exact, report in
Russian that it is already recorded and do not call a write tool. A repeat with
an explicit new time or context is an independent fact and must be written.
This is an agent-side preflight, not a fuzzy server deduplication rule.

Before correcting a blood-pressure pulse, query the current measurement first
and reuse its complete `systolic`, `diastolic`, and `pulse` values. The
`correct_measurement.new_values` object always replaces the full typed value;
never send a partial `{value:83}` object for blood pressure.

Repeat allergies and laboratory fields before writing when interpretation is
unclear. Never invent missing values.

## Interaction contract

| Flow | Before tool | After choice |
| --- | --- | --- |
| `ambiguous-person` | `native clarify: Andrii / Valentyna; no write` | `after selection: resolve person, then apply matching flow` |
| `routine-fact` | `no confirmation` | `write immediately, then echo with ✏️ Исправить` |
| `sensitive-write` | `native clarify: ✅ Записать / ✏️ Исправить / 🚫 Отмена; no write` | `only after ✅: call the exact tool; cancel writes nothing` |

## Results

- On `outcome=duplicate`, say it was already recorded and do not retry.
- Transcribe voice messages, then process them exactly like text through the
  same person and confirmation rules.
- For a chart, send the returned `image/png` PNG to the chat.
- Never set `status` above `user_reported` unless the user cites a doctor or a
  document. Preserve exactly what the user reported.
- On a tool error, show the reason and ask what to fix. Do not retry and never
  loop automatically.
- If a required tool is absent, say health-service is not deployed. Do not
  substitute another transport or invent a tool name.

## Examples

| User message | Action |
| --- | --- |
| «Давление 138/92, пульс 80» | `add_measurement(kind=blood_pressure, values={systolic:138,diastolic:92,pulse:80})` |
| «Запиши Валентине вес 78,2» | `add_measurement(person=valentyna, kind=weight, values={value:78.2,unit:"kg"})` |
| «покажи вес за месяц» | `generate_chart(kind=weight, days=30)`; send the returned PNG to the chat |
| «Обед: борщ и хлеб, примерно 520 ккал» | `add_meal(description="борщ и хлеб", calories=520)` |
| «Спал с 23:10 до 07:00, качество 4» | `add_sleep_record(start_time=<resolved RFC3339>, end_time=<resolved RFC3339>, quality=4)` |
| «У Валентины болит голова, сила 6 из 10» | `add_symptom(person=valentyna, description="головная боль", severity=6)` |
| «Начал принимать магний 200 мг вечером» | show the confirmation card; after ✅ call `add_medication(name="магний", dose="200 mg", schedule="вечером", confirmed=true)` |
| «Исправь тот пульс на 83» | query and resolve the current blood-pressure record, show the confirmation card, then after ✅ call `correct_measurement(measurement_id=<private id>, new_values={systolic:<current>,diastolic:<current>,pulse:83}, reason="user correction", confirmed=true)` |
| «У меня диагностировали гипертонию» | show the confirmation card; after ✅ call `add_condition(name="гипертония", status=confirmed_by_doctor, confirmed=true)` |
| «Какие лекарства сейчас принимает Andrii?» | `query_health_data(person=andrii, section="medications")` |
| «Какой сейчас профиль давления у Andrii?» | read `/wiki/shared/health/generated/ANDRII_CURRENT_PROFILE.md` via llm-wiki; do not open jsonl |
