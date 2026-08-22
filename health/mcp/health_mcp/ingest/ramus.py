from __future__ import annotations

import re
import shutil
import subprocess
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from health_mcp.ingest.xlsx import Skip

BIO_MAT = ("Blood", "Serum", "Urine")
UNITS = (
    "mm/h",
    "G/l",
    "T/l",
    "%",
    "fl",
    "pg",
    "g/l",
    "l/l",
    "mmol/l",
    "umol/l",
    "U/l",
    "ng/dl",
    "uIU/ml",
    "pg/ml",
    "IU/ml",
    "uU/ml",
    "Index",
    "ug/dl",
    "ng/ml",
    "ug/l",
    "mg/l",
    "mg/dl",
)
OCR_FIXES = (
    ("C reatinine", "Creatinine"),
    ("C ortisol", "Cortisol"),
    ("C alcium=C a", "Calcium=Ca"),
    ("C alcium", "Calcium"),
    ("tC a", "tCa"),
    ("C -reactive protein=C RP", "CRP"),
    ("C -reactive protein=CRP", "CRP"),
    ("C RP", "CRP"),
    ("MC HC", "MCHC"),
    ("MC H", "MCH"),
    ("MC V", "MCV"),
    ("RDW-C V", "RDW-CV"),
    ("C obalamin", "Cobalamin"),
    ("C BC", "CBC"),
)

