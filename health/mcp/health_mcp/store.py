from __future__ import annotations

import fcntl
import json
import threading
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from health_mcp import generate
from health_mcp.auth import Identity
from health_mcp.charts import render_measurement_chart
from health_mcp.types import (
    DEFAULT_CHART_DAYS,
    DEFAULT_QUERY_LIMIT,
    DEFAULT_STATUS,
    JSONL_FILES,
    MAX_CHART_DAYS,
    MAX_CHART_POINTS,
    MAX_QUERY_LIMIT,
    MEASUREMENT_KINDS,
    QUERY_SECTIONS,
    SECTION_TO_EVENT_TYPE,
    CashierError,
    dedup_event_time_seconds,
    format_rfc3339,
    normalized_payload,
    now_utc,
    parse_date,
    parse_kind,
    parse_optional_date,
    parse_optional_rfc3339,
    parse_person,
    parse_rfc3339,
    parse_status,
    parse_uuid,
    require_confirmation,
    utc_date,
    validate_measurement,
    validate_source_event_id,
)


@dataclass(frozen=True)
class WriteOutcome:
    outcome: str
    id: str | None = None
    existing_id: str | None = None

    def as_dict(self) -> dict[str, str]:
        if self.outcome == "duplicate":
            return {"outcome": "duplicate", "existing_id": self.existing_id or ""}
        return {"outcome": self.outcome, "id": self.id or ""}


