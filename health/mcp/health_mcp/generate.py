from __future__ import annotations

from pathlib import Path
from typing import Any

from health_mcp.types import MEASUREMENT_KINDS

PERSON_LABEL = {"andrii": "Andrii", "valentyna": "Valentyna"}

GENERATED_NAMES = (
    "ANDRII_CURRENT_PROFILE.md",
    "VALENTYNA_CURRENT_PROFILE.md",
    "ANDRII_CURRENT_MEDICATIONS.md",
    "VALENTYNA_CURRENT_MEDICATIONS.md",
    "ANDRII_RECENT_MEASUREMENTS.md",
    "VALENTYNA_RECENT_MEASUREMENTS.md",
    "ANDRII_RECENT_LABS.md",
    "VALENTYNA_RECENT_LABS.md",
    "ANDRII_DIET_CONTEXT.md",
    "VALENTYNA_DIET_CONTEXT.md",
    "VALENTYNA_ALLERGIES.md",
    "VALENTYNA_CYCLE_CONTEXT.md",
    "FAMILY_DIET_SNAPSHOTS.md",
)

_HEADER = "Generated from append-only health jsonl. Do not edit."


def regenerate(root: Path, ledger: dict[str, dict[str, list[dict[str, Any]]]]) -> list[Path]:
    generated = root / "generated"
    generated.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for person in ("andrii", "valentyna"):
        events = ledger.get(person, {})
        written.append(_write(generated / f"{person.upper()}_CURRENT_PROFILE.md", _profile(person, events)))
        written.append(
            _write(generated / f"{person.upper()}_CURRENT_MEDICATIONS.md", _medications(person, events))
        )
        written.append(
            _write(generated / f"{person.upper()}_RECENT_MEASUREMENTS.md", _measurements(person, events))
        )
        written.append(_write(generated / f"{person.upper()}_RECENT_LABS.md", _labs(person, events)))
        written.append(_write(generated / f"{person.upper()}_DIET_CONTEXT.md", _diet(person, events)))
    written.append(
        _write(generated / "VALENTYNA_ALLERGIES.md", _allergies("valentyna", ledger.get("valentyna", {})))
    )
    written.append(_write(generated / "VALENTYNA_CYCLE_CONTEXT.md", _cycle_stub()))
    written.append(_write(generated / "FAMILY_DIET_SNAPSHOTS.md", _family_diet(ledger)))
    return written


def _write(path: Path, body: str) -> Path:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(body if body.endswith("\n") else body + "\n", encoding="utf-8")
    tmp.replace(path)
    return path


def _profile(person: str, events: dict[str, list[dict[str, Any]]]) -> str:
    label = PERSON_LABEL[person]
    lines = [f"# {label} — current profile", "", _HEADER, "", "## Conditions"]
    lines.extend(_condition_lines(events.get("condition", [])) or ["- none"])
    lines.extend(["", "## Allergies"])
    lines.extend(_allergy_lines(events.get("allergy", [])) or ["- none"])
    lines.extend(["", "## Current medications"])
    lines.extend(_medication_lines(events.get("medication", [])) or ["- none"])
    lines.extend(["", "## Latest measurements"])
    lines.extend(_measurement_lines(events.get("measurement", []), limit=10) or ["- none"])
    lines.extend(["", "## Recent labs"])
    lines.extend(_lab_lines(events.get("lab_result", []), limit=10) or ["- none"])
    lines.append("")
    return "\n".join(lines)


def _medications(person: str, events: dict[str, list[dict[str, Any]]]) -> str:
    label = PERSON_LABEL[person]
    lines = [f"# {label} — current medications", "", _HEADER, ""]
    lines.extend(_medication_lines(events.get("medication", [])) or ["- none"])
    lines.append("")
    return "\n".join(lines)


def _measurements(person: str, events: dict[str, list[dict[str, Any]]]) -> str:
    label = PERSON_LABEL[person]
    lines = [f"# {label} — recent measurements", "", _HEADER, ""]
    lines.extend(_measurement_lines(events.get("measurement", []), limit=50) or ["- none"])
    lines.append("")
    return "\n".join(lines)


def _labs(person: str, events: dict[str, list[dict[str, Any]]]) -> str:
    label = PERSON_LABEL[person]
    lines = [f"# {label} — recent labs", "", _HEADER, ""]
    lines.extend(_lab_lines(events.get("lab_result", []), limit=50) or ["- none"])
    lines.append("")
    return "\n".join(lines)


