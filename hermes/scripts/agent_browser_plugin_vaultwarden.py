#!/usr/bin/env python3
import json
import pathlib
import sys
import urllib.request


PROTOCOL = "agent-browser.plugin.v1"
TOKEN_FILE = pathlib.Path("/run/hermes-home-secrets/media_api_token")
BROKER_URL = "http://vaultwarden-broker-andrii:8787/v1/command"


def call_broker(command, argument):
    token = TOKEN_FILE.read_text(encoding="utf-8").strip()
    payload = json.dumps({"command": command, "argument": argument}).encode()
    request = urllib.request.Request(
        BROKER_URL,
        data=payload,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read())


def handle(message):
    if message.get("protocol") != PROTOCOL:
        raise ValueError("unsupported protocol")
    if message.get("type") == "plugin.manifest":
        return {
            "protocol": PROTOCOL,
            "success": True,
            "manifest": {
                "name": "vaultwarden",
                "capabilities": ["credential.read"],
                "description": "Resolve one approved Vaultwarden login request",
            },
        }
    if (
        message.get("type") != "credential.resolve"
        or message.get("capability") != "credential.read"
    ):
        raise ValueError("unsupported request")
    request_id = (message.get("request") or {}).get("itemRef")
    if not isinstance(request_id, str) or not request_id:
        raise ValueError("missing item reference")
    result = call_broker("browser_credential_resolve", request_id)
    credential = result
    if not isinstance(credential, dict) or set(credential) != {"username", "password", "url"}:
        raise ValueError("credential resolution failed")
    return {"protocol": PROTOCOL, "success": True, "credential": credential}


def main():
    try:
        message = json.load(sys.stdin)
        response = handle(message)
    except Exception:
        response = {
            "protocol": PROTOCOL,
            "success": False,
            "error": "credential resolution failed",
        }
    json.dump(response, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
