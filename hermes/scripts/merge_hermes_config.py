#!/usr/bin/env python3

import os
import sys
import tempfile
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


def sanitize_health(managed: dict) -> dict:
    result = deepcopy(managed)
    health = result.get("mcp_servers", {}).get("health")
    if isinstance(health, dict):
        headers = health.get("headers")
        if isinstance(headers, dict):
            headers.pop("Authorization", None)
            if not headers:
                health.pop("headers", None)
    return result


def write_private_atomic(path: Path, content: str) -> None:
    descriptor = -1
    temporary_path = None
    try:
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{path.name}.", dir=path.parent
        )
        temporary_path = Path(temporary_name)
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            descriptor = -1
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary_path, path)
        temporary_path = None
    except BaseException:
        if descriptor >= 0:
            os.close(descriptor)
        if temporary_path is not None:
            try:
                temporary_path.unlink()
            except FileNotFoundError:
                pass
        raise


def main() -> int:
    if len(sys.argv) not in (4, 5):
        return 2
    managed_path, current_path, output_path = map(Path, sys.argv[1:4])
    secret_path = Path(sys.argv[4]) if len(sys.argv) == 5 else None
    try:
        managed = load(managed_path)
        if len(sys.argv) == 5 and sys.argv[4] == "--sanitize-health":
            managed = sanitize_health(managed)
            secret_path = None
        else:
            managed = materialize_health_token(managed, secret_path)
        if not managed:
            return 2
        content = yaml.safe_dump(
            merge(load(current_path), managed), allow_unicode=True, sort_keys=False
        )
        write_private_atomic(output_path, content)
    except (OSError, UnicodeError, ValueError, yaml.YAMLError):
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
