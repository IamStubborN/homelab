from __future__ import annotations

from pathlib import Path

import pytest

from health_mcp.auth import TokenMap, _read_token


def test_token_map_resolves_each_profile(tmp_path: Path) -> None:
    andrii = tmp_path / "andrii"
    valentyna = tmp_path / "valentyna"
    andrii.write_text(" andrii-secret\n", encoding="utf-8")
    valentyna.write_text("valentyna-secret\r\n", encoding="utf-8")
    tokens = TokenMap(andrii.read_text().strip(), valentyna.read_text().strip())

    andrii_id = tokens.resolve("andrii-secret")
    assert andrii_id is not None
    assert andrii_id.actor == "andrii"
    assert andrii_id.via == "hermes_andrii"
    assert andrii_id.default_person == "andrii"

    valentyna_id = tokens.resolve("valentyna-secret")
    assert valentyna_id is not None
    assert valentyna_id.actor == "valentyna"
    assert valentyna_id.via == "hermes_valentyna"
    assert valentyna_id.default_person == "valentyna"
    assert tokens.resolve("unknown-secret") is None


def test_identical_tokens_fail_closed() -> None:
    with pytest.raises(SystemExit, match="must differ"):
        TokenMap("same-secret", "same-secret")


def test_unreadable_token_file_fails_closed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    token = tmp_path / "andrii.health_api_token"
    token.write_text("andrii-secret", encoding="utf-8")

    def deny(_self: Path, *_args: object, **_kwargs: object) -> str:
        raise PermissionError("denied")

    monkeypatch.setattr(Path, "read_text", deny)
    with pytest.raises(SystemExit, match="unreadable health token file"):
        _read_token(str(token))
