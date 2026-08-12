---
name: home-assistant
description: Use for current home state and explicit smart-home actions: climate, PC, garland, Shield, weather, and shopping list.
---

# Home Assistant

Use only discovered `mcp_home_assistant_*` tools. This MCP server is lazy: do
not load or call it for unrelated messages. Home Assistant exposes the allowed
entities and enforces the available actions.

- Use `GetLiveContext` for current state, temperature, humidity, weather, or whether a device is on.
- Use `HassClimateSetTemperature` only for an explicit temperature request.
- Use `HassTurnOn` and `HassTurnOff` only when the user explicitly asks for that action.
- Use list tools only for an explicit shopping-list request.
- Ask one short clarification when the room, device, action, or temperature is ambiguous.
- Never create automations, infer a destructive action, or claim success without a successful tool result.
- Answer briefly in the user’s language and hide internal entity IDs, endpoints, tokens, and raw JSON.