class WikiStore:
    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        if not self.root.is_dir():
            raise SystemExit(f"missing health wiki directory: {self.root}")
        self._lock = threading.Lock()

    def add_measurement(
        self,
        identity: Identity,
        *,
        kind: str,
        values: dict[str, Any],
        person: str | None = None,
        source: str | None = None,
        status: str | None = None,
        event_time: str | None = None,
        source_event_id: str | None = None,
    ) -> WriteOutcome:
        parsed_kind = parse_kind(kind)
        validate_measurement(parsed_kind, values)
        event = self._base_event(identity, person, status, event_time)
        event.update(
            {
                "kind": parsed_kind,
                "values": values,
                "source": source,
                "source_event_id": validate_source_event_id(source_event_id),
            }
        )
        return self._append("measurement", event, parsed_kind)

    def correct_measurement(
        self,
        identity: Identity,
        *,
        measurement_id: str,
        new_values: dict[str, Any],
        reason: str,
        confirmed: bool | None = None,
    ) -> WriteOutcome:
        require_confirmation(confirmed)
        target_id = parse_uuid(measurement_id, "measurement_id")
        with self._lock:
            events = self._read_person_file_locked(None, "measurement")
            original = self._find_by_id(events, target_id)
            if original is None:
                raise CashierError("not found")
            kind = parse_kind(original["kind"])
            validate_measurement(kind, new_values)
            person = original["person"]
            event = self._base_event(identity, person, original.get("status"), original.get("event_time"))
            event.update(
                {
                    "kind": kind,
                    "values": new_values,
                    "source": original.get("source"),
                    "source_event_id": original.get("source_event_id"),
                    "corrects": original["id"],
                    "reason": reason,
                }
            )
            outcome = self._append_locked(
                "measurement", person, event, kind, dedup=False
            )
            if outcome.outcome != "created":
                raise CashierError("correction append failed")
            generate.regenerate(self.root, self._active_ledger())
        return WriteOutcome("updated", id=original["id"])

    def add_meal(
        self,
        identity: Identity,
        *,
        description: str,
        person: str | None = None,
        items: Any = None,
        calories: int | None = None,
        status: str | None = None,
        event_time: str | None = None,
        source_event_id: str | None = None,
    ) -> WriteOutcome:
        event = self._base_event(identity, person, status, event_time)
        event.update(
            {
                "description": description,
                "items": items,
                "calories": calories,
                "source_event_id": validate_source_event_id(source_event_id),
            }
        )
        return self._append("meal", event, "meal")

    def add_symptom(
        self,
        identity: Identity,
        *,
        description: str,
        person: str | None = None,
        severity: int | None = None,
        status: str | None = None,
        event_time: str | None = None,
        source_event_id: str | None = None,
    ) -> WriteOutcome:
        event = self._base_event(identity, person, status, event_time)
        event.update(
            {
                "description": description,
                "severity": severity,
                "source_event_id": validate_source_event_id(source_event_id),
            }
        )
        return self._append("symptom", event, "symptom")

    def add_sleep_record(
        self,
        identity: Identity,
        *,
        start_time: str,
        end_time: str,
        person: str | None = None,
        quality: int | None = None,
        notes: str | None = None,
        status: str | None = None,
        source_event_id: str | None = None,
    ) -> WriteOutcome:
        start = parse_rfc3339(start_time, "start_time")
        end = parse_rfc3339(end_time, "end_time")
        if end <= start:
            raise CashierError("invalid end_time: must be after start_time")
        event = self._base_event(identity, person, status, format_rfc3339(start))
        event.update(
            {
                "start_time": format_rfc3339(start),
                "end_time": format_rfc3339(end),
                "quality": quality,
                "notes": notes,
                "source_event_id": validate_source_event_id(source_event_id),
            }
        )
        return self._append("sleep_record", event, "sleep_record")

    def add_medication(
        self,
        identity: Identity,
        *,
        name: str,
        person: str | None = None,
        dose: str | None = None,
        schedule: str | None = None,
        started_at: str | None = None,
        status: str | None = None,
        confirmed: bool | None = None,
    ) -> WriteOutcome:
        require_confirmation(confirmed)
        started = parse_optional_rfc3339(started_at, "started_at") or now_utc()
        event = self._base_event(identity, person, status, format_rfc3339(started))
        event.update(
            {
                "name": name,
                "dose": dose,
                "schedule": schedule,
                "started_at": format_rfc3339(started),
            }
        )
        return self._append("medication", event, "medication", dedup=False)

    def stop_medication(
        self,
        identity: Identity,
        *,
        medication_id: str,
        person: str | None = None,
        stopped_at: str | None = None,
        reason: str | None = None,
        confirmed: bool | None = None,
    ) -> WriteOutcome:
        require_confirmation(confirmed)
        target_id = parse_uuid(medication_id, "medication_id")
        resolved_person = parse_person(person or identity.default_person)
        stopped = parse_optional_rfc3339(stopped_at, "stopped_at") or now_utc()
        with self._lock:
            events = self._read_file_locked(resolved_person, "medication")
            current = self._active_by_id(events, target_id)
            if current is None or current.get("person") != resolved_person:
                raise CashierError("not found")
            if current.get("stopped_at"):
                raise CashierError("not found")
            started = parse_rfc3339(current["started_at"], "started_at")
            if stopped < started:
                raise CashierError("rejected: stopped_at must not be before started_at")
            event = self._base_event(
                identity, resolved_person, current.get("status"), format_rfc3339(stopped)
            )
            event.update(
                {
                    "name": current.get("name"),
                    "dose": current.get("dose"),
                    "schedule": current.get("schedule"),
                    "started_at": current.get("started_at"),
                    "stopped_at": format_rfc3339(stopped),
                    "stop_reason": reason,
                    "corrects": current["id"],
                }
            )
            self._append_locked("medication", resolved_person, event, "medication", dedup=False)
            generate.regenerate(self.root, self._active_ledger())
        return WriteOutcome("updated", id=self._root_id(events, current["id"]))

    def add_condition(
        self,
        identity: Identity,
        *,
        name: str,
        person: str | None = None,
        notes: str | None = None,
        diagnosed_at: str | None = None,
        status: str | None = None,
        confirmed: bool | None = None,
    ) -> WriteOutcome:
        require_confirmation(confirmed)
        diagnosed = parse_optional_date(diagnosed_at, "diagnosed_at")
        event = self._base_event(identity, person, status, None)
        event.update(
            {
                "name": name,
                "notes": notes,
                "diagnosed_at": diagnosed.isoformat() if diagnosed else None,
            }
        )
        return self._append("condition", event, "condition", dedup=False)

    def add_allergy(
        self,
        identity: Identity,
        *,
        allergen: str,
        person: str | None = None,
        reaction: str | None = None,
        severity: str | None = None,
        status: str | None = None,
    ) -> WriteOutcome:
        event = self._base_event(identity, person, status, None)
        event.update(
            {
                "allergen": allergen,
                "reaction": reaction,
                "severity": severity,
            }
        )
        return self._append("allergy", event, "allergy", dedup=False)

    def add_lab_result(
        self,
        identity: Identity,
        *,
        test_date: str,
        test_name: str,
        value: float,
        person: str | None = None,
        unit: str | None = None,
        reference_min: float | None = None,
        reference_max: float | None = None,
        flag: str | None = None,
        laboratory: str | None = None,
        source_document: str | None = None,
        status: str | None = None,
    ) -> WriteOutcome:
        parsed_date = parse_date(test_date, "test_date")
        event = self._base_event(identity, person, status, f"{parsed_date.isoformat()}T00:00:00Z")
        event.update(
            {
                "test_date": parsed_date.isoformat(),
                "test_name": test_name,
                "value": value,
                "unit": unit,
                "reference_min": reference_min,
                "reference_max": reference_max,
                "flag": flag,
                "laboratory": laboratory,
                "source_document": source_document,
            }
        )
        return self._append("lab_result", event, "lab_result")

    def query(
        self,
        identity: Identity,
        *,
        section: str,
        person: str | None = None,
        limit: int | None = None,
        from_time: str | None = None,
        to_time: str | None = None,
    ) -> list[dict[str, Any]]:
        resolved_person = parse_person(person or identity.default_person)
        if section not in QUERY_SECTIONS:
            raise CashierError(f"unknown section: {section}")
        resolved_limit = DEFAULT_QUERY_LIMIT if limit is None else limit
        if resolved_limit > MAX_QUERY_LIMIT:
            raise CashierError(f"invalid limit: maximum is {MAX_QUERY_LIMIT}")
        start = parse_optional_rfc3339(from_time, "from")
        end = parse_optional_rfc3339(to_time, "to")
        with self._lock:
            if section in MEASUREMENT_KINDS:
                rows = self._read_file_locked(resolved_person, "measurement")
                active = [
                    row
                    for row in resolve_active(rows)
                    if row.get("kind") == section and _in_time_range(row.get("event_time"), start, end)
                ]
                latest = sorted(active, key=lambda row: (row.get("event_time") or "", row["id"]))
                latest = latest[-resolved_limit:]
                return [
                    {"event_time": row.get("event_time"), "values": row.get("values")}
                    for row in latest
                ]

            event_type = SECTION_TO_EVENT_TYPE[section]
            rows = self._read_file_locked(resolved_person, event_type)
            active = resolve_active(rows)
            if section == "medications":
                current = [
                    row
                    for row in active
                    if not row.get("stopped_at")
                    and _in_time_range(row.get("started_at"), start, end)
                ]
                current.sort(key=lambda row: (row.get("started_at") or "", row["id"]), reverse=True)
                return [
                    {
                        "id": row["id"],
                        "name": row.get("name"),
                        "dose": row.get("dose"),
                        "schedule": row.get("schedule"),
                        "started_at": row.get("started_at"),
                    }
                    for row in current[:resolved_limit]
                ]

            filtered = [row for row in active if _section_in_range(section, row, start, end)]
            filtered.sort(key=lambda row: (_section_sort_key(section, row), row["id"]), reverse=True)
            return filtered[:resolved_limit]

    def generate_chart(
        self,
        identity: Identity,
        *,
        kind: str,
        person: str | None = None,
        days: int | None = None,
        title: str | None = None,
    ) -> bytes:
        parsed_kind = parse_kind(kind)
        resolved_person = parse_person(person or identity.default_person)
        resolved_days = DEFAULT_CHART_DAYS if days is None else days
        if resolved_days > MAX_CHART_DAYS:
            raise CashierError(f"invalid days: maximum is {MAX_CHART_DAYS}")
        from datetime import timedelta

        end = now_utc()
        start = end - timedelta(days=resolved_days)
        with self._lock:
            rows = resolve_active(self._read_file_locked(resolved_person, "measurement"))
        points: list[tuple[datetime, dict[str, Any]]] = []
        for row in rows:
            if row.get("kind") != parsed_kind:
                continue
            when = parse_rfc3339(row["event_time"], "event_time")
            if when < start or when > end:
                continue
            points.append((when, row.get("values") or {}))
        points.sort(key=lambda item: item[0])
        points = points[-MAX_CHART_POINTS:]
        chart_title = title or f"{resolved_person} — {parsed_kind}"
        return render_measurement_chart(title=chart_title, kind=parsed_kind, points=points)

    def _base_event(
        self,
        identity: Identity,
        person: str | None,
        status: str | None,
        event_time: str | None,
    ) -> dict[str, Any]:
        resolved_person = parse_person(person or identity.default_person)
        resolved_status = parse_status(status) if status else DEFAULT_STATUS
        when = parse_optional_rfc3339(event_time, "event_time") or now_utc()
        return {
            "id": str(uuid4()),
            "person": resolved_person,
            "actor": identity.actor,
            "via": identity.via,
            "event_time": format_rfc3339(when),
            "created_at": format_rfc3339(now_utc()),
            "status": resolved_status,
        }

    def _append(
        self,
        file_type: str,
        event: dict[str, Any],
        event_type: str,
        *,
        dedup: bool = True,
    ) -> WriteOutcome:
        with self._lock:
            outcome = self._append_locked(file_type, event["person"], event, event_type, dedup=dedup)
            if outcome.outcome == "created":
                generate.regenerate(self.root, self._active_ledger())
        return outcome

    def _append_locked(
        self,
        file_type: str,
        person: str,
        event: dict[str, Any],
        event_type: str,
        *,
        dedup: bool = True,
    ) -> WriteOutcome:
        path = self._jsonl_path(person, file_type)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a+", encoding="utf-8") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            handle.seek(0)
            existing = _read_jsonl(handle)
            if dedup:
                duplicate = _find_duplicate(existing, event, event_type)
                if duplicate is not None:
                    return WriteOutcome("duplicate", existing_id=duplicate["id"])
            compact = {key: value for key, value in event.items() if value is not None}
            handle.write(json.dumps(compact, ensure_ascii=False, separators=(",", ":")) + "\n")
            handle.flush()
        return WriteOutcome("created", id=event["id"])

    def _jsonl_path(self, person: str, file_type: str) -> Path:
        return self.root / "data" / person / JSONL_FILES[file_type]

    def _read_file_locked(self, person: str, file_type: str) -> list[dict[str, Any]]:
        path = self._jsonl_path(person, file_type)
        if not path.is_file():
            return []
        with path.open("r", encoding="utf-8") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_SH)
            return _read_jsonl(handle)

    def _read_person_file_locked(
        self, person: str | None, file_type: str
    ) -> list[dict[str, Any]]:
        if person:
            return self._read_file_locked(person, file_type)
        rows: list[dict[str, Any]] = []
        for name in ("andrii", "valentyna"):
            rows.extend(self._read_file_locked(name, file_type))
        return rows

    def _active_ledger(self) -> dict[str, dict[str, list[dict[str, Any]]]]:
        ledger: dict[str, dict[str, list[dict[str, Any]]]] = {}
        for person in ("andrii", "valentyna"):
            by_type: dict[str, list[dict[str, Any]]] = {}
            for file_type in JSONL_FILES:
                by_type[file_type] = resolve_active(self._read_file_locked(person, file_type))
            ledger[person] = by_type
        return ledger

    def _find_by_id(self, events: list[dict[str, Any]], event_id: str) -> dict[str, Any] | None:
        for event in events:
            if event.get("id") == event_id:
                return event
        return None

    def _active_by_id(self, events: list[dict[str, Any]], event_id: str) -> dict[str, Any] | None:
        if self._find_by_id(events, event_id) is None:
            return None
        root = self._root_id(events, event_id)
        for event in resolve_active(events):
            if self._root_id(events, event["id"]) == root:
                return event
        return None

    def _root_id(self, events: list[dict[str, Any]], event_id: str) -> str:
        return _root_id(events, event_id)


