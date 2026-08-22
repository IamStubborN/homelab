from __future__ import annotations

import json
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

from health_mcp.auth import Identity
from health_mcp.ingest.docs import DocsParse, parse_docs, read_doc, write_people_pages
from health_mcp.ingest.ramus import LabParse, parse_ramus_pdfs
from health_mcp.ingest.rawcopy import ANDRII_PDFS, VALENTYNA_PDFS, copy_raw
from health_mcp.ingest.xlsx import Skip, XlsxParse, parse_workbook
from health_mcp.store import WikiStore

EXPECTED = {
    "andrii_bp_xlsx": 51,
    "andrii_bp_docs": 5,
    "valentyna_bp": 10,
    "andrii_sleep": 6,
    "andrii_weight_xlsx": 22,
    "andrii_weight_docs": 1,
    "valentyna_weight": 3,
    "andrii_meds": 6,
    "valentyna_meds": 8,
    "andrii_labs": 62,
    "valentyna_labs": 52,
    "andrii_conditions": 6,
    "valentyna_conditions": 5,  # map §6.5 list; §4.1 said 6
    "allergies": 1,
    "meals": 2,
    "andrii_symptoms": 2,
    "valentyna_symptoms": 5,  # map §6.9; §4.1 total 8 vs listed 7
}


@dataclass
class IngestStats:
    created: Counter[str] = field(default_factory=Counter)
    duplicate: Counter[str] = field(default_factory=Counter)
    skips: list[Skip] = field(default_factory=list)
    copied: list[str] = field(default_factory=list)
    mismatches: list[str] = field(default_factory=list)


def identity_for(person: str) -> Identity:
    return Identity(actor=person, via="system", default_person=person)


def run_ingest(
    *,
    health_root: Path,
    export_dir: Path,
    xlsx_path: Path,
    raw_src: Path,
    force: bool = False,
) -> IngestStats:
    health_root = health_root.resolve()
    store = WikiStore(health_root)
    _refuse_if_already_ingested(health_root, force=force)
    stats = IngestStats()
    stats.copied = copy_raw(
        health_root=health_root,
        raw_src=raw_src,
        export_dir=export_dir,
        xlsx_path=xlsx_path,
    )
    xlsx = parse_workbook(xlsx_path)
    docs = parse_docs(read_doc(export_dir / "Andrii.txt"), read_doc(export_dir / "Valentyna.txt"))
    labs_andrii = parse_ramus_pdfs(
        person="andrii",
        en_pdf=raw_src / ANDRII_PDFS[0],
        bg_pdf=raw_src / ANDRII_PDFS[1],
        source_document=f"raw/andrii/{ANDRII_PDFS[0]}",
        female=False,
    )
    labs_val = parse_ramus_pdfs(
        person="valentyna",
        en_pdf=raw_src / VALENTYNA_PDFS[0],
        bg_pdf=raw_src / VALENTYNA_PDFS[1],
        source_document=f"raw/valentyna/{VALENTYNA_PDFS[0]}",
        female=True,
    )
    _write_xlsx(store, xlsx, stats)
    _write_docs(store, docs, stats)
    _write_labs(store, labs_andrii, stats)
    _write_labs(store, labs_val, stats)
    stats.skips.extend(xlsx.skips)
    stats.skips.extend(docs.skips)
    stats.skips.extend(labs_andrii.skips)
    stats.skips.extend(labs_val.skips)
    write_people_pages(health_root, docs.people)
    stats.mismatches = _count_mismatches(xlsx, docs, labs_andrii, labs_val, stats)
    _append_health_log(health_root, stats)
    return stats


