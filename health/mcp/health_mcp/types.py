from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Any, Final

PERSONS: Final[frozenset[str]] = frozenset({"andrii", "valentyna"})
VIA_CHANNELS: Final[frozenset[str]] = frozenset(
    {"hermes_andrii", "hermes_valentyna", "system"}
)
FACT_STATUSES: Final[frozenset[str]] = frozenset(
    {
        "confirmed_by_doctor",
        "confirmed_by_document",
        "user_reported",
        "suspected",
        "model_inference",
        "historical_uncertain",
        "resolved",
    }
)
MEASUREMENT_KINDS: Final[frozenset[str]] = frozenset(
    {"blood_pressure", "weight", "pulse", "temperature", "spo2", "glucose"}
)
DEFAULT_STATUS: Final[str] = "user_reported"
MAX_QUERY_LIMIT: Final[int] = 200
DEFAULT_QUERY_LIMIT: Final[int] = 20
MAX_CHART_DAYS: Final[int] = 3650
DEFAULT_CHART_DAYS: Final[int] = 30
MAX_CHART_POINTS: Final[int] = 2000
MAX_SOURCE_EVENT_ID_BYTES: Final[int] = 200
CONFIRMATION_REQUIRED: Final[str] = (
    "confirmation_required: ask the user to confirm with the ✅ card, "
    "then retry with confirmed=true"
)
SOURCE_EVENT_ID_DESCRIPTION: Final[str] = (
    "Stable transport source identity plus a deterministic per-fact ordinal."
)

JSONL_FILES: Final[dict[str, str]] = {
    "measurement": "measurements.jsonl",
    "meal": "meals.jsonl",
    "symptom": "symptoms.jsonl",
    "sleep_record": "sleep.jsonl",
    "medication": "medications.jsonl",
    "condition": "conditions.jsonl",
    "allergy": "allergies.jsonl",
    "lab_result": "labs.jsonl",
}

QUERY_SECTIONS: Final[frozenset[str]] = frozenset(
    {
        "medications",
        "blood_pressure",
        "weight",
        "pulse",
        "temperature",
        "spo2",
        "glucose",
        "measurements",
        "meals",
        "symptoms",
        "sleep",
        "conditions",
        "allergies",
        "labs",
    }
)

SECTION_TO_EVENT_TYPE: Final[dict[str, str]] = {
    "measurements": "measurement",
    "meals": "meal",
    "symptoms": "symptom",
    "sleep": "sleep_record",
    "medications": "medication",
    "conditions": "condition",
    "allergies": "allergy",
    "labs": "lab_result",
}


class CashierError(Exception):
    """Tool-facing cashier error; message is returned as MCP tool error text."""


def parse_person(value: str, field: str = "person") -> str:
    if value not in PERSONS:
        raise CashierError(f"invalid {field}: {value}")
    return value


def parse_status(value: str, field: str = "status") -> str:
    if value not in FACT_STATUSES:
        raise CashierError(f"invalid {field}: {value}")
    return value


def parse_kind(value: str, field: str = "kind") -> str:
    if value not in MEASUREMENT_KINDS:
        raise CashierError(f"invalid {field}: {value}")
    return value


def parse_rfc3339(value: str, field: str) -> datetime:
    raw = value.strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError as exc:
        raise CashierError(f"invalid {field}: {value}") from exc
    if parsed.tzinfo is None:
        raise CashierError(f"invalid {field}: {value}")
    return parsed


def parse_optional_rfc3339(value: str | None, field: str) -> datetime | None:
    if value is None:
        return None
    return parse_rfc3339(value, field)


