from __future__ import annotations

import pytest

from health_mcp.types import (
    CashierError,
    parse_person,
    parse_status,
    validate_measurement,
    validate_source_event_id,
)


def test_invalid_person_is_rejected() -> None:
    with pytest.raises(CashierError, match="invalid person: alex"):
        parse_person("alex")


def test_invalid_status_is_rejected() -> None:
    with pytest.raises(CashierError, match="invalid status: guessed"):
        parse_status("guessed")


def test_valid_person_and_status_round_trip() -> None:
    assert parse_person("andrii") == "andrii"
    assert parse_status("user_reported") == "user_reported"
    assert parse_status("confirmed_by_doctor") == "confirmed_by_doctor"


def test_measurement_ranges_and_extra_keys() -> None:
    validate_measurement("blood_pressure", {"systolic": 120, "diastolic": 80, "pulse": 60})
    validate_measurement("weight", {"value": 80, "unit": "kg"})
    with pytest.raises(CashierError, match="field value is out of range: 600.0"):
        validate_measurement("weight", {"value": 600, "unit": "kg"})
    with pytest.raises(CashierError, match="unexpected field: note"):
        validate_measurement("pulse", {"value": 80, "note": "x"})
    with pytest.raises(CashierError, match="missing or invalid field: value"):
        validate_measurement("pulse", {"value": 80.5})
    with pytest.raises(CashierError, match="missing or invalid field: unit"):
        validate_measurement("glucose", {"value": 5.5, "unit": "mg_dl"})


def test_source_event_id_charset() -> None:
    assert validate_source_event_id("telegram:42:fact:1") == "telegram:42:fact:1"
    for invalid in ("", "contains space", "x" * 201):
        with pytest.raises(CashierError, match="invalid source_event_id"):
            validate_source_event_id(invalid)
