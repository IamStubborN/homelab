from __future__ import annotations

import re
import zipfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from health_mcp.ingest.timeutil import as_float, as_int, combine_sofia, parse_sheet_date, parse_sheet_time, sofia_midnight

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
CELL_REF = re.compile(r"([A-Z]+)(\d+)")

SHEET_ANDRII = "Andrii"
SHEET_VALENTYNA = "Valentyna"
SHEET_SLEEP = "Сон Andrii"
SHEET_WEIGHT = "Вес"
SHEET_MEDS = "Приём препаратов Andrii"

BP_KIND = "Артериальное давление"
STATUS_TAKING = "Принимается"
STATUS_NOT_STARTED = "Не начат"
DOCTOR_MEDS = frozenset({"Липантил 200М", "Vigantol", "Ademta"})


@dataclass
class Skip:
    ident: str
    reason: str
    quote: str | None = None


@dataclass
class MeasurementRow:
    person: str
    kind: str
    values: dict[str, Any]
    event_time: str
    source: str | None
    status: str
    source_event_id: str
    ident: str


@dataclass
class SleepRow:
    person: str
    start_time: str
    end_time: str
    notes: str | None
    status: str
    source_event_id: str
    ident: str


@dataclass
class MedicationRow:
    person: str
    name: str
    dose: str | None
    schedule: str | None
    started_at: str
    status: str
    ident: str


@dataclass
class XlsxParse:
    measurements: list[MeasurementRow] = field(default_factory=list)
    sleep: list[SleepRow] = field(default_factory=list)
    medications: list[MedicationRow] = field(default_factory=list)
    skips: list[Skip] = field(default_factory=list)


def parse_workbook(path: Path) -> XlsxParse:
    book = _load_workbook(path)
    result = XlsxParse()
    result.measurements.extend(_parse_bp(book[SHEET_ANDRII], "andrii", "xlsx:andrii"))
    result.skips.extend(_bp_skips(book[SHEET_ANDRII], "andrii", "xlsx:andrii"))
    result.measurements.extend(_parse_bp(book[SHEET_VALENTYNA], "valentyna", "xlsx:valentyna"))
    result.skips.extend(_bp_skips(book[SHEET_VALENTYNA], "valentyna", "xlsx:valentyna"))
    sleep_rows, sleep_skips = _parse_sleep(book[SHEET_SLEEP])
    result.sleep.extend(sleep_rows)
    result.skips.extend(sleep_skips)
    weights, weight_skips = _parse_weight(book[SHEET_WEIGHT])
    result.measurements.extend(weights)
    result.skips.extend(weight_skips)
    meds, med_skips = _parse_meds(book[SHEET_MEDS])
    result.medications.extend(meds)
    result.skips.extend(med_skips)
    return result


def measurement_status(source: str | None) -> str:
    text = source or ""
    if "Фото" in text:
        return "confirmed_by_document"
    if "Со слов" in text:
        return "user_reported"
    return "user_reported"


def compose_source(source: str | None, comment: str | None) -> str | None:
    base = (source or "").strip()
    extra = (comment or "").strip()
    if base and extra:
        return f"{base} | {extra}"
    return base or extra or None


def _parse_bp(rows: dict[int, dict[str, object]], person: str, id_prefix: str) -> list[MeasurementRow]:
    accepted: list[MeasurementRow] = []
    for row_n, cells in _data_rows(rows):
        if _row_empty(cells, "ABCDEFGHIJK"):
            continue
        ident = f"{id_prefix}:r{row_n}"
        kind = _cell_str(cells, "H")
        if kind and kind != BP_KIND:
            continue
        day = parse_sheet_date(cells.get("A"))
        clock = parse_sheet_time(cells.get("B"))
        systolic = as_int(cells.get("C"))
        diastolic = as_int(cells.get("D"))
        pulse = as_int(cells.get("E"))
        if day is None or clock is None or systolic is None or diastolic is None or pulse is None:
            continue
        source = compose_source(_cell_str(cells, "I"), _cell_str(cells, "J"))
        accepted.append(
            MeasurementRow(
                person=person,
                kind="blood_pressure",
                values={"systolic": systolic, "diastolic": diastolic, "pulse": pulse},
                event_time=combine_sofia(day, clock),
                source=source,
                status=measurement_status(source),
                source_event_id=ident,
                ident=ident,
            )
        )
    return accepted


