"""Native Hermes approval boundary for Vaultwarden website logins."""

import re
import shlex


REQUEST_ID = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
SENSITIVE_MARKERS = (
    "vaultwarden-broker-",
    "/run/secrets/media_api_token",
    "/run/secrets/broker_api_token",
    "/run/secrets/rezka_broker_token",
    "/run/hermes-home-secrets/media_api_token",
    "/run/hermes-home-secrets/broker_api_token",
    "agent-browser-plugin-vaultwarden",
    "credential_resolve",
    "browser_credential_resolve",
    "/v1/command",
    "login_approve",
)


def pre_tool_call(tool_name, args, **_kwargs):
    if tool_name != "terminal" or not isinstance(args, dict):
        return None
    command = args.get("command")
    if not isinstance(command, str):
        return None
    try:
        words = shlex.split(command)
    except ValueError:
        words = []
    if (
        len(words) == 3
        and words[:2] == ["/usr/local/bin/vaultwarden-safe", "login-approve"]
        and REQUEST_ID.fullmatch(words[2])
    ):
        return {
            "action": "approve",
            "message": (
                "Vaultwarden website sign-in\n"
                "Site: rezka.ag\n"
                "Action: allow the media runner to refresh the Rezka session\n"
                "Scope: this request only; it cannot be reused\n"
                "Password exposure: none to the model, Telegram, or logs\n"
                f"Request ID: {words[2]}"
            ),
            "rule_key": f"vaultwarden-login:{words[2]}",
        }
    if any(marker in command for marker in SENSITIVE_MARKERS) or "login-approve" in command:
        return {
            "action": "block",
            "message": "Use the exact Vaultwarden approval command and native Telegram approval.",
        }
    return None


def register(context):
    context.register_hook("pre_tool_call", pre_tool_call)
