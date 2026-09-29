from __future__ import annotations

import os
import subprocess
import sys


def test_configured_person_ids_keep_existing_data_paths(tmp_path) -> None:
    code = """
from pathlib import Path
from health_mcp.auth import TokenMap
from health_mcp.store import WikiStore
from health_mcp.types import PERSONS

root = Path(__import__('sys').argv[1])
identity = TokenMap('token-one', 'token-two').resolve('token-one')
assert identity is not None
assert identity.actor == 'legacy_one'
assert identity.via == 'hermes_legacy_one'
assert identity.default_person == 'legacy_one'
assert PERSONS == {'legacy_one', 'legacy_two'}
assert WikiStore(root)._jsonl_path('legacy_one', 'measurement') == root / 'data/legacy_one/measurements.jsonl'
"""
    env = {
        **os.environ,
        "HEALTH_PRIMARY_PERSON": "legacy_one",
        "HEALTH_SECONDARY_PERSON": "legacy_two",
    }
    subprocess.run([sys.executable, "-c", code, str(tmp_path)], env=env, check=True)