def parse_date(value: str, field: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise CashierError(f"invalid {field}: {value}") from exc


def parse_optional_date(value: str | None, field: str) -> date | None:
    if value is None:
        return None
    return parse_date(value, field)


def now_utc() -> datetime:
    return datetime.now(UTC)


def format_rfc3339(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def unix_seconds(value: datetime) -> int:
    return int(value.timestamp())


def utc_date(value: datetime) -> date:
    return value.astimezone(UTC).date()


def validate_source_event_id(value: str | None) -> str | None:
    if value is None:
        return None
    encoded = value.encode("utf-8")
    if (
        not encoded
        or len(encoded) > MAX_SOURCE_EVENT_ID_BYTES
        or any(byte < 0x21 or byte > 0x7E for byte in encoded)
    ):
        raise CashierError(
            "invalid source_event_id: must be 1-200 printable ASCII bytes without spaces"
        )
    return value


def require_confirmation(confirmed: bool | None) -> None:
    if confirmed is not True:
        raise CashierError(CONFIRMATION_REQUIRED)


def parse_uuid(value: str, field: str) -> str:
    from uuid import UUID

    try:
        return str(UUID(value))
    except ValueError as exc:
        raise CashierError(f"invalid {field}: {value}") from exc


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool)


def _object_with_fields(
    values: Any, allowed: tuple[str, ...], required: str
) -> dict[str, Any]:
    if not isinstance(values, dict):
        raise CashierError(f"missing or invalid field: {required}")
    for field in values:
        if field not in allowed:
            raise CashierError(f"unexpected field: {field}")
    return values


def _integer_in_range(
    values: dict[str, Any], field: str, minimum: int, maximum: int
) -> None:
    raw = values.get(field)
    if not _is_int(raw):
        raise CashierError(f"missing or invalid field: {field}")
    if not (minimum <= raw <= maximum):
        raise CashierError(f"field {field} is out of range: {float(raw)}")


def _number_in_range(
    values: dict[str, Any], field: str, minimum: float, maximum: float
) -> None:
    raw = values.get(field)
    if not _is_number(raw):
        raise CashierError(f"missing or invalid field: {field}")
    number = float(raw)
    if not (minimum <= number <= maximum):
        raise CashierError(f"field {field} is out of range: {number}")


def _exact_optional_unit(values: dict[str, Any], expected: str) -> None:
    if "unit" in values and values["unit"] != expected:
        raise CashierError("missing or invalid field: unit")


def validate_measurement(kind: str, values: Any) -> None:
    if kind == "blood_pressure":
        parsed = _object_with_fields(values, ("systolic", "diastolic", "pulse"), "systolic")
        _integer_in_range(parsed, "systolic", 50, 300)
        _integer_in_range(parsed, "diastolic", 30, 200)
        if "pulse" in parsed:
            _integer_in_range(parsed, "pulse", 20, 250)
        return
    if kind == "weight":
        parsed = _object_with_fields(values, ("value", "unit"), "value")
        _number_in_range(parsed, "value", 20.0, 400.0)
        _exact_optional_unit(parsed, "kg")
        return
    if kind == "pulse":
        parsed = _object_with_fields(values, ("value",), "value")
        _integer_in_range(parsed, "value", 20, 250)
        return
    if kind == "temperature":
        parsed = _object_with_fields(values, ("value", "unit"), "value")
        _number_in_range(parsed, "value", 34.0, 43.0)
        _exact_optional_unit(parsed, "c")
        return
    if kind == "spo2":
        parsed = _object_with_fields(values, ("value",), "value")
        _integer_in_range(parsed, "value", 50, 100)
        return
    if kind == "glucose":
        parsed = _object_with_fields(values, ("value", "unit"), "value")
        _number_in_range(parsed, "value", 1.0, 40.0)
        _exact_optional_unit(parsed, "mmol_l")
        return
    raise CashierError(f"invalid kind: {kind}")


def event_type_for_measurement(kind: str) -> str:
    return parse_kind(kind)


def normalized_payload(event_type: str, event: dict[str, Any]) -> Any:
    if event_type in MEASUREMENT_KINDS:
        return event.get("values")
    if event_type == "meal":
        return {"description": event.get("description"), "calories": event.get("calories")}
    if event_type == "symptom":
        return {"description": event.get("description"), "severity": event.get("severity")}
    if event_type == "sleep_record":
        return {"start": event.get("start_time"), "end": event.get("end_time")}
    if event_type == "lab_result":
        return {
            "test_name": event.get("test_name"),
            "test_date": event.get("test_date"),
            "value": event.get("value"),
        }
    return None


def dedup_event_time_seconds(event_type: str, event: dict[str, Any]) -> int | None:
    if event_type == "sleep_record":
        return unix_seconds(parse_rfc3339(event["start_time"], "start_time"))
    if event_type == "lab_result":
        midnight = datetime.fromisoformat(f"{event['test_date']}T00:00:00+00:00")
        return unix_seconds(midnight)
    raw = event.get("event_time")
    if not raw:
        return None
    return unix_seconds(parse_rfc3339(raw, "event_time"))
