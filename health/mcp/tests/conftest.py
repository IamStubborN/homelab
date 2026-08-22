from __future__ import annotations

from pathlib import Path

import pytest

from health_mcp.auth import Identity, TokenMap
from health_mcp.store import WikiStore

ANDRII_TOKEN = "andrii-secret"
VALENTYNA_TOKEN = "valentyna-secret"


@pytest.fixture
def identity() -> Identity:
    return Identity("andrii", "hermes_andrii", "andrii")


@pytest.fixture
def valentyna_identity() -> Identity:
    return Identity("valentyna", "hermes_valentyna", "valentyna")


@pytest.fixture
def wiki_root(tmp_path: Path) -> Path:
    root = tmp_path / "shared" / "health"
    (root / "data" / "andrii").mkdir(parents=True)
    (root / "data" / "valentyna").mkdir(parents=True)
    (root / "generated").mkdir(parents=True)
    return root


@pytest.fixture
def store(wiki_root: Path) -> WikiStore:
    return WikiStore(wiki_root)


@pytest.fixture
def tokens() -> TokenMap:
    return TokenMap(ANDRII_TOKEN, VALENTYNA_TOKEN)