# PDF label (after OCR fix + whitespace collapse) -> stored English test_name.
ALIASES: tuple[tuple[str, str], ...] = (
    ("ESR", "ESR"),
    ("WBC abs count", "WBC abs count"),
    ("NEU %", "NEU %"),
    ("NEU abs count", "NEU abs count"),
    ("EOS %", "EOS %"),
    ("EOS abs count", "EOS abs count"),
    ("LYM %", "LYM %"),
    ("LYM abs count", "LYM abs count"),
    ("MON %", "MON %"),
    ("MON abs count", "MON abs count"),
    ("BAS %", "BAS %"),
    ("BAS abs count", "BAS abs count"),
    ("RBC abs count", "RBC abs count"),
    ("Hb", "Hb"),
    ("Hct", "Hct"),
    ("MCV", "MCV"),
    ("MCHC", "MCHC"),
    ("MCH", "MCH"),
    ("RDW-CV", "RDW-CV"),
    ("PLT abs count", "PLT abs count"),
    ("MPV", "MPV"),
    ("PDW", "PDW"),
    ("pH (spot urine)", "pH (spot urine)"),
    ("pH (Dry chemistry) (spot urine)", "pH (spot urine)"),
    ("Specific gravity (spot urine)", "Specific gravity (spot urine)"),
    ("Oтносително тегло/Specific gravity", "Specific gravity (spot urine)"),
    ("HbA1c", "HbA1c"),
    ("Glucose random or fasting", "Glucose random or fasting"),
    ("Glucose random nonpregnant", "Glucose random or fasting"),
    ("Creatinine (Jaffe method)", "Creatinine"),
    ("Uric acid", "Uric acid"),
    ("Total protein (serum)", "Total protein"),
    ("Total protein", "Total protein"),
    ("Albumin", "Albumin"),
    ("Total cholesterol", "Total cholesterol"),
    ("Triglycerides", "Triglycerides"),
    ("HDL-cholesterol", "HDL-cholesterol"),
    ("LDL-cholesterol", "LDL-cholesterol"),
    ("Urea", "Urea"),
    ("Total bilirubin", "Total bilirubin"),
    ("Direct=conjugated bilirubin", "Direct bilirubin"),
    ("Alkaline phosphatase=ALP", "ALP"),
    ("Amylase", "Amylase"),
    ("Alpha-amylase=Total amylase", "Amylase"),
    ("ASAT activity", "AST"),
    ("ASAT", "AST"),
    ("ALAT activity", "ALT"),
    ("ALAT", "ALT"),
    ("GGT activity", "GGT"),
    ("GGT", "GGT"),
    ("Potassium=K", "Potassium"),
    ("Potassium=К", "Potassium"),
    ("Sodium=Na", "Sodium"),
    ("Calcium=Ca", "Calcium"),
    ("Total calcium=tCa", "Calcium"),
    ("Inorganic phosphorus=P", "Inorganic phosphorus"),
    ("Magnesium=Mg", "Magnesium"),
    ("Iron=Fe", "Iron"),
    ("fT4", "fT4"),
    ("TSH", "TSH"),
    ("fT3", "fT3"),
    ("Anti-Tg IgG", "Anti-Tg IgG"),
    ("Anti-TPO Ab", "Anti-TPO Ab"),
    ("Insulin (fasting)", "Insulin (fasting)"),
    ("Insulin", "Insulin (fasting)"),
    ("HOMA-IR", "HOMA-IR"),
    ("Cortisol (glucocorticoid)", "Cortisol"),
    ("Cortisol", "Cortisol"),
    ("Folic acid=Vitamin B9", "Folic acid"),
    ("Folic acid", "Folic acid"),
    ("Total L-homocysteine", "Total L-homocysteine"),
    ("Ferritin", "Ferritin"),
    ("25(OH)-Vitamin D", "25(OH)-Vitamin D"),
    ("Vitamin B12=Cobalamin", "Vitamin B12"),
    ("Vitamin B12", "Vitamin B12"),
    ("Vitamin B1=Thiamine pyrophosphate", "Vitamin B1"),
    ("Vitamin B6=Pyridoxal-5-phosphate=PLP", "Vitamin B6"),
    ("Vitamin B6=Pyridoxal-5-phosphate", "Vitamin B6"),
    ("CRP", "CRP"),
    ("Lipoprotein (a)", "Lipoprotein (a)"),
    ("Lipase", "Pancreatic lipase"),
    ("Pancreatic lipase", "Pancreatic lipase"),
    ("Helicobacter pylori IgA (Euroline-WB)", "Helicobacter pylori IgA"),
    ("Helicobacter pylori IgG (Euroline-WB)", "Helicobacter pylori IgG"),
    ("Protein (spot urine)", "Protein (spot urine)"),
    ("Glucose (spot urine)", "Glucose (spot urine)"),
    ("Ketone (spot urine)", "Ketone (spot urine)"),
    ("Bilirubin (spot urine)", "Bilirubin (spot urine)"),
    ("Blood (spot urine)", "Blood (spot urine)"),
    ("Leucocytes (spot urine)", "Leucocytes (spot urine)"),
    ("Nitrite (spot urine)", "Nitrite (spot urine)"),
    ("Urobilinogen (spot urine)", "Urobilinogen (spot urine)"),
)

SKIP_ALWAYS = frozenset(
    {
        "Lipoprotein (a)",
        "Protein (spot urine)",
        "Glucose (spot urine)",
        "Ketone (spot urine)",
        "Bilirubin (spot urine)",
        "Blood (spot urine)",
        "Leucocytes (spot urine)",
        "Nitrite (spot urine)",
        "Urobilinogen (spot urine)",
        "Helicobacter pylori IgA",
        "Helicobacter pylori IgG",
        "Pancreatic lipase",
        "Vitamin B6",
    }
)
SEDIMENT_PREFIXES = (
    "RBC",
    "WBC",
    "Squamous epithelial cells",
    "Non-squamous epithelial cells",
    "Hyaline casts",
    "Granular casts",
    "Calcium oxalate crystals",
    "Bacteria",
    "Yeasts",
)

COLLECTION_RE = re.compile(
    r"Sample collection date:\s*(\d{2}\.\d{2}\.\d{4})",
    re.I,
)
RESULT_TOKEN = re.compile(
    r"^(?:\(\-\)\s*)?(?:negative|normal)$|^[<>]=?\s*[\d.]+$|^\d+\s*-\s*\d+$|^[-–—]$|^-\s*HPF$",
    re.I,
)
NUMBER_RE = re.compile(r"^-?\d+(?:\.\d+)?$")


