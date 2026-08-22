from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from health_mcp.ingest.timeutil import sofia_midnight
from health_mcp.ingest.xlsx import MedicationRow, MeasurementRow, Skip

SECTION_RE = re.compile(r"^(\d+(?:\.\d+)*)\.\s+\S")
BP_LINE_RE = re.compile(
    r"(?P<day>\d{2}\.\d{2}\.\d{4})\s+(?P<clock>\d{2}:\d{2}:\d{2})\s+[—–-]\s+"
    r".{0,80}?(?P<sys>\d+)\s*/\s*(?P<dia>\d+).{0,80}?пульс\s+(?P<pulse>\d+)",
    re.I,
)
WEIGHT_LINE_RE = re.compile(
    r"(?P<day>\d{2}\.\d{2}\.\d{4})(?:\s+(?P<clock>\d{2}:\d{2}:\d{2}))?[:.]?\s+"
    r"(?:рост[^\n]{0,40})?масса\s+(?P<approx>около\s+)?(?P<kg>\d+(?:[.,]\d+)?)\s*кг",
    re.I,
)
ANDRII_BP_EXTRAS = {
    "2026-07-26T22:22:27": "docs:andrii:bp:2026-07-26T22:22:27",
    "2026-07-28T22:47:57": "docs:andrii:bp:2026-07-28T22:47:57",
    "2026-07-30T23:32:00": "docs:andrii:bp:2026-07-30T23:32:00",
    "2026-08-01T10:31:22": "docs:andrii:bp:2026-08-01T10:31:22",
    "2026-08-04T09:39:00": "docs:andrii:bp:2026-08-04T09:39:00",
}
ANDRII_WEIGHT_EXTRAS = {
    "2026-07-30T23:32:00": "docs:andrii:weight:2026-07-30T23:32:00",
}

ANDRII_SKIP_SECTIONS = frozenset({"8", "9"})
VAL_SKIP_SECTIONS = frozenset({"9", "11"})


@dataclass
class ConditionRow:
    person: str
    name: str
    notes: str | None
    status: str
    ident: str


@dataclass
class AllergyRow:
    person: str
    allergen: str
    reaction: str | None
    severity: str | None
    status: str
    ident: str


@dataclass
class MealRow:
    person: str
    description: str
    event_time: str
    status: str
    source_event_id: str
    ident: str


@dataclass
class SymptomRow:
    person: str
    description: str
    event_time: str | None
    status: str
    source_event_id: str
    ident: str


@dataclass
class PeopleFacts:
    name: str | None = None
    dob: str | None = None
    height_cm: str | None = None
    extras: list[str] = field(default_factory=list)


@dataclass
class DocsParse:
    measurements: list[MeasurementRow] = field(default_factory=list)
    medications: list[MedicationRow] = field(default_factory=list)
    conditions: list[ConditionRow] = field(default_factory=list)
    allergies: list[AllergyRow] = field(default_factory=list)
    meals: list[MealRow] = field(default_factory=list)
    symptoms: list[SymptomRow] = field(default_factory=list)
    skips: list[Skip] = field(default_factory=list)
    people: dict[str, PeopleFacts] = field(default_factory=dict)


