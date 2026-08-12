---
name: health
description: Use when managing family health records and charts.
---

# Family health

Use only discovered `mcp_health_*` tools. Either spouse may read or write either
person's data. Never use terminal, direct HTTP, files, or SQL for health data.
Hide tokens, endpoints, raw JSON, and internal record IDs unless explicitly
requested for technical details.

## Resolve the person

- The bot owner is the default person.
- An explicitly named person always wins.
- When genuinely ambiguous, ask exactly «Это относится к Andrii или
  Valentyna?» with two buttons: `Andrii` and `Valentyna`. Never guess. Do not
  write until the person is resolved.

Omit `person` for the owner default. Pass `person=andrii` or
`person=valentyna` only after an explicit name or completed clarification.

## Operations

Times use RFC 3339; dates use `YYYY-MM-DD`.

| Tool | Parameters |
| --- | --- |
| `add_measurement` | `person?`, `kind`, `values`, `source?`, `status?`, `event_time?` |
| `correct_measurement` | `measurement_id`, `new_values`, `reason`, `confirmed?` |
| `add_meal` | `person?`, `description`, `items?`, `calories?`, `status?`, `event_time?` |
| `add_symptom` | `person?`, `description`, `severity?`, `status?`, `event_time?` |
| `add_sleep_record` | `person?`, `start_time`, `end_time`, `quality?`, `notes?`, `status?` |
| `add_medication` | `person?`, `name`, `dose?`, `schedule?`, `started_at?`, `status?`, `confirmed?` |
| `stop_medication` | `person?`, `medication_id`, `stopped_at?`, `reason?`, `confirmed?` |
| `add_condition` | `person?`, `name`, `notes?`, `diagnosed_at?`, `status?` |
| `add_allergy` | `person?`, `allergen`, `reaction?`, `severity?`, `status?` |
| `add_lab_result` | `person?`, `test_date`, `test_name`, `value`, `unit?`, `reference_min?`, `reference_max?`, `flag?`, `laboratory?`, `source_document?`, `status?` |
| `query_health_data` | `person?`, `section`, `limit?`, `from?`, `to?` |
| `generate_chart` | `person?`, `kind`, `days?`, `title?` |

## Writes and confirmations

Write routine measurements, meals, symptoms, and sleep immediately. Echo the
recorded fact and offer `✏️ Исправить`.

For medication, condition, and correction operations, first show
`✅ Записать / ✏️ Исправить / 🚫 Отмена`. Call no write tool before the choice.
Only after `✅ Записать`, call the tool. Pass `confirmed=true` to
`add_medication`, `stop_medication`, and `correct_measurement`. `add_condition`
has no `confirmed` parameter, so enforce its confirmation before the call and
send only catalogued fields. Edit returns to correction; cancel writes nothing.

Repeat allergies and laboratory fields before writing when interpretation is
unclear. Never invent missing values.

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
| «Исправь тот пульс на 83» | resolve the record, show the confirmation card, then call `correct_measurement(measurement_id=<private id>, new_values={value:83}, reason="user correction", confirmed=true)` after ✅ |
| «Какие лекарства сейчас принимает Andrii?» | `query_health_data(person=andrii, section="medications")` |
