# Andrii Vaultwarden Login Broker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let only `hermes-andrii` perform explicitly approved, allowlisted website logins without returning credentials to Hermes.

**Architecture:** Extend the existing private Vaultwarden broker with one-time login requests and a direct `agent-browser` adapter using Andrii's persistent browser profile volume. Hermes exposes request/approve/deny commands through a personal skill; only an explicit Telegram message from the already allowlisted Andrii chat may cause approval.

**Tech Stack:** Python standard library, Bitwarden CLI, agent-browser CLI, Docker Compose, unittest.

## Global Constraints

- Passwords, TOTP values, notes, recovery codes, and complete item JSON never leave the broker.
- Every login requires a fresh approval and expires after 120 seconds.
- Only exact HTTPS hostnames in the committed allowlist are accepted.
- Valentyna receives no Vaultwarden secret, broker, client, or skill.
- MFA, CAPTCHA, passkeys, redirects, and cross-origin form actions fail closed.

---

### Task 1: Broker Request Policy

**Files:**
- Create: `config/vaultwarden-login-allowlist.json`
- Modify: `scripts/vaultwarden_broker.py`
- Test: `tests/test_vaultwarden_login.py`

**Interfaces:**
- Produces `LoginPolicy`, `PendingLoginStore`, and broker commands `login_request`, `login_status`, `login_deny`.

- [ ] Add tests for HTTPS normalization, IP rejection, exact-host allowlisting, expiry, and one-time denial.
- [ ] Run `python3 -m unittest -q tests.test_vaultwarden_login` and confirm the new tests fail.
- [ ] Implement an empty-by-default JSON allowlist, normalized hostname validation, random request IDs, a 120-second in-memory pending store, and redacted responses.
- [ ] Re-run the focused tests and confirm they pass.

### Task 2: Direct Browser Login Adapter

**Files:**
- Create: `scripts/vaultwarden_browser_login.py`
- Modify: `scripts/vaultwarden_broker.py`
- Modify: `Dockerfile`
- Test: `tests/test_vaultwarden_login.py`

**Interfaces:**
- Consumes an approved request and one sanitized Vaultwarden login item inside the broker process.
- Produces `BrowserLoginResult(outcome: str)` with no secret fields.

- [ ] Add tests proving duplicate credential matches fail, secrets are passed through stdin only, and output/logs contain no credential values.
- [ ] Run the focused tests and confirm they fail.
- [ ] Implement exact URI matching, username/password extraction inside the broker, selector-based username/password fill through `agent-browser`, same-origin checks, submission, bounded success detection, and immediate secret cleanup.
- [ ] Re-run the focused tests and confirm they pass.

### Task 3: Andrii-Only Compose and Skill Integration

**Files:**
- Modify: `compose.yaml`
- Modify: `scripts/vaultwarden-safe`
- Create: `profiles/andrii/skills/vaultwarden-login/SKILL.md`
- Modify: `scripts/hermes-home-entrypoint`
- Modify: `README.md`
- Modify: `tests/test_scaffold.py`

**Interfaces:**
- Produces LLM-facing commands `login-request URL`, `login-status ID`, `login-approve ID`, and `login-deny ID`; none return credentials.

- [ ] Add contract tests proving the client and skill are Andrii-only, approval requires an explicit user message, and no password-return command exists.
- [ ] Run `python3 -m unittest -q` and confirm the new contracts fail.
- [ ] Mount the allowlist and Andrii browser profile into only the Andrii broker, remove the Valentyna broker/session wiring, add the commands to the client, and install the personal skill.
- [ ] Run `./scripts/check` and confirm all checks pass.
- [ ] Deploy with an empty allowlist, initialize only Andrii's session, and verify both Hermes containers remain healthy while no Valentyna Vaultwarden container exists.

### Task 4: Deployment Verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Verifies the completed runtime contract.

- [ ] Recreate the Compose services and confirm `vaultwarden-broker-andrii` is healthy.
- [ ] Confirm `vaultwarden-safe status` works from `hermes-andrii` and fails from `hermes-valentyna`.
- [ ] Confirm the empty allowlist rejects a login request without reading a credential.
- [ ] Confirm Telegram runtime IDs are exactly `371313216` and `587265757` for their respective Hermes containers.
- [ ] Commit and push the implementation.