def _bp_skips(rows: dict[int, dict[str, object]], person: str, id_prefix: str) -> list[Skip]:
    skips: list[Skip] = []
    for row_n, cells in _data_rows(rows):
        ident = f"xlsx {person}!r{row_n}"
        if _row_empty(cells, "ABCDEFGHIJK"):
            skips.append(Skip(ident, "empty spacer"))
            continue
        kind = _cell_str(cells, "H")
        if kind and kind != BP_KIND:
            skips.append(Skip(ident, f"measurement type is not {BP_KIND}"))
            continue
        if parse_sheet_date(cells.get("A")) is None:
            skips.append(Skip(ident, "missing date"))
            continue
        if parse_sheet_time(cells.get("B")) is None:
            skips.append(Skip(ident, "missing time", quote=_row_quote(cells, "ABCDEFGHIJK")))
            continue
        if as_int(cells.get("C")) is None or as_int(cells.get("D")) is None or as_int(cells.get("E")) is None:
            skips.append(Skip(ident, "missing systolic/diastolic/pulse"))
    return skips


def _parse_sleep(rows: dict[int, dict[str, object]]) -> tuple[list[SleepRow], list[Skip]]:
    accepted: list[SleepRow] = []
    skips: list[Skip] = []
    for row_n, cells in _data_rows(rows):
        ident = f"xlsx:andrii-sleep:r{row_n}"
        if _row_empty(cells, "ABCDEFGH"):
            skips.append(Skip(f"xlsx andrii-sleep!r{row_n}", "empty spacer"))
            continue
        day = parse_sheet_date(cells.get("A"))
        start = parse_sheet_time(cells.get("B"))
        end = parse_sheet_time(cells.get("C"))
        if day is None or start is None or end is None:
            skips.append(Skip(f"xlsx andrii-sleep!r{row_n}", "missing date or time"))
            continue
        source = _cell_str(cells, "G")
        accepted.append(
            SleepRow(
                person="andrii",
                start_time=combine_sofia(day, start),
                end_time=combine_sofia(day, end),
                notes=_cell_str(cells, "F") or None,
                status=measurement_status(source) if source else "user_reported",
                source_event_id=ident,
                ident=ident,
            )
        )
    return accepted, skips


def _parse_weight(rows: dict[int, dict[str, object]]) -> tuple[list[MeasurementRow], list[Skip]]:
    accepted: list[MeasurementRow] = []
    skips: list[Skip] = []
    for row_n, cells in _data_rows(rows):
        if _row_empty(cells, "ABCDEFGH"):
            skips.append(Skip(f"xlsx weight!r{row_n}", "empty spacer"))
            continue
        day = parse_sheet_date(cells.get("A"))
        clock = parse_sheet_time(cells.get("B"))
        source = compose_source(_cell_str(cells, "G"), None)
        status = measurement_status(source)
        valentyna_kg = as_float(cells.get("C"))
        andrii_kg = as_float(cells.get("D"))
        if day is None:
            skips.append(Skip(f"xlsx weight!r{row_n}", "missing date"))
            continue
        if clock is None:
            if andrii_kg is not None:
                skips.append(
                    Skip(
                        "xlsx weight!r{n}:andrii".format(n=row_n),
                        "missing time",
                        quote=_row_quote(cells, "ABCDEFGH"),
                    )
                )
            if valentyna_kg is not None:
                skips.append(Skip(f"xlsx weight!r{row_n}:valentyna", "missing time"))
            if andrii_kg is None and valentyna_kg is None:
                skips.append(Skip(f"xlsx weight!r{row_n}", "missing time and no C/D kg"))
            continue
        event_time = combine_sofia(day, clock)
        if valentyna_kg is not None:
            ident = f"xlsx:weight:r{row_n}:valentyna"
            accepted.append(
                MeasurementRow(
                    person="valentyna",
                    kind="weight",
                    values={"value": valentyna_kg, "unit": "kg"},
                    event_time=event_time,
                    source=source,
                    status=status,
                    source_event_id=ident,
                    ident=ident,
                )
            )
        if andrii_kg is not None:
            ident = f"xlsx:weight:r{row_n}:andrii"
            accepted.append(
                MeasurementRow(
                    person="andrii",
                    kind="weight",
                    values={"value": andrii_kg, "unit": "kg"},
                    event_time=event_time,
                    source=source,
                    status=status,
                    source_event_id=ident,
                    ident=ident,
                )
            )
        if valentyna_kg is None and andrii_kg is None:
            skips.append(Skip(f"xlsx weight!r{row_n}", "no numeric C/D; E/F deltas never ingested"))
    return accepted, skips


