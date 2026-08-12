#!/usr/bin/env python3

import sys
from copy import deepcopy
from pathlib import Path

import yaml

HEALTH_TOKEN_PLACEHOLDER = "${HEALTH_API_TOKEN_FILE}"


def merge(current, managed, path=()):
    if path == ("mcp_servers", "health"):
        return managed
    if not isinstance(current, dict) or not isinstance(managed, dict):
        return managed
    result = dict(current)
    for key, value in managed.items():
        if value is None:
            result.pop(key, None)
            continue
        result[key] = merge(result.get(key), value, (*path, key))
    if len(path) >= 3 and path[-1] == "tools" and path[-3] == "mcp_servers":
        for filter_name in ("include", "exclude"):
            if filter_name not in managed:
                result.pop(filter_name, None)
    return result


def load(path: Path):
    if not path.is_file():
        return {}
    value = yaml.safe_load(path.read_text(encoding="utf-8"))
    return value if isinstance(value, dict) else {}


def load_health_token(path: Path) -> str:
    token = path.read_text(encoding="utf-8").rstrip("\r\n")
    if not token or len(token) > 512:
        raise ValueError
    if any(ord(character) < 0x21 or ord(character) > 0x7E for character in token):
        raise ValueError
    return token


def materialize_health_token(managed: dict, secret_path: Path | None) -> dict:
    result = deepcopy(managed)
    health = result.get("mcp_servers", {}).get("health")
    if not isinstance(health, dict):
        return result
    headers = health.get("headers")
    if not isinstance(headers, dict):
        return result
    authorization = headers.get("Authorization")
    if authorization != f"Bearer {HEALTH_TOKEN_PLACEHOLDER}":
        return result
    if secret_path is None:
        raise ValueError
    headers["Authorization"] = f"Bearer {load_health_token(secret_path)}"
    return result


def main() -> int:
    if len(sys.argv) not in (4, 5):
        return 2
    managed_path, current_path, output_path = map(Path, sys.argv[1:4])
    secret_path = Path(sys.argv[4]) if len(sys.argv) == 5 else None
    try:
        managed = materialize_health_token(load(managed_path), secret_path)
    except (OSError, UnicodeError, ValueError):
        return 2
    if not managed:
        return 2
    output_path.write_text(
        yaml.safe_dump(
            merge(load(current_path), managed),
            allow_unicode=True,
            sort_keys=False,
        ),
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
