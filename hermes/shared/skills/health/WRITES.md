# Write identity

Read this when forming `source_event_id` or retrying a health write.

When transport metadata exposes a stable source update/message ID, form
`source_event_id` as a stable per-fact identity: append a deterministic fact
ordinal such as `:fact:1`, `:fact:2` to that source ID. Two facts parsed from
one message must use different ordinals, and a retry must reuse the same
ordinal for the same fact. Never pass the raw message/update ID alone and never
invent either value when the live gateway does not expose that metadata;
without `source_event_id`, the service makes no retry-deduplication promise.
Reusing a per-fact source ID with changed values returns the original record as
a duplicate and does not overwrite it.

Tool parameters live on each `mcp_health_*` schema. Do not copy them into the
skill.

## Extra examples

| User message | Action |
| --- | --- |
| «Обед: борщ и хлеб, примерно 520 ккал» | `add_meal(description="борщ и хлеб", calories=520)` |
| «Спал с 23:10 до 07:00, качество 4» | `add_sleep_record(start_time=<resolved RFC3339>, end_time=<resolved RFC3339>, quality=4)` |
| «У Secondary болит голова, сила 6 из 10» | `add_symptom(person=secondary, description="головная боль", severity=6)` |
| «Какие лекарства сейчас принимает Primary?» | `query_health_data(person=primary, section="medications")` |
| «Какой сейчас профиль давления у Primary?» | read `/wiki/shared/health/generated/PRIMARY_CURRENT_PROFILE.md` via llm-wiki; do not open jsonl |
