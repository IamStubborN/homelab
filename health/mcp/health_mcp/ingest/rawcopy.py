from __future__ import annotations

import shutil
from pathlib import Path

ANDRII_PDFS = (
    "Andrii_Ramus_2026-07-23_EN_full.pdf",
    "Andrii_Ramus_2026-07-23_BG_full.pdf",
    "Andrii_ramus_23_07_26.pdf",
)
VALENTYNA_PDFS = (
    "Valentyna_Ramus_2026-08-05_EN.pdf",
    "Valentyna_Ramus_2026-08-05_BG.pdf",
)
JPEG_NAME = "Valentyna — назначение Panixen, Panixen Focus и лактулозы — 28.07.2026.jpeg"
XLSX_NAME = "Дневник показателей здоровья.xlsx"
CSV_NAME = "Дневник показателей здоровья.csv"
EXCLUDED_ZIP = "valentyna-teeth/Data.zip"


def copy_raw(
    *,
    health_root: Path,
    raw_src: Path | None,
    export_dir: Path,
    xlsx_path: Path,
) -> list[str]:
    raw_andrii = health_root / "raw" / "andrii"
    raw_val = health_root / "raw" / "valentyna"
    raw_family = health_root / "raw" / "family"
    for path in (raw_andrii, raw_val, raw_family):
        path.mkdir(parents=True, exist_ok=True)
    copied: list[str] = []
    src_root = raw_src
    if src_root is None:
        raise SystemExit("raw source directory is required (copy Drive files locally first; do not modify Здоровье/)")
    for name in ANDRII_PDFS:
        copied.append(_copy_file(src_root / name, raw_andrii / name))
    for name in VALENTYNA_PDFS:
        copied.append(_copy_file(src_root / name, raw_val / name))
    jpeg = src_root / JPEG_NAME
    copied.append(_copy_file(jpeg, raw_val / JPEG_NAME))
    andrii_txt = export_dir / "Andrii.txt"
    val_txt = export_dir / "Valentyna.txt"
    if andrii_txt.is_file():
        copied.append(_copy_file(andrii_txt, raw_andrii / "Andrii.txt"))
    if val_txt.is_file():
        copied.append(_copy_file(val_txt, raw_val / "Valentyna.txt"))
    copied.append(_copy_file(xlsx_path, raw_family / XLSX_NAME))
    csv_path = export_dir / CSV_NAME
    if csv_path.is_file():
        dest = raw_family / CSV_NAME
        copied.append(_copy_file(csv_path, dest))
        note = raw_family / "Дневник показателей здоровья.csv.INCOMPLETE.txt"
        note.write_text(
            "Incomplete Google Sheet CSV export. Andrii BP only. Not ingested.\n",
            encoding="utf-8",
        )
        copied.append(str(note.relative_to(health_root)))
    zip_probe = src_root / "Data.zip"
    if zip_probe.exists():
        raise SystemExit(f"refusing to copy excluded archive {EXCLUDED_ZIP}")
    return copied


def _copy_file(src: Path, dest: Path) -> str:
    if not src.is_file():
        raise SystemExit(f"missing source file: {src}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dest)
    return str(dest)
