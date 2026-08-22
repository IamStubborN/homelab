---
name: home-assistant
description: Use when reading or controlling the smart home.
---

# Home Assistant

Use only discovered `mcp_home_assistant_*` tools. The server is lazy; do not load it for unrelated messages. Home Assistant enforces the allowed entities and actions.

- Use `GetLiveContext` for current state, temperature, humidity, weather, or whether a device is on.
- Use climate, power, media-player, timer, broadcast, and shopping-list actions only when explicitly requested.
- Ask one short clarification when the room, device, action, or value is ambiguous.
- Never create automations, infer a destructive action, or claim success without a successful tool result.
- Answer briefly in the user's language and hide entity IDs, endpoints, tokens, and raw JSON.

## Targeting rules (critical)

- Always name **one** concrete device per tool call (exact friendly name like `Кондиционер Андрей`).
- Never call `HassTurnOn` / `HassTurnOff` without a device name, and never try to target “all”, “both”, or a whole domain at once. That returns `Service handler cannot target all devices`.
- To control several devices (for example two ACs), make **separate** tool calls, one device each.
- Prefer climate-specific tools for ACs (`HassClimateSetTemperature`, climate turn on/off / set HVAC mode) over generic `HassTurnOn`.
- If a tool returns `MULTIPLE_TARGETS`, the name was ambiguous — pick a more specific friendly name and retry once.