def public_report(stats: IngestStats) -> str:
    lines = [
        "# T8 ingest report (counts only)",
        "",
        "One-shot Здоровье ingest via `health_mcp.store.WikiStore`.",
        "No medical payloads. Google Docs/Sheet archive was not modified.",
        "",
        "## Created",
    ]
    for key, count in sorted(stats.created.items()):
        lines.append(f"- {key}: {count}")
    dupes = {key: count for key, count in stats.duplicate.items() if count}
    if dupes:
        lines.extend(["", "## Duplicates (re-run)"])
        for key, count in sorted(dupes.items()):
            lines.append(f"- {key}: {count}")
    lines.extend(["", "## Expected vs parsed"])
    lines.extend(f"- {item}" for item in stats.mismatches or ["parsed buckets matched map §6 / §4 sheet counts"])
    lines.extend(
        [
            "",
            "## Map count notes",
            "- Valentyna conditions: ingest §6.5 (5). Map §4.1 said 6; joints row is a skip.",
            "- Symptoms: ingest §6.4 (2) + §6.9 (5) = 7. Map §4.1 said 8.",
        ]
    )
    lines.extend(["", "## Skips (identifiers only)"])
    for skip in stats.skips:
        lines.append(f"- `{skip.ident}`: {skip.reason}")
    lines.extend(["", "## Raw copies", f"- {len(stats.copied)} files copied into vault `raw/`"])
    lines.extend(
        [
            "",
            "## Re-run against $WIKI_ROOT (after G3)",
            "",
            "Do not run this against `/mnt/internal/wiki` until G3. After G3:",
            "",
            "```bash",
            "wiki/bootstrap-vault.sh \"$WIKI_ROOT\"",
            "cd health/mcp",
            "python3 -m health_mcp.ingest \\",
            "  --wiki-root \"$WIKI_ROOT/shared/health\" \\",
            "  --export-dir /tmp/zdorovie-export \\",
            "  --xlsx \"/tmp/zdorovie-xlsx/Дневник показателей здоровья.xlsx\" \\",
            "  --raw-src /tmp/t8-zdorovie-raw",
            "```",
            "",
            "Meds/conditions/allergies have no `source_event_id`; do not re-run without `--force` on an empty tree.",
            "G4 still applies: do not delete Google Docs/Sheet.",
            "",
        ]
    )
    return "\n".join(lines)


def private_report(stats: IngestStats, health_root: Path) -> str:
    lines = [
        "# T8 ingest report (private)",
        "",
        "Contains skip quotes and generated-page checks. Do not commit.",
        "",
        public_report(stats),
        "",
        "## Skip quotes",
    ]
    for skip in stats.skips:
        if skip.quote:
            lines.append(f"- `{skip.ident}`: {skip.reason}")
            lines.append(f"  > {skip.quote}")
    lines.extend(["", "## Generated profile checks"])
    for name in (
        "ANDRII_CURRENT_MEDICATIONS.md",
        "VALENTYNA_CURRENT_MEDICATIONS.md",
        "VALENTYNA_ALLERGIES.md",
        "ANDRII_CURRENT_PROFILE.md",
        "VALENTYNA_CURRENT_PROFILE.md",
        "ANDRII_RECENT_LABS.md",
        "VALENTYNA_RECENT_LABS.md",
    ):
        path = health_root / "generated" / name
        lines.append(f"### {name} exists={path.is_file()}")
        if path.is_file():
            lines.append("```")
            lines.append(path.read_text(encoding="utf-8")[:4000])
            lines.append("```")
    lines.append("")
    return "\n".join(lines)


def _refuse_if_already_ingested(health_root: Path, *, force: bool) -> None:
    meds = health_root / "data" / "andrii" / "medications.jsonl"
    if force or not meds.is_file():
        return
    if meds.stat().st_size == 0:
        return
    raise SystemExit(f"refusing to ingest into nonempty {meds}; pass --force to override")


def _write_xlsx(store: WikiStore, parsed: XlsxParse, stats: IngestStats) -> None:
    for row in parsed.measurements:
        outcome = store.add_measurement(
            identity_for(row.person),
            kind=row.kind,
            values=row.values,
            person=row.person,
            source=row.source,
            status=row.status,
            event_time=row.event_time,
            source_event_id=row.source_event_id,
        )
        stats.created[f"measurement:{row.person}:{row.kind}"] += int(outcome.outcome == "created")
        stats.duplicate[f"measurement:{row.person}:{row.kind}"] += int(outcome.outcome == "duplicate")
    for row in parsed.sleep:
        outcome = store.add_sleep_record(
            identity_for(row.person),
            start_time=row.start_time,
            end_time=row.end_time,
            person=row.person,
            notes=row.notes,
            status=row.status,
            source_event_id=row.source_event_id,
        )
        stats.created["sleep:andrii"] += int(outcome.outcome == "created")
        stats.duplicate["sleep:andrii"] += int(outcome.outcome == "duplicate")
    for row in parsed.medications:
        outcome = store.add_medication(
            identity_for(row.person),
            name=row.name,
            person=row.person,
            dose=row.dose,
            schedule=row.schedule,
            started_at=row.started_at,
            status=row.status,
            confirmed=True,
        )
        stats.created[f"medication:{row.person}"] += int(outcome.outcome == "created")