def resolve_active(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id = {event["id"]: event for event in events}
    superseded = {
        event["corrects"]
        for event in events
        if event.get("corrects") in by_id
    }
    leaves = [event for event in events if event["id"] not in superseded]
    grouped: dict[str, list[dict[str, Any]]] = {}
    for event in leaves:
        grouped.setdefault(_root_id(events, event["id"]), []).append(event)
    active: list[dict[str, Any]] = []
    for group in grouped.values():
        group.sort(key=lambda event: (event.get("created_at") or "", event["id"]))
        active.append(group[-1])
    return active


def _root_id(events: list[dict[str, Any]], event_id: str) -> str:
    by_id = {event["id"]: event for event in events}
    current = event_id
    seen: set[str] = set()
    while current in by_id and by_id[current].get("corrects") and current not in seen:
        seen.add(current)
        current = by_id[current]["corrects"]
    return current


def _read_jsonl(handle: Any) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in handle:
        text = line.strip()
        if not text:
            continue
        rows.append(json.loads(text))
    return rows


def _find_duplicate(
    existing: list[dict[str, Any]], event: dict[str, Any], event_type: str
) -> dict[str, Any] | None:
    source_event_id = event.get("source_event_id")
    person = event.get("person")
    if source_event_id:
        for row in existing:
            if (
                row.get("person") == person
                and _row_event_type(row, event_type) == event_type
                and row.get("source_event_id") == source_event_id
            ):
                return row
        return None
    payload = normalized_payload(event_type, event)
    event_seconds = dedup_event_time_seconds(event_type, event)
    for row in existing:
        if row.get("person") != person:
            continue
        if _row_event_type(row, event_type) != event_type:
            continue
        if dedup_event_time_seconds(event_type, row) != event_seconds:
            continue
        if normalized_payload(event_type, row) == payload:
            return row
    return None


def _row_event_type(row: dict[str, Any], fallback: str) -> str:
    if fallback in MEASUREMENT_KINDS or row.get("kind") in MEASUREMENT_KINDS:
        return row.get("kind") or fallback
    return fallback


def _in_time_range(raw: str | None, start: datetime | None, end: datetime | None) -> bool:
    if raw is None:
        return start is None and end is None
    when = parse_rfc3339(raw, "event_time")
    if start is not None and when < start:
        return False
    if end is not None and when > end:
        return False
    return True


def _section_in_range(
    section: str, row: dict[str, Any], start: datetime | None, end: datetime | None
) -> bool:
    if section == "conditions":
        if row.get("diagnosed_at"):
            value = parse_date(row["diagnosed_at"], "diagnosed_at")
        else:
            value = utc_date(parse_rfc3339(row["created_at"], "created_at"))
        if start is not None and value < utc_date(start):
            return False
        if end is not None and value > utc_date(end):
            return False
        return True
    if section == "allergies":
        return _in_time_range(row.get("created_at"), start, end)
    if section == "labs":
        value = parse_date(row["test_date"], "test_date")
        if start is not None and value < utc_date(start):
            return False
        if end is not None and value > utc_date(end):
            return False
        return True
    if section == "sleep":
        return _in_time_range(row.get("start_time") or row.get("event_time"), start, end)
    return _in_time_range(row.get("event_time"), start, end)


def _section_sort_key(section: str, row: dict[str, Any]) -> str:
    if section == "conditions":
        return row.get("diagnosed_at") or row.get("created_at") or ""
    if section == "allergies":
        return row.get("created_at") or ""
    if section == "labs":
        return row.get("test_date") or ""
    if section == "sleep":
        return row.get("start_time") or row.get("event_time") or ""
    return row.get("event_time") or row.get("created_at") or ""
