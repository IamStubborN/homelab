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
    assert not (wiki_root / "data" / "primary" / "measurements.jsonl").exists()


def test_invalid_status_does_not_write(store: WikiStore, identity: Identity, wiki_root: Path) -> None:
    with pytest.raises(CashierError, match="invalid status: guessed"):
        store.add_measurement(
            identity,
            kind="weight",
            values={"value": 80},
            status="guessed",
        )
    assert not (wiki_root / "data" / "primary" / "measurements.jsonl").exists()


def test_correction_is_append_only(store: WikiStore, identity: Identity, wiki_root: Path) -> None:
    created = store.add_measurement(
        identity,
        kind="weight",
        values={"value": 120.5, "unit": "kg"},
        event_time="2026-08-04T14:30:00+03:00",
    )
    assert created.outcome == "created"
    path = wiki_root / "data" / "primary" / "measurements.jsonl"
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
    path = wiki_root / "data" / "primary" / "measurements.jsonl"
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
    path = wiki_root / "data" / "primary" / "measurements.jsonl"
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
    assert "PRIMARY_RECENT_MEASUREMENTS.md" in after
    assert "PRIMARY_CURRENT_PROFILE.md" in after
    assert "80" in after["PRIMARY_RECENT_MEASUREMENTS.md"]
    assert after["PRIMARY_RECENT_MEASUREMENTS.md"] != ""
    assert len(after) >= 13
    assert before == []


def test_confirmation_required_does_not_write(
    store: WikiStore, identity: Identity, wiki_root: Path
) -> None:
    with pytest.raises(CashierError, match=CONFIRMATION_REQUIRED):
        store.add_medication(identity, name="synthetic-med-a")
    assert not (wiki_root / "data" / "primary" / "medications.jsonl").exists()


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
    lines = _lines(wiki_root / "data" / "primary" / "medications.jsonl")
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
    store: WikiStore, identity: Identity, secondary_identity: Identity
) -> None:
    store.add_measurement(identity, kind="pulse", values={"value": 60})
    store.add_measurement(secondary_identity, kind="pulse", values={"value": 70})
    primary_rows = store.query(identity, section="pulse")
    secondary_rows = store.query(secondary_identity, section="pulse")
    assert primary_rows[0]["values"] == {"value": 60}
    assert secondary_rows[0]["values"] == {"value": 70}


def test_committed_measurement_survives_projection_failure_and_retry_repairs_it(
    store: WikiStore, identity: Identity, wiki_root: Path
) -> None:
    generated = wiki_root / 'generated'
    generated.rmdir()
    generated.write_text('synthetic projection filesystem failure')
    created = store.add_measurement(
        identity, kind='weight', values={'value': 80}, source_event_id='test:projection:1'
    )
    assert created.outcome == 'created'
    assert created.as_dict()['projection_pending'] is True
    assert store.query(identity, section='weight')[0]['values'] == {'value': 80}

    generated.unlink()
    generated.mkdir()
    retry = store.add_measurement(
        identity, kind='weight', values={'value': 80}, source_event_id='test:projection:1'
    )
    assert retry.outcome == 'duplicate'
    assert retry.existing_id == created.id
    assert 'projection_pending' not in retry.as_dict()
    assert len(store.query(identity, section='weight')) == 1
    assert '80' in (generated / 'PRIMARY_RECENT_MEASUREMENTS.md').read_text()


def test_medication_transport_retry_does_not_create_another_prescription(
    store: WikiStore, identity: Identity, wiki_root: Path
) -> None:
    generated = wiki_root / 'generated'
    generated.rmdir()
    generated.write_text('synthetic projection filesystem failure')
    created = store.add_medication(
        identity, name='synthetic-med-a', confirmed=True, source_event_id='test:medication:1'
    )
    assert created.outcome == 'created'
    assert created.projection_pending
    generated.unlink()
    generated.mkdir()
    retry = store.add_medication(
        identity, name='synthetic-med-a', confirmed=True, source_event_id='test:medication:1'
    )
    assert retry.outcome == 'duplicate'
    assert retry.existing_id == created.id
    assert not retry.projection_pending
    assert len(store.query(identity, section='medications')) == 1
    separate = store.add_medication(
        identity, name='synthetic-med-a', confirmed=True, source_event_id='test:medication:2'
    )
    assert separate.outcome == 'created'
    assert len(store.query(identity, section='medications')) == 2


def test_resolve_active_indexes_history_once_and_preserves_correction_winners() -> None:
    from health_mcp.store import resolve_active

    class Event(dict):
        id_reads = 0

        def __getitem__(self, key):
            if key == 'id':
                type(self).id_reads += 1
            return super().__getitem__(key)

    events = [Event(id=str(i), created_at='2026-01-01') for i in range(1000)]
    events.extend([
        Event(id='a', corrects='0', created_at='2026-01-02'),
        Event(id='b', corrects='a', created_at='2026-01-03'),
        Event(id='c', corrects='0', created_at='2026-01-04'),
    ])
    active = resolve_active(events)
    assert {row['id'] for row in active} == {str(i) for i in range(1, 1000)} | {'c'}
    assert Event.id_reads < len(events) * 15


@pytest.mark.parametrize('operation', ['correction', 'stop'])
def test_committed_update_reports_projection_failure_without_losing_the_update(
    store: WikiStore, identity: Identity, wiki_root: Path, operation: str
) -> None:
    if operation == 'correction':
        original = store.add_measurement(identity, kind='weight', values={'value': 80})
    else:
        original = store.add_medication(identity, name='synthetic-med-a', confirmed=True)
    generated = wiki_root / 'generated'
    generated.rename(wiki_root / 'saved-generated')
    generated.write_text('synthetic projection filesystem failure')
    if operation == 'correction':
        updated = store.correct_measurement(identity, measurement_id=original.id,
            new_values={'value': 81}, reason='synthetic correction', confirmed=True)
        assert store.query(identity, section='weight')[0]['values'] == {'value': 81}
    else:
        updated = store.stop_medication(identity, medication_id=original.id, confirmed=True)
        assert store.query(identity, section='medications') == []
    assert updated.outcome == 'updated'
    assert updated.id == original.id
    assert updated.projection_pending