def _write_docs(store: WikiStore, parsed: DocsParse, stats: IngestStats) -> None:
    for row in parsed.measurements:
        outcome = store.add_measurement(
            identity_for(row.person),
            kind=row.kind,
            values=row.values,
            person=row.person,
            source=row.source,
            status=row.status,
            event_time=row.event_time,
            source_event_id=row.source_event_id,
        )
        stats.created[f"measurement:{row.person}:{row.kind}"] += int(outcome.outcome == "created")
        stats.duplicate[f"measurement:{row.person}:{row.kind}"] += int(outcome.outcome == "duplicate")
    for row in parsed.medications:
        store.add_medication(
            identity_for(row.person),
            name=row.name,
            person=row.person,
            dose=row.dose,
            schedule=row.schedule,
            started_at=row.started_at,
            status=row.status,
            confirmed=True,
        )
        stats.created[f"medication:{row.person}"] += 1
    for row in parsed.conditions:
        store.add_condition(
            identity_for(row.person),
            name=row.name,
            person=row.person,
            notes=row.notes,
            status=row.status,
            confirmed=True,
        )
        stats.created[f"condition:{row.person}"] += 1
    for row in parsed.allergies:
        store.add_allergy(
            identity_for(row.person),
            allergen=row.allergen,
            person=row.person,
            reaction=row.reaction,
            severity=row.severity,
            status=row.status,
        )
        stats.created[f"allergy:{row.person}"] += 1
    for row in parsed.meals:
        store.add_meal(
            identity_for(row.person),
            description=row.description,
            person=row.person,
            status=row.status,
            event_time=row.event_time,
            source_event_id=row.source_event_id,
        )
        stats.created[f"meal:{row.person}"] += 1
    for row in parsed.symptoms:
        store.add_symptom(
            identity_for(row.person),
            description=row.description,
            person=row.person,
            status=row.status,
            event_time=row.event_time,
            source_event_id=row.source_event_id,
        )
        stats.created[f"symptom:{row.person}"] += 1


def _write_labs(store: WikiStore, parsed: LabParse, stats: IngestStats) -> None:
    for row in parsed.labs:
        outcome = store.add_lab_result(
            identity_for(row.person),
            test_date=row.test_date,
            test_name=row.test_name,
            value=row.value,
            person=row.person,
            unit=row.unit,
            reference_min=row.reference_min,
            reference_max=row.reference_max,
            flag=row.flag,
            laboratory=row.laboratory,
            source_document=row.source_document,
            status=row.status,
        )
        key = f"lab:{row.person}"
        stats.created[key] += int(outcome.outcome == "created")
        stats.duplicate[key] += int(outcome.outcome == "duplicate")


def _count_mismatches(
    xlsx: XlsxParse,
    docs: DocsParse,
    labs_andrii: LabParse,
    labs_val: LabParse,
    stats: IngestStats,
) -> list[str]:
    def count(kind: str, person: str) -> int:
        return sum(1 for row in xlsx.measurements if row.kind == kind and row.person == person)

    parsed = {
        "andrii_bp_xlsx": count("blood_pressure", "andrii"),
        "andrii_bp_docs": sum(1 for row in docs.measurements if row.kind == "blood_pressure"),
        "valentyna_bp": count("blood_pressure", "valentyna"),
        "andrii_sleep": len(xlsx.sleep),
        "andrii_weight_xlsx": count("weight", "andrii"),
        "andrii_weight_docs": sum(1 for row in docs.measurements if row.kind == "weight"),
        "valentyna_weight": count("weight", "valentyna"),
        "andrii_meds": sum(1 for row in xlsx.medications if row.person == "andrii"),
        "valentyna_meds": len(docs.medications),
        "andrii_labs": len(labs_andrii.labs),
        "valentyna_labs": len(labs_val.labs),
        "andrii_conditions": sum(1 for row in docs.conditions if row.person == "andrii"),
        "valentyna_conditions": sum(1 for row in docs.conditions if row.person == "valentyna"),
        "allergies": len(docs.allergies),
        "meals": len(docs.meals),
        "andrii_symptoms": sum(1 for row in docs.symptoms if row.person == "andrii"),
        "valentyna_symptoms": sum(1 for row in docs.symptoms if row.person == "valentyna"),
    }
    mismatches: list[str] = []
    for key, expected in EXPECTED.items():
        got = parsed[key]
        if got != expected:
            mismatches.append(f"{key}: parsed {got}, map expected {expected}")
    _ = stats
    return mismatches


def _append_health_log(health_root: Path, stats: IngestStats) -> None:
    log = health_root / "log.md"
    created = dict(stats.created)
    line = (
        f"- T8 ingest: WikiStore via=system; created {json.dumps(created, sort_keys=True)}; "
        f"raw files {len(stats.copied)}.\n"
    )
    if log.is_file():
        log.write_text(log.read_text(encoding="utf-8") + line, encoding="utf-8")
    else:
        log.write_text("# Log\n\n" + line, encoding="utf-8")
