from __future__ import annotations

from pathlib import Path

import pytest

from health_mcp.auth import Identity, TokenMap
from health_mcp.store import WikiStore

PRIMARY_TOKEN = "primary-secret"
SECONDARY_TOKEN = "secondary-secret"


@pytest.fixture
def identity() -> Identity:
    return Identity("primary", "hermes_primary", "primary")


@pytest.fixture
def secondary_identity() -> Identity:
    return Identity("secondary", "hermes_secondary", "secondary")


@pytest.fixture
def wiki_root(tmp_path: Path) -> Path:
    root = tmp_path / "shared" / "health"
    (root / "data" / "primary").mkdir(parents=True)
    (root / "data" / "secondary").mkdir(parents=True)
    (root / "generated").mkdir(parents=True)
    return root


@pytest.fixture
def store(wiki_root: Path) -> WikiStore:
    return WikiStore(wiki_root)


@pytest.fixture
def tokens() -> TokenMap:
    return TokenMap(PRIMARY_TOKEN, SECONDARY_TOKEN)