@dataclass
class LabRow:
    person: str
    test_date: str
    test_name: str
    value: float
    unit: str | None
    reference_min: float | None
    reference_max: float | None
    flag: str | None
    laboratory: str
    source_document: str
    status: str
    ident: str


@dataclass
class LabParse:
    labs: list[LabRow] = field(default_factory=list)
    skips: list[Skip] = field(default_factory=list)


def extract_pdf_text(path: Path) -> str:
    binary = shutil.which("pdftotext")
    if binary:
        completed = subprocess.run(
            [binary, "-layout", str(path), "-"],
            check=True,
            capture_output=True,
            text=True,
        )
        return completed.stdout
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise SystemExit(f"need pdftotext or pypdf to read {path}") from exc
    reader = PdfReader(str(path))
    return "\n".join(page.extract_text() or "" for page in reader.pages)


def parse_ramus_pair(
    *,
    person: str,
    en_text: str,
    bg_text: str,
    source_document: str,
    female: bool,
) -> LabParse:
    test_date = _collection_date(en_text) or _collection_date(bg_text)
    if test_date is None:
        return LabParse(skips=[Skip(f"pdf:{person}", "missing sample collection date")])
    en_rows = _parse_panel_text(en_text)
    bg_rows = _parse_panel_text(bg_text)
    bg_by_name = {row["name"]: row for row in bg_rows}
    result = LabParse()
    seen: set[str] = set()
    for parsed in en_rows:
        name = parsed["name"]
        if name in seen:
            continue
        seen.add(name)
        ident = f"pdf:{person}:{name}"
        if name in SKIP_ALWAYS or parsed.get("sediment"):
            reason = parsed.get("skip_reason") or "qualitative or excluded panel row"
            if name.startswith("Helicobacter"):
                reason = "H. pylori not a float; EN empty / BG (-) negative is ambiguous"
            elif name == "Lipoprotein (a)":
                reason = "inequality result, not a float"
            result.skips.append(Skip(ident, str(reason), quote=parsed.get("line")))
            continue
        value = parsed.get("value")
        if value is None:
            result.skips.append(
                Skip(ident, parsed.get("skip_reason") or "empty or non-float result", quote=parsed.get("line"))
            )
            continue
        refs = (parsed.get("reference_min"), parsed.get("reference_max"))
        if refs == (None, None):
            bg = bg_by_name.get(name)
            if bg:
                refs = _refs_for(bg, female=female)
        else:
            refs = _refs_for(parsed, female=female)
        result.labs.append(
            LabRow(
                person=person,
                test_date=test_date.isoformat(),
                test_name=name,
                value=float(value),
                unit=parsed.get("unit"),
                reference_min=refs[0],
                reference_max=refs[1],
                flag=parsed.get("flag"),
                laboratory="SMDL Ramus",
                source_document=source_document,
                status="confirmed_by_document",
                ident=ident,
            )
        )
    for parsed in en_rows:
        if parsed["name"] not in seen and parsed.get("sediment"):
            result.skips.append(Skip(f"pdf:{person}:{parsed['name']}", "urine sediment", quote=parsed.get("line")))
    # Pending / qualitative rows that only showed up clearly on BG (H. pylori).
    for parsed in bg_rows:
        name = parsed["name"]
        if name in seen:
            continue
        if name in SKIP_ALWAYS or parsed.get("sediment"):
            result.skips.append(Skip(f"pdf:{person}:{name}", parsed.get("skip_reason") or "qualitative or excluded", quote=parsed.get("line")))
    return result


def parse_ramus_pdfs(
    *,
    person: str,
    en_pdf: Path,
    bg_pdf: Path,
    source_document: str,
    female: bool,
) -> LabParse:
    return parse_ramus_pair(
        person=person,
        en_text=extract_pdf_text(en_pdf),
        bg_text=extract_pdf_text(bg_pdf),
        source_document=source_document,
        female=female,
    )


