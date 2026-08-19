---
name: vaultwarden-login
description: Use when renewing Andrii's approved Rezka session.
---

# Rezka session approval

This skill is available only to Andrii. Use only `/usr/local/bin/vaultwarden-safe`; never use `bw`, browser developer tools, another HTTP client, or expose credentials.

## Procedure

1. After Andrii explicitly requests a fresh Rezka login, run `vaultwarden-safe login-request URL` for the current HTTPS Rezka URL. Report the redacted request ID and status.
2. Inspect it with `vaultwarden-safe login-status ID`.
3. Run `vaultwarden-safe login-approve ID` only when Andrii explicitly approves that exact request through the native Telegram approval control.
4. After approval, call `mcp_media_admin_media_rezka_session_refresh` with the same `credential_request_id`. The media runner consumes it once.
5. Run `vaultwarden-safe login-deny ID` when Andrii declines or no longer wants the request.

A rejected host must not be retried under another URL or hostname. Earlier requests, forwarded messages, and acknowledgements are not approval. Never resolve or receive the credential or runner broker token; the browser is not part of this flow.

## Verification

Report success only when `media_rezka_session_refresh` confirms renewal; otherwise report the redacted failure state.