def _parse_meds(rows: dict[int, dict[str, object]]) -> tuple[list[MedicationRow], list[Skip]]:
    accepted: list[MedicationRow] = []
    skips: list[Skip] = []
    for row_n, cells in _data_rows(rows):
        ident = f"xlsx andrii-meds!r{row_n}"
        name = _cell_str(cells, "A")
        status_cell = _cell_str(cells, "B")
        if not name:
            skips.append(Skip(ident, "empty spacer"))
            continue
        if status_cell != STATUS_TAKING:
            skips.append(
                Skip(
                    ident,
                    f"status {status_cell or 'empty'} (not {STATUS_TAKING})",
                    quote=_row_quote(cells, "ABCDEFGHIJ"),
                )
            )
            continue
        day = parse_sheet_date(cells.get("C"))
        if day is None:
            skips.append(Skip(ident, "missing start date"))
            continue
        schedule = _compose_schedule(cells)
        writer_status = "confirmed_by_doctor" if name in DOCTOR_MEDS else "user_reported"
        accepted.append(
            MedicationRow(
                person="andrii",
                name=name,
                dose=_cell_str(cells, "D") or None,
                schedule=schedule,
                started_at=sofia_midnight(day),
                status=writer_status,
                ident=ident,
            )
        )
    return accepted, skips


def _compose_schedule(cells: dict[str, object]) -> str | None:
    parts = [
        _cell_str(cells, "E"),
        _cell_str(cells, "F"),
        _cell_str(cells, "G"),
    ]
    course = _cell_str(cells, "H")
    note = _cell_str(cells, "J")
    chunks = [part for part in parts if part]
    if course:
        chunks.append(f"course: {course}")
    if note:
        chunks.append(note)
    return "; ".join(chunks) if chunks else None


def _load_workbook(path: Path) -> dict[str, dict[int, dict[str, object]]]:
    with zipfile.ZipFile(path) as archive:
        sst = _shared_strings(archive)
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        rid_to_target = {rel.attrib["Id"]: rel.attrib["Target"] for rel in rels}
        sheets: dict[str, dict[int, dict[str, object]]] = {}
        for sheet in workbook.findall("m:sheets/m:sheet", NS):
            name = sheet.attrib["name"]
            target = rid_to_target[sheet.attrib[REL]].lstrip("/")
            if not target.startswith("xl/"):
                target = "xl/" + target
            sheets[name] = _load_sheet(archive, target, sst)
        return sheets


def _shared_strings(archive: zipfile.ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in archive.namelist():
        return []
    root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
    values: list[str] = []
    for si in root.findall("m:si", NS):
        texts = [
            node.text or ""
            for node in si.iter("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t")
        ]
        values.append("".join(texts))
    return values


def _load_sheet(archive: zipfile.ZipFile, target: str, sst: list[str]) -> dict[int, dict[str, object]]:
    root = ET.fromstring(archive.read(target))
    rows: dict[int, dict[str, object]] = {}
    for cell in root.findall(".//m:c", NS):
        ref = cell.attrib.get("r")
        if not ref:
            continue
        match = CELL_REF.fullmatch(ref)
        if not match:
            continue
        col, row_n = match.group(1), int(match.group(2))
        rows.setdefault(row_n, {})[col] = _cell_value(cell, sst)
    return rows


def _cell_value(cell: ET.Element, sst: list[str]) -> object | None:
    cell_type = cell.attrib.get("t")
    raw = cell.find("m:v", NS)
    inline = cell.find("m:is", NS)
    if cell_type == "s" and raw is not None and raw.text is not None:
        return sst[int(raw.text)]
    if cell_type == "inlineStr" and inline is not None:
        return "".join(
            node.text or ""
            for node in inline.iter("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t")
        )
    if raw is None or raw.text is None:
        return None
    text = raw.text
    if cell_type == "b":
        return text == "1"
    if cell_type in {None, "n"}:
        if "." in text or "e" in text.lower():
            return float(text)
        try:
            return int(text)
        except ValueError:
            return float(text)
    return text


def _data_rows(rows: dict[int, dict[str, object]]) -> list[tuple[int, dict[str, object]]]:
    nonempty = [
        n for n, cells in rows.items() if n >= 5 and not _row_empty(cells, "ABCDEFGHIJK")
    ]
    if not nonempty:
        return []
    last = max(nonempty)
    return [(n, rows.get(n, {})) for n in range(5, last + 1)]


def _row_empty(cells: dict[str, object], columns: str) -> bool:
    return all(cells.get(col) in (None, "") for col in columns)


def _cell_str(cells: dict[str, object], col: str) -> str | None:
    value = cells.get(col)
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _row_quote(cells: dict[str, object], columns: str) -> str:
    parts = []
    for col in columns:
        value = cells.get(col)
        if value in (None, ""):
            parts.append(f"{col}=(empty)")
        else:
            parts.append(f"{col}={value}")
    return " | ".join(parts)
