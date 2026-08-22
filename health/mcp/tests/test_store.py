from __future__ import annotations

import json
from pathlib import Path

import pytest

from health_mcp.auth import Identity
from health_mcp.store import WikiStore
from health_mcp.types import CONFIRMATION_REQUIRED, CashierError


def _lines(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def test_invalid_person_does_not_write(store: WikiStore, identity: Identity, wiki_root: Path) -> None:
    with pytest.raises(CashierError, match="invalid person: alex"):
        store.add_measurement(
            identity,
            kind="weight",
            values={"value": 80},
            person="alex",
        )
    assert not (wiki_root / "data" / "andrii" / "measurements.jsonl").exists()


def test_invalid_status_does_not_write(store: WikiStore, identity: Identity, wiki_root: Path) -> None:
    with pytest.raises(CashierError, match="invalid status: guessed"):
        store.add_measurement(
            identity,
            kind="weight",
            values={"value": 80},
            status="guessed",
        )
    assert not (wiki_root / "data" / "andrii" / "measurements.jsonl").exists()


def test_correction_is_append_only(store: WikiStore, identity: Identity, wiki_root: Path) -> None:
    created = store.add_measurement(
        identity,
        kind="weight",
        values={"value": 120.5, "unit": "kg"},
        event_time="2026-08-04T14:30:00+03:00",
    )
    assert created.outcome == "created"
    path = wiki_root / "data" / "andrii" / "measurements.jsonl"
    original_lines = _lines(path)
    assert len(original_lines) == 1
    assert original_lines[0]["values"] == {"value": 120.5, "unit": "kg"}

    updated = store.correct_measurement(
        identity,
        measurement_id=created.id or "",
        new_values={"value": 118.0, "unit": "kg"},
        reason="scale recalibrated",
        confirmed=True,
    )
    assert updated.outcome == "updated"
    assert updated.id == created.id
    lines = _lines(path)
    assert len(lines) == 2
    assert lines[0] == original_lines[0]
    assert lines[1]["corrects"] == created.id
    assert lines[1]["values"] == {"value": 118.0, "unit": "kg"}

    rows = store.query(identity, section="weight")
    assert rows == [{"event_time": lines[1]["event_time"], "values": {"value": 118.0, "unit": "kg"}}]


def test_correction_with_source_event_id_appends(
    store: WikiStore, identity: Identity, wiki_root: Path
) -> None:
    created = store.add_measurement(
        identity,
        kind="weight",
        values={"value": 120.5, "unit": "kg"},
        event_time="2026-08-04T14:30:00+03:00",
        source_event_id="telegram:1:fact:1",
    )
    path = wiki_root / "data" / "andrii" / "measurements.jsonl"
    original_lines = _lines(path)
    assert len(original_lines) == 1

    updated = store.correct_measurement(
        identity,
        measurement_id=created.id or "",
        new_values={"value": 118.0, "unit": "kg"},
        reason="scale recalibrated",
        confirmed=True,
    )
    assert updated.outcome == "updated"
    assert updated.id == created.id
    lines = _lines(path)
    assert len(lines) == 2
    assert lines[0] == original_lines[0]
    assert lines[1]["corrects"] == created.id
    assert lines[1]["source_event_id"] == "telegram:1:fact:1"
    assert lines[1]["values"] == {"value": 118.0, "unit": "kg"}
    rows = store.query(identity, section="weight")
    assert rows == [{"event_time": lines[1]["event_time"], "values": {"value": 118.0, "unit": "kg"}}]

    retry = store.add_measurement(
        identity,
        kind="weight",
        values={"value": 119.0, "unit": "kg"},
        source_event_id="telegram:1:fact:1",
    )
    assert retry.outcome == "duplicate"
    assert retry.existing_id == created.id
    assert len(_lines(path)) == 2


def test_missing_wiki_root_fails_closed(tmp_path: Path) -> None:
    with pytest.raises(SystemExit, match="missing health wiki directory"):
        WikiStore(tmp_path / "missing-health")


def test_duplicate_source_event_id_is_a_noop(store: WikiStore, identity: Identity, wiki_root: Path) -> None:
    first = store.add_measurement(
        identity,
        kind="weight",
        values={"value": 80},
        source_event_id="telegram:1:fact:1",
    )
    second = store.add_measurement(
        identity,
        kind="weight",
        values={"value": 81},
        source_event_id="telegram:1:fact:1",
    )
    assert first.outcome == "created"
    assert second.outcome == "duplicate"
    assert second.existing_id == first.id
    path = wiki_root / "data" / "andrii" / "measurements.jsonl"
    assert len(_lines(path)) == 1


def test_duplicate_payload_without_source_event_id(store: WikiStore, identity: Identity) -> None:
    first = store.add_measurement(
        identity,
        kind="weight",
        values={"value": 80},
        event_time="2026-08-04T14:30:00+03:00",
    )
    second = store.add_measurement(
        identity,
        kind="weight",
        values={"value": 80},
        event_time="2026-08-04T14:30:00.400+03:00",
    )
    assert first.outcome == "created"
    assert second.outcome == "duplicate"
    assert second.existing_id == first.id


def test_generated_markdown_refreshes_after_write(
    store: WikiStore, identity: Identity, wiki_root: Path
) -> None:
    generated = wiki_root / "generated"
    before = list(generated.glob("*.md"))
    store.add_measurement(
        identity,
        kind="weight",
        values={"value": 80, "unit": "kg"},
        event_time="2026-08-04T14:30:00+03:00",
    )
    after = {path.name: path.read_text(encoding="utf-8") for path in generated.glob("*.md")}
    assert "ANDRII_RECENT_MEASUREMENTS.md" in after
    assert "ANDRII_CURRENT_PROFILE.md" in after
    assert "80" in after["ANDRII_RECENT_MEASUREMENTS.md"]
    assert after["ANDRII_RECENT_MEASUREMENTS.md"] != ""
    assert len(after) >= 13
    assert before == []


def test_confirmation_required_does_not_write(
    store: WikiStore, identity: Identity, wiki_root: Path
) -> None:
    with pytest.raises(CashierError, match=CONFIRMATION_REQUIRED):
        store.add_medication(identity, name="synthetic-med-a")
    assert not (wiki_root / "data" / "andrii" / "medications.jsonl").exists()


def test_stop_medication_appends_and_hides_from_current(
    store: WikiStore, identity: Identity, wiki_root: Path
) -> None:
    created = store.add_medication(
        identity,
        name="synthetic-med-a",
        dose="5 mg",
        schedule="daily",
        confirmed=True,
    )
    stopped = store.stop_medication(
        identity,
        medication_id=created.id or "",
        reason="done",
        confirmed=True,
    )
    assert stopped.outcome == "updated"
    assert stopped.id == created.id
    lines = _lines(wiki_root / "data" / "andrii" / "medications.jsonl")
    assert len(lines) == 2
    assert "stopped_at" not in lines[0]
    assert lines[1]["corrects"] == created.id
    assert store.query(identity, section="medications") == []


def test_sleep_end_must_be_after_start(store: WikiStore, identity: Identity) -> None:
    with pytest.raises(CashierError, match="invalid end_time: must be after start_time"):
        store.add_sleep_record(
            identity,
            start_time="2026-08-04T23:00:00+03:00",
            end_time="2026-08-04T22:00:00+03:00",
        )


def test_query_limit_and_unknown_section(store: WikiStore, identity: Identity) -> None:
    with pytest.raises(CashierError, match="invalid limit: maximum is 200"):
        store.query(identity, section="meals", limit=201)
    with pytest.raises(CashierError, match="unknown section: journal"):
        store.query(identity, section="journal")


def test_default_person_comes_from_token(
    store: WikiStore, identity: Identity, valentyna_identity: Identity
) -> None:
    store.add_measurement(identity, kind="pulse", values={"value": 60})
    store.add_measurement(valentyna_identity, kind="pulse", values={"value": 70})
    andrii_rows = store.query(identity, section="pulse")
    valentyna_rows = store.query(valentyna_identity, section="pulse")
    assert andrii_rows[0]["values"] == {"value": 60}
    assert valentyna_rows[0]["values"] == {"value": 70}
