#!/usr/bin/env python3

import sys
from pathlib import Path

import yaml


def merge(current, managed, path=()):
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


def main() -> int:
    if len(sys.argv) != 4:
        return 2
    managed_path, current_path, output_path = map(Path, sys.argv[1:])
    managed = load(managed_path)
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
