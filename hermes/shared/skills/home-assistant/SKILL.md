---
name: home-assistant
description: Use when reading or controlling lights, climate, or other smart-home devices.
---

Use only discovered `mcp_home_assistant_*` tools. The server is lazy; skip unrelated messages. Home Assistant enforces allowed entities and actions.

- Use `GetLiveContext` for state, temperature, humidity, weather, or power state.
- Use climate, power, media-player, timer, broadcast, and shopping-list actions only when explicitly requested.
- Ask one short clarification for an ambiguous room, device, action, or value.
- Never create automations, infer a destructive action, or claim success without a successful tool result.
- Answer briefly in the user's language and hide entity IDs, endpoints, tokens, and raw JSON.

## Targeting rules (critical)

- Name **one** concrete device per tool call (exact friendly name like `Кондиционер Первый`).
- Never call `HassTurnOn` / `HassTurnOff` without a device name, and never try to target “all”, “both”, or a whole domain at once. That returns `Service handler cannot target all devices`.
- Control several devices with **separate** tool calls, one device each.
- Prefer climate-specific tools for ACs (`HassClimateSetTemperature`, climate turn on/off / set HVAC mode) over generic `HassTurnOn`.
- If a tool returns `MULTIPLE_TARGETS`, use a more specific friendly name and retry once.