def _collection_date(text: str) -> date | None:
    match = COLLECTION_RE.search(text)
    if not match:
        return None
    day, month, year = match.group(1).split(".")
    return date(int(year), int(month), int(day))


def _parse_panel_text(text: str) -> list[dict[object, object]]:
    lines = _join_wrapped_names([_normalize_line(line) for line in text.splitlines() if _normalize_line(line)])
    parsed_rows: list[dict[object, object]] = []
    in_sediment = False
    for line in lines:
        if not line:
            continue
        if line.startswith("Sediment (spot urine)"):
            in_sediment = True
            continue
        if line.startswith("Биохимия") or line.startswith("Biochemistry") or "/" in line[:40] and "Biochemistry" in line:
            in_sediment = False
        if in_sediment:
            sediment_name = _sediment_name(line)
            if sediment_name:
                parsed_rows.append(
                    {
                        "name": sediment_name,
                        "sediment": True,
                        "skip_reason": "urine sediment",
                        "line": line,
                    }
                )
            continue
        mapped = _match_alias(line)
        if mapped is None:
            continue
        stored, rest = mapped
        row = _parse_result_tail(stored, rest, line)
        parsed_rows.append(row)
    return parsed_rows


def _normalize_line(line: str) -> str:
    text = line.replace("\xa0", " ")
    for src, dst in OCR_FIXES:
        text = text.replace(src, dst)
    return " ".join(text.split())


def _join_wrapped_names(lines: list[str]) -> list[str]:
    joined: list[str] = []
    for line in lines:
        if joined and line == "phosphorus=P":
            prev = joined[-1]
            if "/Inorganic " in prev and "phosphorus=P" not in prev:
                joined[-1] = prev.replace("/Inorganic ", "/Inorganic phosphorus=P ", 1)
            else:
                joined[-1] = f"{prev} {line}"
            continue
        if joined and line == "(whole blood)":
            joined[-1] = f"{joined[-1]} {line}"
            continue
        mapped = _match_alias(line)
        if (
            mapped
            and joined
            and not _tail_has_number(mapped[1])
            and _match_alias(joined[-1]) is None
            and any(bio in joined[-1] for bio in BIO_MAT)
        ):
            stored, rest = mapped
            joined[-1] = f"{stored} {joined[-1]} {rest}".strip()
            continue
        joined.append(line)
    return joined


def _tail_has_number(rest: str) -> bool:
    return any(NUMBER_RE.match(token.replace(",", ".")) for token in rest.split())


def _match_alias(line: str) -> tuple[str, str] | None:
    best: tuple[int, str, str] | None = None
    for alias, stored in ALIASES:
        if line.startswith(alias + " ") or line == alias:
            rest = line[len(alias) :].strip()
            if best is None or len(alias) > best[0]:
                best = (len(alias), stored, rest)
    if best is None:
        # aliases that appear after a Bulgarian prefix: ".../ESR ..."
        for alias, stored in ALIASES:
            token = "/" + alias
            idx = line.find(token + " ")
            if idx == -1:
                idx = line.find(token)
                if idx == -1 or idx + len(token) != len(line):
                    continue
            rest = line[idx + len(token) :].strip()
            if best is None or len(alias) > best[0]:
                best = (len(alias), stored, rest)
    if best is None:
        return None
    return best[1], best[2]


def _sediment_name(line: str) -> str | None:
    for prefix in SEDIMENT_PREFIXES:
        if line.startswith(prefix + " ") or line.startswith(prefix + "/") or line == prefix:
            return prefix
        token = "/" + prefix
        if token in line:
            return prefix
    return None


