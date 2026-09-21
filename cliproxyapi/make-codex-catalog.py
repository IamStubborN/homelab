#!/usr/bin/env python3
"""Rebuild ~/.codex/model_catalog.json = native Codex models + OpenCode Go models.

Codex desktop reads the picker from `model_catalog_json`, and that file *replaces*
the bundled catalog, so it must list every model you want to select. Native
(ChatGPT-account) models live in a baseline file; OpenCode Go models are read from
the `openai-compatibility` block of cliproxyapi/config.yaml, so the gateway and
the picker cannot drift apart.

  ./make-codex-catalog.py           # rebuild the catalog
  ./make-codex-catalog.py --check   # verify it is in sync (non-zero exit if not)

Refresh the native baseline after OpenAI adds or retires a model: temporarily drop
`model_catalog_json` from ~/.codex/config.toml, run `codex debug models > native.json`,
add "models" around it if needed, and copy it to ~/.codex/model_catalog.native.json.
"""

import argparse
import json
import os
import sys

HOME = os.path.expanduser("~")
DEFAULT_CONFIG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.yaml")
DEFAULT_CATALOG = os.path.join(HOME, ".codex", "model_catalog.json")
DEFAULT_NATIVE = os.path.join(HOME, ".codex", "model_catalog.native.json")

ENTRY = {
    "base_instructions": "",
    "default_verbosity": "low",
    "experimental_supported_tools": [],
    "priority": 50,
    "shell_type": "unified_exec",
    "support_verbosity": True,
    "supported_in_api": True,
    "supported_reasoning_levels": [
        {"effort": "low", "description": "Fast responses with lighter reasoning"},
        {"effort": "medium", "description": "Balances speed and reasoning depth"},
        {"effort": "high", "description": "Greater reasoning depth"},
    ],
    "supports_parallel_tool_calls": True,
    "supports_reasoning_summaries": False,
    "truncation_policy": {"limit": 10000, "mode": "bytes"},
    "visibility": "list",
}


def load_go_models(config_path):
    """Return catalog entries for every model published by the gateway."""
    try:
        import yaml
    except ImportError:
        sys.exit("need pyyaml: uv run --with pyyaml make-codex-catalog.py")
    with open(config_path) as f:
        config = yaml.safe_load(f)
    providers = config.get("openai-compatibility") or []
    if not providers:
        sys.exit(f"{config_path}: no openai-compatibility block")
    entries = []
    for model in providers[0].get("models") or []:
        slug = model.get("alias") or model.get("name")
        entry = dict(ENTRY)
        entry["slug"] = slug
        entry["display_name"] = model.get("display-name") or model.get("name") or slug
        entry["description"] = f"{entry['display_name']} via OpenCode Go"
        entry["context_window"] = model.get("max-context-length") or 200000
        entry["input_modalities"] = model.get("input-modalities") or ["text"]
        entries.append(entry)
    return entries


def build(config_path, native_path):
    native = json.load(open(native_path))["models"]
    go = load_go_models(config_path)
    slugs = [m["slug"] for m in native + go]
    duplicates = {s for s in slugs if slugs.count(s) > 1}
    if duplicates:
        sys.exit(f"duplicate slugs between native and Go: {sorted(duplicates)}")
    return {"models": native + go}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=DEFAULT_CONFIG)
    ap.add_argument("--catalog", default=DEFAULT_CATALOG)
    ap.add_argument("--native", default=DEFAULT_NATIVE)
    ap.add_argument("--check", action="store_true", help="verify instead of writing")
    args = ap.parse_args()

    wanted = build(args.config, args.native)
    if args.check:
        current = json.load(open(args.catalog))
        same = [m["slug"] for m in current["models"]] == [m["slug"] for m in wanted["models"]]
        print("in sync" if same else "OUT OF SYNC: run without --check")
        sys.exit(0 if same else 1)

    with open(args.catalog, "w") as f:
        json.dump(wanted, f, indent=1)
    json.load(open(args.catalog))  # fail loudly rather than write bad JSON
    native_count = len(json.load(open(args.native))["models"])
    print(f"{args.catalog}: {len(wanted['models'])} models "
          f"(native={native_count}, opencode-go={len(wanted['models']) - native_count})")


if __name__ == "__main__":
    main()
