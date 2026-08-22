from pathlib import Path

from health_mcp.ingest.run import identity_for
from health_mcp.store import WikiStore


def test_system_identity_is_not_a_hermes_token() -> None:
    ident = identity_for("andrii")
    assert ident.actor == "andrii"
    assert ident.via == "system"
    assert ident.default_person == "andrii"
    val = identity_for("valentyna")
    assert val.via == "system"
    assert val.actor == "valentyna"


def test_ingest_identity_writes_via_system(store: WikiStore, wiki_root: Path) -> None:
    outcome = store.add_measurement(
        identity_for("andrii"),
        kind="weight",
        values={"value": 80.0, "unit": "kg"},
        person="andrii",
        event_time="2026-07-24T10:00:00+03:00",
        source_event_id="xlsx:weight:r5:andrii",
        status="user_reported",
    )
    assert outcome.outcome == "created"
    retry = store.add_measurement(
        identity_for("andrii"),
        kind="weight",
        values={"value": 80.0, "unit": "kg"},
        person="andrii",
        event_time="2026-07-24T10:00:00+03:00",
        source_event_id="xlsx:weight:r5:andrii",
        status="user_reported",
    )
    assert retry.outcome == "duplicate"
    line = (wiki_root / "data" / "andrii" / "measurements.jsonl").read_text(encoding="utf-8")
    assert '"via":"system"' in line
    assert "hermes_" not in line