def read_doc(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")


def parse_docs(andrii_text: str, valentyna_text: str) -> DocsParse:
    result = DocsParse()
    andrii_clean = _clean_profile(andrii_text, ANDRII_SKIP_SECTIONS)
    val_clean = _clean_profile(valentyna_text, VAL_SKIP_SECTIONS)
    result.people["andrii"] = _andrii_people(andrii_clean)
    result.people["valentyna"] = _valentyna_people(val_clean)
    result.measurements.extend(_andrii_bp_extras(andrii_clean))
    result.skips.extend(_andrii_weight_skips(andrii_clean))
    extra_weight = _andrii_weight_extras(andrii_clean)
    result.measurements.extend(extra_weight)
    result.conditions.extend(_andrii_conditions(andrii_clean))
    result.symptoms.extend(_andrii_symptoms(andrii_clean))
    result.conditions.extend(_valentyna_conditions(val_clean))
    result.allergies.extend(_valentyna_allergies(val_clean))
    result.skips.extend(_valentyna_allergy_skips(val_clean))
    meds, med_skips = _valentyna_meds(val_clean)
    result.medications.extend(meds)
    result.skips.extend(med_skips)
    result.meals.extend(_valentyna_meals(val_clean, valentyna_text))
    result.symptoms.extend(_valentyna_symptoms(val_clean))
    result.skips.extend(_journal_skips(andrii_text, valentyna_text))
    return result


def _clean_profile(text: str, skip_roots: frozenset[str]) -> str:
    kept: list[str] = []
    current_root = ""
    for line in text.splitlines():
        match = SECTION_RE.match(line.strip())
        if match:
            current_root = match.group(1).split(".", 1)[0]
        if current_root in skip_roots:
            continue
        if re.search(r"рабоч(ий|ая)\s+(вывод|интерпретация)", line, re.I):
            continue
        kept.append(line)
    return "\n".join(kept)


def _andrii_bp_extras(text: str) -> list[MeasurementRow]:
    section = _section_body(text, "2.")
    rows: list[MeasurementRow] = []
    found: set[str] = set()
    for match in BP_LINE_RE.finditer(section):
        local = _local_iso(match.group("day"), match.group("clock"))
        source_id = ANDRII_BP_EXTRAS.get(local)
        if not source_id:
            continue
        found.add(local)
        rows.append(
            MeasurementRow(
                person="andrii",
                kind="blood_pressure",
                values={
                    "systolic": int(match.group("sys")),
                    "diastolic": int(match.group("dia")),
                    "pulse": int(match.group("pulse")),
                },
                event_time=f"{local}+03:00",
                source="Docs profile §2",
                status="user_reported",
                source_event_id=source_id,
                ident=source_id,
            )
        )
    return rows


def _andrii_weight_extras(text: str) -> list[MeasurementRow]:
    section = _section_body(text, "1.")
    rows: list[MeasurementRow] = []
    for match in WEIGHT_LINE_RE.finditer(section):
        if match.group("approx"):
            continue
        if not match.group("clock"):
            continue
        local = _local_iso(match.group("day"), match.group("clock"))
        source_id = ANDRII_WEIGHT_EXTRAS.get(local)
        if not source_id:
            continue
        kg = float(match.group("kg").replace(",", "."))
        rows.append(
            MeasurementRow(
                person="andrii",
                kind="weight",
                values={"value": kg, "unit": "kg"},
                event_time=f"{local}+03:00",
                source="Docs profile §1",
                status="user_reported",
                source_event_id=source_id,
                ident=source_id,
            )
        )
    return rows


def _andrii_weight_skips(text: str) -> list[Skip]:
    section = _section_body(text, "1.")
    skips: list[Skip] = []
    for match in WEIGHT_LINE_RE.finditer(section):
        day = match.group("day")
        clock = match.group("clock")
        approx = match.group("approx")
        if day == "12.07.2026" and approx:
            skips.append(Skip("docs andrii §1 12.07.2026", "approximate weight and no time", quote=match.group(0)[:120]))
        elif day == "23.07.2026" and not clock:
            skips.append(Skip("docs andrii §1 23.07.2026", "weight with no time", quote=match.group(0)[:120]))
    return skips


def _andrii_conditions(text: str) -> list[ConditionRow]:
    rows: list[ConditionRow] = []
    if "обструктивное апноэ сна" in text.lower():
        rows.append(
            ConditionRow(
                "andrii",
                "Obstructive sleep apnea",
                "Confirmed by a doctor several years ago; date/severity/study not in project; CPAP recommended, device not obtained; not used now",
                "confirmed_by_doctor",
                "docs:andrii:condition:osa",
            )
        )
    if "артериальная гипертензия" in text.lower() or "артериального давления" in text.lower():
        rows.append(
            ConditionRow(
                "andrii",
                "Arterial hypertension",
                "Formal diagnosis/stage not recorded; repeating home BP",
                "suspected",
                "docs:andrii:condition:htn",
            )
        )
    if "предиабет" in text.lower():
        rows.append(
            ConditionRow(
                "andrii",
                "Prediabetes",
                "HbA1c in the prediabetes range on Ramus; diagnosis not confirmed by a doctor in these sources",
                "suspected",
                "docs:andrii:condition:prediabetes",
            )
        )
    if "инсулинорезистентн" in text.lower():
        rows.append(
            ConditionRow(
                "andrii",
                "Insulin resistance",
                "HOMA-IR elevated on Ramus 23.07.2026; not a standalone confirmed diagnosis",
                "suspected",
                "docs:andrii:condition:ir",
            )
        )
    if "жировая болезнь печени" in text.lower():
        rows.append(
            ConditionRow(
                "andrii",
                "Metabolic dysfunction-associated steatotic liver disease",
                "Docs label this a working hypothesis, not a confirmed diagnosis",
                "suspected",
                "docs:andrii:condition:masld",
            )
        )
    if "метаболический синдром" in text.lower():
        rows.append(
            ConditionRow(
                "andrii",
                "Metabolic syndrome",
                "Docs: formal diagnosis not confirmed by a doctor",
                "suspected",
                "docs:andrii:condition:metsynd",
            )
        )
    return rows


def _andrii_symptoms(text: str) -> list[SymptomRow]:
    when = sofia_midnight(date(2026, 7, 24))
    rows: list[SymptomRow] = []
    if "громко храп" in text.lower() or "неспокойный" in text.lower():
        rows.append(
            SymptomRow(
                "andrii",
                "Restless, very light sleep; very loud snoring",
                when,
                "user_reported",
                "docs:andrii:symptom:snoring-2026-07-24",
                "docs:andrii:symptom:snoring-2026-07-24",
            )
        )
    if "хаотичн" in text.lower() and "сон" in text.lower():
        rows.append(
            SymptomRow(
                "andrii",
                "Chaotic sleep schedule; sometimes 2–3 h / 24 h, sometimes almost all day; night work often while lying in bed",
                when,
                "user_reported",
                "docs:andrii:symptom:sleep-schedule-2026-07-24",
                "docs:andrii:symptom:sleep-schedule-2026-07-24",
            )
        )
    return rows


def _valentyna_conditions(text: str) -> list[ConditionRow]:
    rows: list[ConditionRow] = []
    checks = [
        (
            "хронический гастрит",
            "Chronic gastritis",
            "Long remission; active in childhood and university >10 years ago; rare pain now",
            "user_reported",
            "docs:valentyna:condition:gastritis",
        ),
        (
            "гепатит b",
            "Hepatitis B (history)",
            "в настоящее время снята с учета",
            "resolved",
            "docs:valentyna:condition:hbv",
        ),
        (
            "дискинезия",
            "Dyskinesia",
            "Type and location not specified",
            "historical_uncertain",
            "docs:valentyna:condition:dyskinesia",
        ),
        (
            "межпозвоночн",
            "Two intervertebral hernias of the lower spine",
            None,
            "user_reported",
            "docs:valentyna:condition:hernias",
        ),
        (
            "поликистозн",
            "Polycystic ovary syndrome",
            None,
            "user_reported",
            "docs:valentyna:condition:pcos",
        ),
    ]
    lower = text.lower()
    for needle, name, notes, status, ident in checks:
        if needle in lower:
            rows.append(ConditionRow("valentyna", name, notes, status, ident))
    return rows


def _valentyna_allergies(text: str) -> list[AllergyRow]:
    if "пшениц" not in text.lower():
        return []
    return [
        AllergyRow(
            "valentyna",
            "wheat",
            "Acute clinical food reactions, especially to wheat. Formal allergist conclusion not in this corpus.",
            "acute",
            "user_reported",
            "docs:valentyna:allergy:wheat",
        )
    ]


def _valentyna_allergy_skips(text: str) -> list[Skip]:
    skips = [
        Skip("docs valentyna §6 IgE table", "IgE table has no test_date and no source PDF; class 0 is not an allergy"),
        Skip("docs valentyna §6 retinol/SPF", "mechanism not confirmed; must not be stored as allergy"),
    ]
    if "j06.0" in text.lower() or "ларингофарингит" in text.lower():
        skips.append(Skip("docs valentyna §5.2 J06.0", "unattributed; not a Valentyna condition"))
    if "проблемы с суставами" in text.lower():
        skips.append(Skip("docs valentyna §7 joints", "too vague; exact diagnosis not stated"))
    return skips


def _valentyna_meds(text: str) -> tuple[list[MedicationRow], list[Skip]]:
    section = _section_body(text, "7.")
    started = sofia_midnight(date(2026, 7, 24))
    lactulose_started = sofia_midnight(date(2026, 7, 28))
    specs = [
        (
            "NOW Foods Hyaluronic Acid",
            "NOW Foods Hyaluronic Acid 100 mg with L-proline, alpha-lipoic acid and grape seed extract",
            "1 tablet",
            "1 per day",
            started,
            "user_reported",
        ),
        (
            "Youtheory Collagen",
            "Youtheory Collagen",
            "6 tablets",
            "immediately after waking, fasting (clarified 28.07.2026)",
            started,
            "user_reported",
        ),
        (
            "Ubiquinol",
            "California Gold Nutrition Ubiquinol 100 mg",
            "1 capsule",
            "after breakfast",
            started,
            "user_reported",
        ),
        (
            "Магний глицинат",
            "Magnesium glycinate 400 mg",
            "1 tablet",
            "1 per day; source does not say whether 400 mg is elemental Mg or the salt",
            started,
            "user_reported",
        ),
        (
            "Solgar Chelated Iron",
            "Solgar Chelated Iron 25 mg",
            "1 tablet",
            "immediately after waking, fasting",
            started,
            "user_reported",
        ),
        (
            "NOW Foods Vitamin D3",
            "NOW Foods Vitamin D3 & K2",
            "2 tablets",
            "after breakfast; per-tablet D3/K2 amounts not stated",
            started,
            "user_reported",
        ),
        (
            "California Gold Nutrition Omega-3",
            "California Gold Nutrition Omega-3",
            "1 capsule",
            "after breakfast; EPA/DHA not stated",
            started,
            "user_reported",
        ),
    ]
    rows: list[MedicationRow] = []
    skips: list[Skip] = []
    for needle, name, dose, schedule, started_at, status in specs:
        if needle.lower() in section.lower():
            rows.append(
                MedicationRow("valentyna", name, dose, schedule, started_at, status, f"docs:valentyna:med:{name[:40]}")
            )
        else:
            skips.append(Skip(f"docs valentyna §7 {needle}", "named supplement not found in clean profile"))
    if re.search(r"лактулоз|lactulose", section, re.I):
        rows.append(
            MedicationRow(
                "valentyna",
                "Lactulose syrup",
                "15 ml",
                "daily; doctor-prescribed (JPEG + Docs §7.1)",
                lactulose_started,
                "confirmed_by_doctor",
                "docs:valentyna:med:lactulose",
            )
        )
    if re.search(r"panixen focus|паниксен фокус", section, re.I):
        skips.append(
            Skip(
                "docs valentyna §7.1 Panixen Focus",
                "prescribed; start not confirmed",
                quote="Panixen Focus / Паниксен Фокус: 1 capsule 2 times daily, start unconfirmed",
            )
        )
    if re.search(r"panixen|паниксен", section, re.I):
        skips.append(
            Skip(
                "docs valentyna §7.1 Panixen",
                "prescribed; start not confirmed",
                quote="Panixen / Паниксен: start unconfirmed; dose reading uncertain",
            )
        )
    if "проростков ячменя" in section.lower() or "ячмен" in section.lower():
        skips.append(Skip("docs valentyna §7 barley powder", "optional, may be skipped; not a standing med"))
    return rows, skips


def _valentyna_meals(clean: str, original: str) -> list[MealRow]:
    rows: list[MealRow] = []
    if "помидоры черри" in clean.lower() or "любимый салат" in clean.lower():
        rows.append(
            MealRow(
                "valentyna",
                "Favourite salad/breakfast: cherry tomatoes, half a small avocado, coppa, mixed salad leaves with rocket, baby mozzarella or a smaller portion of bryndza, sesame or pumpkin-seed oil, a little lemon juice, black pepper.",
                sofia_midnight(date(2026, 7, 24)),
                "user_reported",
                "docs:valentyna:meal:2026-07-24",
                "docs:valentyna:meal:2026-07-24",
            )
        )
    if "4 мармеладки" in original and "половина яблока" in original:
        rows.append(
            MealRow(
                "valentyna",
                "4 gummies and half an apple.",
                sofia_midnight(date(2026, 7, 25)),
                "user_reported",
                "docs:valentyna:meal:2026-07-25",
                "docs:valentyna:meal:2026-07-25",
            )
        )
    return rows


def _valentyna_symptoms(text: str) -> list[SymptomRow]:
    rows: list[SymptomRow] = []
    lower = text.lower()
    if "retinol" in lower:
        rows.append(
            SymptomRow(
                "valentyna",
                "After evening BIOTRADE Retinol 0.2%: face red and slightly swollen, more on the right; next morning redness and mild edema remained. Formal allergy not established",
                sofia_midnight(date(2026, 7, 14)),
                "user_reported",
                "docs:valentyna:symptom:retinol-2026-07-14",
                "docs:valentyna:symptom:retinol-2026-07-14",
            )
        )
    if "spf" in lower and ("красн" in lower or "пекло" in lower):
        rows.append(
            SymptomRow(
                "valentyna",
                "After unnamed SPF “№1”: face very red and burning in strong sun",
                sofia_midnight(date(2026, 7, 5)),
                "historical_uncertain",
                "docs:valentyna:symptom:spf-2026-07-05",
                "docs:valentyna:symptom:spf-2026-07-05",
            )
        )
    if "имплант" in lower:
        rows.append(
            SymptomRow(
                "valentyna",
                "Implants at lower right 46 and 47; discomfort; white raised/sharp area on gum. No dentist conclusion in corpus",
                sofia_midnight(date(2026, 6, 22)),
                "user_reported",
                "docs:valentyna:symptom:implants-2026-06-22",
                "docs:valentyna:symptom:implants-2026-06-22",
            )
        )
    if "проблемы со стулом" in lower:
        rows.append(
            SymptomRow(
                "valentyna",
                "Stool problems, especially at the end of the luteal phase",
                sofia_midnight(date(2026, 7, 24)),
                "user_reported",
                "docs:valentyna:symptom:stool-2026-07-24",
                "docs:valentyna:symptom:stool-2026-07-24",
            )
        )
    if "изжог" in lower:
        rows.append(
            SymptomRow(
                "valentyna",
                "Heartburn more frequent lately, still mild; cause not established",
                sofia_midnight(date(2026, 8, 5)),
                "user_reported",
                "docs:valentyna:symptom:heartburn-2026-08-05",
                "docs:valentyna:symptom:heartburn-2026-08-05",
            )
        )
    return rows


def _journal_skips(andrii_text: str, valentyna_text: str) -> list[Skip]:
    skips = [
        Skip("docs andrii §8/§9", "chronology/journal not ingested as facts (garbled)"),
        Skip("docs valentyna §9/§11", "chronology/journal not ingested as facts (garbled)"),
        Skip("docs andrii §9 26.07 sleep", "approximate sleep (примерно 09:00–09:30); journal only"),
        Skip("docs andrii §9 enalapril", "deleted on user request; not a medication fact"),
        Skip("docs valentyna 25.07 cycle", "первый день менструации is journal-only; no cycle cashier type"),
        Skip("csv Дневник показателей здоровья.csv", "incomplete Sheet export; cross-check only, not ingested"),
        Skip("pdf Andrii_ramus_23_07_26.pdf", "partial early print; copied to raw/, not parsed"),
        Skip("healthdrive:valentyna-teeth/Data.zip", "excluded from this ingest"),
    ]
    if "1700" in valentyna_text:
        skips.append(Skip("docs valentyna 1700 kcal", "daily planning target, not a meal"))
    return skips


def _andrii_people(text: str) -> PeopleFacts:
    facts = PeopleFacts()
    name = re.search(r"Имя:\s*(.+)", text)
    dob = re.search(r"Дата рождения:\s*(\d{2}\.\d{2}\.\d{4})", text)
    height = re.search(r"рост\s+(\d{3})\s*см", text, re.I)
    facts.name = name.group(1).strip() if name else "Andrii / Андрей Приходько"
    facts.dob = dob.group(1) if dob else "18.07.1991"
    facts.height_cm = height.group(1) if height else "192"
    facts.extras = [
        "Meat preference noted 27.07.2026.",
        "Coffee/tea without sugar not stated as a change.",
        "Mounjaro prescribed 27.07.2026, not purchased, not started.",
        "CPAP recommended after OSA confirmation; device not obtained; not used now.",
        "1700 kcal/day is Valentyna’s planning target, not Andrii’s.",
    ]
    return facts


def _valentyna_people(text: str) -> PeopleFacts:
    facts = PeopleFacts()
    dob = re.search(r"Дата рождения:\s*(\d{2}\.\d{2}\.\d{4})", text)
    height = re.search(r"Рост:\s*(\d{3})\s*см", text)
    facts.name = "Valentyna / Валентина Ожегова Приходко (PDF spelling VALENTINA OZHEGOVA PRIHODKO)"
    facts.dob = dob.group(1) if dob else "12.04.1994"
    facts.height_cm = height.group(1) if height else "173"
    facts.extras = [
        "Coffee/tea without sugar is a long-standing habit.",
        "1700 kcal/day is a planning target, not a medical prescription.",
        "Skincare product list (Docs §3) is personal care, not medication.",
        "Implants 46–47 discussion without a dentist letter.",
    ]
    return facts


def write_people_pages(health_root: Path, people: dict[str, PeopleFacts]) -> None:
    for person, facts in people.items():
        dest = health_root / "people" / person / "PROFILE.md"
        dest.parent.mkdir(parents=True, exist_ok=True)
        lines = [
            f"# {person.capitalize()} — profile synthesis",
            "",
            "From non-garbled Doc profile sections. Not jsonl. Not medical advice.",
            "",
            f"- Name: {facts.name}",
            f"- Date of birth: {facts.dob}",
            f"- Height: {facts.height_cm} cm",
        ]
        for extra in facts.extras:
            lines.append(f"- {extra}")
        lines.append("")
        dest.write_text("\n".join(lines), encoding="utf-8")


def _section_body(text: str, prefix: str) -> str:
    lines = text.splitlines()
    start = None
    for i, line in enumerate(lines):
        if line.strip().startswith(prefix):
            start = i
            break
    if start is None:
        return text
    end = len(lines)
    root = prefix.split(".", 1)[0]
    for j in range(start + 1, len(lines)):
        match = SECTION_RE.match(lines[j].strip())
        if match and not match.group(1).startswith(root + ".") and match.group(1) != root:
            # next top-level or different numbered section at same depth
            current = match.group(1)
            if "." not in current or current.split(".", 1)[0] != root:
                if current != prefix.rstrip("."):
                    end = j
                    break
    return "\n".join(lines[start:end])


def _local_iso(day: str, clock: str) -> str:
    dd, mm, yyyy = day.split(".")
    hh, mi, ss = clock.split(":")
    return f"{yyyy}-{mm}-{dd}T{hh}:{mi}:{ss}"