def _parse_result_tail(name: str, rest: str, line: str) -> dict[str, object]:
    tokens = rest.split()
    flag = None
    while tokens and tokens[0].startswith("("):
        tokens = tokens[1:]
    if tokens and tokens[0] in BIO_MAT:
        tokens = tokens[1:]
    if tokens and tokens[0] in {"H", "L"}:
        flag = tokens[0]
        tokens = tokens[1:]
    skip_reason = None
    value = None
    unit = None
    ref_raw = ""
    if tokens:
        if tokens[0] in UNITS:
            skip_reason = "empty result column"
            unit = tokens[0]
            ref_raw = " ".join(tokens[1:])
        elif (
            RESULT_TOKEN.match(tokens[0])
            or tokens[0] in {"(-)", "(-)negative"}
            or (
                tokens[0] in {"<", ">", "<=", ">="}
                and len(tokens) > 1
                and NUMBER_RE.match(tokens[1].replace(",", "."))
            )
        ):
            skip_reason = "qualitative or inequality result"
            ref_raw = " ".join(tokens)
        elif NUMBER_RE.match(tokens[0].replace(",", ".")):
            value = float(tokens[0].replace(",", "."))
            tokens = tokens[1:]
            if tokens and tokens[0] in UNITS:
                unit = tokens[0]
                tokens = tokens[1:]
            ref_raw = " ".join(tokens)
        else:
            skip_reason = "unparsed result"
            ref_raw = " ".join(tokens)
    else:
        skip_reason = "empty result column"
    ref_min, ref_max = parse_reference(ref_raw, female=False, apply_sex=False)
    return {
        "name": name,
        "value": value,
        "unit": unit,
        "flag": flag,
        "reference_min": ref_min,
        "reference_max": ref_max,
        "ref_raw": ref_raw,
        "skip_reason": skip_reason,
        "line": line,
    }


def _refs_for(parsed: dict[str, object], *, female: bool) -> tuple[float | None, float | None]:
    raw = str(parsed.get("ref_raw") or "")
    if raw.strip():
        return parse_reference(raw, female=female, apply_sex=True)
    return parsed.get("reference_min"), parsed.get("reference_max")  # type: ignore[return-value]


def parse_reference(raw: str, *, female: bool, apply_sex: bool) -> tuple[float | None, float | None]:
    text = " ".join(raw.split())
    if not text:
        return None, None
    # Drop trailing method tokens (single words after the range).
    text = re.sub(
        r"\s+(?:MAPSS|HPLC|CMIA|C MIA|ISE|Urease|Uricase|Biuret|Ferene|NGSP|Immunot|Enzymati|Calculate|C alculate|KAP|p-NPP|GGPNA|GPO|Dry|chemistry|Abs\.|photomet|colorimet|Capillary|C apillary|Euroline-).*$",
        "",
        text,
        flags=re.I,
    )
    if re.search(r">\s*[\d.]+\s*;\s*>\s*[\d.]+", text):
        return None, None
    if re.search(r"<\s*[\d.]+\s*;.+(?:<|препор)", text, re.I):
        return None, None
    if apply_sex:
        sexed = re.search(
            r"((?:[<>]=?\s*)?[\d.]+(?:\s*-\s*[\d.]+)?)\s*m\s*;\s*((?:[<>]=?\s*)?[\d.]+(?:\s*-\s*[\d.]+)?)\s*f",
            text,
            re.I,
        )
        if sexed:
            token = sexed.group(2 if female else 1)
            return _simple_bound(token)
    match = re.match(r"([<>]=?\s*[\d.]+|[\d.]+\s*-\s*[\d.]+)", text)
    if not match:
        return None, None
    return _simple_bound(match.group(1))


def _simple_bound(token: str) -> tuple[float | None, float | None]:
    text = token.replace(" ", "")
    if text.startswith("<=") or text.startswith("<"):
        return None, float(re.sub(r"^[<=]+", "", text))
    if text.startswith(">=") or text.startswith(">"):
        return float(re.sub(r"^[>=]+", "", text)), None
    if "-" in text:
        left, right = text.split("-", 1)
        return float(left), float(right)
    return None, None
