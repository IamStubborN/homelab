#!/bin/sh
set -eu

config=${1:-homeassistant/config/configuration.example.yaml}

python3 - "$config" <<'PY'
import sys

path = sys.argv[1]
lines = open(path, encoding="utf-8").read().splitlines()
inside_input_number = False
current_helper = None
errors = []

for line_number, line in enumerate(lines, start=1):
    if line == "input_number:":
        inside_input_number = True
        current_helper = None
        continue
    if inside_input_number and line and not line.startswith(" "):
        break
    if not inside_input_number:
        continue

    if line.startswith("  climate_auto_") and line.endswith(":"):
        current_helper = line.strip()[:-1]
        continue
    if current_helper and line.strip().startswith("initial:"):
        errors.append(
            f"{path}:{line_number}: {current_helper} must restore its previous "
            "state; remove 'initial'"
        )

if errors:
    print("\n".join(errors), file=sys.stderr)
    raise SystemExit(1)
PY
