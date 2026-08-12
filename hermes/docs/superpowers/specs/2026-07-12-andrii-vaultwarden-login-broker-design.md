# Andrii Vaultwarden Login Broker Design

## Status

Approved direction. Implementation has not started.

## Goal

Allow `hermes-andrii` to sign in to explicitly approved websites with credentials from Andrii's Vaultwarden account without exposing passwords to Hermes, the LLM, Telegram, tool output, or logs.

## Scope

- Integrate only Andrii's Vaultwarden account.
- Require Telegram approval for every login attempt.
- Restrict credential lookup to an explicit domain allowlist.
- Bind each approval to one domain, one browser session, and a short expiration.
- Keep the Vaultwarden session exclusively in the broker container.
- Audit decisions and outcomes without recording credentials or form values.

The following are out of scope:

- Any Vaultwarden integration or account provisioning for Valentyna.
- Password search or password display in Hermes.
- Autonomous login without Telegram approval.
- Access to high-risk accounts such as primary email, banking, identity, GitHub, cloud infrastructure, password managers, or homelab administration.
- CAPTCHA, passkey, MFA, security-key, or recovery-code automation.

## Architecture

```text
hermes-andrii
  -> login request (domain, browser session, current URL)
  -> vaultwarden-login-broker-andrii
  -> Telegram approval request to Andrii
  -> exact-domain policy check
  -> Vaultwarden credential lookup
  -> browser login adapter
  -> one-time form fill and submit
```

The existing metadata-only `vaultwarden-safe` interface remains separate. The LLM-facing contract never gains a command that returns a password.

## Request Flow

1. Hermes detects that an approved website requires authentication.
2. Hermes submits the current HTTPS URL and browser session identifier to the broker.
3. The broker normalizes the hostname and rejects IP literals, non-HTTPS URLs, redirects to another hostname, and domains not present in the allowlist.
4. The broker sends Andrii a Telegram approval containing the site hostname and a short request identifier. It does not include usernames or passwords.
5. Andrii explicitly approves or denies the request. Every login requires a new approval.
6. An approval expires after two minutes and is valid for one attempt only.
7. The broker retrieves a credential whose configured URI matches the normalized hostname according to the allowlist policy.
8. The browser adapter fills the username and password directly into the bound browser session. Secret values never cross the broker boundary as a response payload.
9. The adapter verifies a bounded success signal such as navigation away from the login page or disappearance of the login form. It does not bypass MFA or CAPTCHA.
10. The broker records a redacted audit event and destroys all in-memory secret values immediately after the attempt.

## Security Boundaries

- `hermes-andrii` cannot read the Vaultwarden session secret or invoke `bw` directly.
- Only the Andrii-private network connects Hermes to the broker.
- The broker accepts requests only from the Andrii profile and validates a per-service authentication secret.
- Credentials are matched by exact normalized hostname unless an allowlist entry explicitly includes subdomains.
- Redirects, iframes, and form actions targeting a different hostname fail closed.
- Browser automation is limited to the approved tab and browser session.
- Passwords, TOTP values, notes, recovery codes, and complete Vaultwarden item JSON are never returned.
- Logs contain request ID, hostname, decision, timestamps, and a coarse outcome only.
- Sensitive categories are denied by default even if matching credentials exist.

## Telegram Approval

The approval message is sent only to Telegram user/chat ID `371313216`. Runtime configuration must continue to set both `TELEGRAM_ALLOWED_USERS` and `TELEGRAM_HOME_CHANNEL` to this exact value.

An approval must include:

- normalized hostname;
- request expiration;
- `Approve` and `Deny` actions;
- a warning when the browser is about to submit a login form.

Replies from any other Telegram user or chat are ignored.

## Configuration

The allowlist is a reviewed, non-secret file committed to the repository. An entry contains:

```yaml
domains:
  - hostname: example.com
    include_subdomains: false
    credential_item_id: optional-vaultwarden-item-id
```

No domains are enabled by default. Adding a domain requires a repository change and broker restart.

## Failure Handling

- Missing or locked Vaultwarden session: fail and tell Andrii to reinitialize the broker session.
- No exact credential match: fail without revealing whether other matching items exist.
- Multiple matches: fail and require an explicit item ID in the allowlist.
- Approval timeout or denial: terminate the request without retrieving credentials.
- MFA, CAPTCHA, passkey, or unexpected login flow: stop and hand control to Andrii.
- Browser session or URL mismatch: invalidate the approval and require a new request.

No automatic retries occur after a credential has been submitted.

## Verification

- Unit tests cover URL normalization, exact-domain matching, redirects, approval expiration, one-time use, and redaction.
- Contract tests prove that no LLM-facing response schema contains password or TOTP fields.
- Integration tests use a local fake login site and fake Vaultwarden data.
- Deployment verification confirms that only `hermes-andrii` can reach its broker and that `hermes-valentyna` has no Vaultwarden service, session secret, or password skill.
- A manual test verifies approval, successful login, denial, timeout, and MFA handoff.

## Rollout

1. Deploy the broker with an empty allowlist and no active browser-login capability.
2. Initialize only Andrii's Vaultwarden session.
3. Verify status, sync, Telegram approval, and redacted audit logging.
4. Add one low-risk test domain and complete the manual verification matrix.
5. Add further low-risk domains individually after review.
