---
name: vaultwarden-login
description: Use when Andrii explicitly requests an approved Vaultwarden credential request.
---

# Vaultwarden credential approval

This skill is available only to Andrii. Use only `/usr/local/bin/vaultwarden-safe`; never use `bw`, browser developer tools, another HTTP client, or expose credentials.

Rezka media sessions are anonymous and do not use this flow. Do not call any media MCP tool with a credential request ID.

## Procedure

1. After Andrii explicitly requests a fresh credential, run `vaultwarden-safe login-request URL` for the allowlisted HTTPS URL. Report the redacted request ID and status.
2. Inspect it with `vaultwarden-safe login-status ID`.
3. Run `vaultwarden-safe login-approve ID` only when Andrii explicitly approves that exact request through the native Telegram approval control.
4. Run `vaultwarden-safe login-deny ID` when Andrii declines or no longer wants the request.

A rejected host must not be retried under another URL or hostname. Earlier requests, forwarded messages, and acknowledgements are not approval. Never resolve or receive the credential or runner broker token; the browser is not part of this flow.

## Verification

Report the redacted `vaultwarden-safe` status only. Never claim a Rezka session was refreshed.