def _diet(person: str, events: dict[str, list[dict[str, Any]]]) -> str:
    label = PERSON_LABEL[person]
    lines = [f"# {label} — diet context", "", _HEADER, ""]
    lines.extend(_meal_lines(events.get("meal", []), limit=20) or ["- none"])
    lines.append("")
    return "\n".join(lines)


def _allergies(person: str, events: dict[str, list[dict[str, Any]]]) -> str:
    label = PERSON_LABEL[person]
    lines = [f"# {label} — allergies", "", _HEADER, ""]
    lines.extend(_allergy_lines(events.get("allergy", [])) or ["- none"])
    lines.append("")
    return "\n".join(lines)


def _cycle_stub() -> str:
    return (
        "# Valentyna — cycle context\n"
        "\n"
        f"{_HEADER}\n"
        "\n"
        "Stub until cycle facts are ingested.\n"
    )


def _family_diet(ledger: dict[str, dict[str, list[dict[str, Any]]]]) -> str:
    lines = ["# Family diet snapshots", "", _HEADER, ""]
    for person in ("andrii", "valentyna"):
        lines.append(f"## {PERSON_LABEL[person]}")
        meals = ledger.get(person, {}).get("meal", [])
        lines.extend(_meal_lines(meals, limit=10) or ["- none"])
        lines.append("")
    return "\n".join(lines)


def _condition_lines(rows: list[dict[str, Any]]) -> list[str]:
    lines = []
    for row in _sorted(rows, "diagnosed_at", "created_at"):
        diagnosed = row.get("diagnosed_at") or "undated"
        extra = f", {row['notes']}" if row.get("notes") else ""
        lines.append(f"- {row.get('name')} ({row.get('status')}, diagnosed {diagnosed}{extra})")
    return lines


def _allergy_lines(rows: list[dict[str, Any]]) -> list[str]:
    lines = []
    for row in _sorted(rows, "created_at"):
        detail = []
        if row.get("reaction"):
            detail.append(row["reaction"])
        if row.get("severity"):
            detail.append(row["severity"])
        suffix = f" — {', '.join(detail)}" if detail else ""
        lines.append(f"- {row.get('allergen')} ({row.get('status')}{suffix})")
    return lines


def _medication_lines(rows: list[dict[str, Any]]) -> list[str]:
    current = [row for row in rows if not row.get("stopped_at")]
    lines = []
    for row in _sorted(current, "started_at"):
        dose = row.get("dose") or "unspecified dose"
        schedule = row.get("schedule") or "unspecified schedule"
        lines.append(
            f"- {row.get('name')} ({dose}; {schedule}; started {row.get('started_at')})"
        )
    return lines


def _measurement_lines(rows: list[dict[str, Any]], *, limit: int) -> list[str]:
    ordered = list(reversed(_sorted(rows, "event_time", "created_at")))[:limit]
    lines = []
    for row in ordered:
        kind = row.get("kind")
        if kind not in MEASUREMENT_KINDS:
            kind = "measurement"
        lines.append(f"- {row.get('event_time')} {kind} {row.get('values')}")
    return lines


def _lab_lines(rows: list[dict[str, Any]], *, limit: int) -> list[str]:
    ordered = list(reversed(_sorted(rows, "test_date", "created_at")))[:limit]
    lines = []
    for row in ordered:
        unit = f" {row['unit']}" if row.get("unit") else ""
        flag = f" [{row['flag']}]" if row.get("flag") else ""
        lines.append(f"- {row.get('test_date')} {row.get('test_name')}: {row.get('value')}{unit}{flag}")
    return lines


def _meal_lines(rows: list[dict[str, Any]], *, limit: int) -> list[str]:
    ordered = list(reversed(_sorted(rows, "event_time", "created_at")))[:limit]
    lines = []
    for row in ordered:
        calories = f" ({row['calories']} kcal)" if row.get("calories") is not None else ""
        lines.append(f"- {row.get('event_time')}: {row.get('description')}{calories}")
    return lines


def _sorted(rows: list[dict[str, Any]], *keys: str) -> list[dict[str, Any]]:
    def sort_key(row: dict[str, Any]) -> tuple[str, str]:
        for key in keys:
            value = row.get(key)
            if value:
                return (str(value), row.get("id") or "")
        return ("", row.get("id") or "")

    return sorted(rows, key=sort_key)
