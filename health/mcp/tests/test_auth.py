from __future__ import annotations

from pathlib import Path

import pytest

from health_mcp.auth import TokenMap, _read_token


def test_token_map_resolves_each_profile(tmp_path: Path) -> None:
    primary = tmp_path / "primary"
    secondary = tmp_path / "secondary"
    primary.write_text(" primary-secret\n", encoding="utf-8")
    secondary.write_text("secondary-secret\r\n", encoding="utf-8")
    tokens = TokenMap(primary.read_text().strip(), secondary.read_text().strip())

    primary_id = tokens.resolve("primary-secret")
    assert primary_id is not None
    assert primary_id.actor == "primary"
    assert primary_id.via == "hermes_primary"
    assert primary_id.default_person == "primary"

    secondary_id = tokens.resolve("secondary-secret")
    assert secondary_id is not None
    assert secondary_id.actor == "secondary"
    assert secondary_id.via == "hermes_secondary"
    assert secondary_id.default_person == "secondary"
    assert tokens.resolve("unknown-secret") is None


def test_identical_tokens_fail_closed() -> None:
    with pytest.raises(SystemExit, match="must differ"):
        TokenMap("same-secret", "same-secret")


def test_unreadable_token_file_fails_closed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    token = tmp_path / "primary.health_api_token"
    token.write_text("primary-secret", encoding="utf-8")

    def deny(_self: Path, *_args: object, **_kwargs: object) -> str:
        raise PermissionError("denied")

    monkeypatch.setattr(Path, "read_text", deny)
    with pytest.raises(SystemExit, match="unreadable health token file"):
        _read_token(str(token))
