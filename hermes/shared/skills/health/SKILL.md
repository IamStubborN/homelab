---
name: health
description: Use when recording, querying, or charting family health.
---

# Family health

Use only discovered `mcp_health_*` tools for facts. Either spouse may read or
write either person's data. Medical facts go through MCP. MCP-only for facts.
Use those tools as the health ledger, not terminal, direct HTTP, SQL, or jsonl.
The cashier owns `data/` and `generated/`. Never edit `data/` or `generated/`.

All user-facing health text and buttons are in Russian. Internal identifiers
and tool arguments stay in English.

## Ledger vs wiki

Read current medical state with `llm-wiki` on `shared/health/generated/*.md`
and `shared/health/SCHEMA.md`, not jsonl. Wiki is for synthesis only: people
pages, family notes, and narrative that cite generated facts. Put `person` on
every health page. Do not mix Primary and Secondary on one synthesis page. Do
not store blood pressure, labs, meals, or other medical facts as personal
journal pages.

If a required tool is absent or a write fails, say health-service is not
deployed or the write failed. No silent wiki-as-ledger fallback.

`WIKI_PATH` is `/wiki`. Family health is nested at `/wiki/shared/health`.

## Resolve the person

- The bot owner is the default person.
- An explicitly named person always wins.
- When genuinely ambiguous, use native `clarify` to ask exactly «Это относится
  к Primary или Secondary?» with two buttons: `Primary` and `Secondary`. Never
  guess. Do not write until the person is resolved.

Omit `person` for the owner default. Pass `person=primary` or
`person=secondary` only after an explicit name or completed clarification.

## Writes

Write routine measurements, meals, symptoms, and sleep immediately. Echo the
recorded fact and offer `✏️ Исправить`. Pass `event_time` from the Telegram
source message timestamp. For `source_event_id` and retry identity, read
[WRITES.md](WRITES.md) in this skill folder.

For medication, condition, and correction operations, first use native
`clarify` with exactly three buttons:
`✅ Записать / ✏️ Исправить / 🚫 Отмена`. Call no write tool before the choice.
Only after `✅ Записать`, call the tool. Pass `confirmed=true` to
`add_medication`, `stop_medication`, `add_condition`, and
`correct_measurement`. Edit returns to correction; cancel writes nothing.

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
unclear. Leave missing values unset.

Keep `status` at `user_reported` unless the user cites a doctor or a document.
Preserve exactly what the user reported.

## Interaction contract

| Flow | Before tool | After choice |
| --- | --- | --- |
| `ambiguous-person` | `native clarify: Primary / Secondary; no write` | `after selection: resolve person, then apply matching flow` |
| `routine-fact` | `no confirmation` | `write immediately, then echo with ✏️ Исправить` |
| `sensitive-write` | `native clarify: ✅ Записать / ✏️ Исправить / 🚫 Отмена; no write` | `only after ✅: call the exact tool; cancel writes nothing` |

## Results

- On `outcome=duplicate`, say it was already recorded and do not retry.
- Transcribe voice messages, then process them exactly like text through the
  same person and confirmation rules.
- For a chart, send the returned `image/png` PNG to the chat.
- On a tool error, show the reason and ask what to fix. Do not retry and never
  loop automatically.

## Examples

| User message | Action |
| --- | --- |
| «Давление 138/92, пульс 80» | `add_measurement(kind=blood_pressure, values={systolic:138,diastolic:92,pulse:80})` |
| «Запиши Secondary вес 78,2» | `add_measurement(person=secondary, kind=weight, values={value:78.2,unit:"kg"})` |
| «покажи вес за месяц» | `generate_chart(kind=weight, days=30)`; send the returned PNG to the chat |
| «Начал принимать магний 200 мг вечером» | show the confirmation card; after ✅ call `add_medication(name="магний", dose="200 mg", schedule="вечером", confirmed=true)` |
| «Исправь тот пульс на 83» | query the current measurement first and reuse its complete systolic/diastolic/pulse, then after ✅ call `correct_measurement(measurement_id=<private id>, new_values={systolic:<current>,diastolic:<current>,pulse:83}, reason="user correction", confirmed=true)` |
| «У меня диагностировали гипертонию» | show the confirmation card; after ✅ call `add_condition(name="гипертония", status=confirmed_by_doctor, confirmed=true)` |
