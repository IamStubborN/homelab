from __future__ import annotations

import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

from health_mcp.ingest.xlsx import parse_workbook


def _sheet_xml(rows: list[list[object]]) -> str:
    cells = []
    for r_i, row in enumerate(rows, 1):
        for c_i, value in enumerate(row):
            col = chr(ord("A") + c_i)
            ref = f"{col}{r_i}"
            if value is None:
                continue
            if isinstance(value, str):
                cells.append(f'<c r="{ref}" t="inlineStr"><is><t>{escape(value)}</t></is></c>')
            else:
                cells.append(f'<c r="{ref}"><v>{value}</v></c>')
    inner = "".join(cells)
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f"<sheetData>{inner}</sheetData></worksheet>"
    )


def _write_xlsx(path: Path, sheets: dict[str, list[list[object]]]) -> None:
    names = list(sheets)
    workbook_sheets = []
    rels = []
    content = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
        '<Default Extension="xml" ContentType="application/xml"/>',
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    ]
    for i, name in enumerate(names, 1):
        workbook_sheets.append(f'<sheet name="{escape(name)}" sheetId="{i}" r:id="rId{i}"/>')
        rels.append(
            f'<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i}.xml"/>'
        )
        content.append(
            f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        )
    content.append("</Types>")
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("[Content_Types].xml", "".join(content))
        archive.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            "</Relationships>",
        )
        archive.writestr(
            "xl/_rels/workbook.xml.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + "".join(rels)
            + "</Relationships>",
        )
        archive.writestr(
            "xl/workbook.xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            f"<sheets>{''.join(workbook_sheets)}</sheets></workbook>",
        )
        for i, name in enumerate(names, 1):
            archive.writestr(f"xl/worksheets/sheet{i}.xml", _sheet_xml(sheets[name]))


def test_weight_sheet_splits_c_and_d_and_skips_missing_time(tmp_path: Path) -> None:
    header = ["Дата", "Время", "Valentyna, кг", "Andrii, кг", "dV", "dA", "Источник", "Дата внесения"]
    path = tmp_path / "weight.xlsx"
    _write_xlsx(
        path,
        {
            "Andrii": [["x"]] * 5,
            "Сон Andrii": [["x"]] * 5,
            "Valentyna": [["x"]] * 5,
            "Вес": [
                ["title"],
                ["note"],
                [],
                header,
                ["24.07.2026", "23:39:22", 70.1, 90.2, 0, 0, "Фото весов", "24.07.2026"],
                ["12.08.2026", None, None, 91.0, None, -0.2, "Со слов пользователя", "12.08.2026"],
                ["25.07.2026", "15:13:13", None, 89.5, None, -0.7, "Со слов пользователя", "25.07.2026"],
            ],
            "Приём препаратов Andrii": [["x"]] * 5,
        },
    )
    parsed = parse_workbook(path)
    weights = [row for row in parsed.measurements if row.kind == "weight"]
    assert {(row.person, row.values["value"]) for row in weights} == {
        ("valentyna", 70.1),
        ("andrii", 90.2),
        ("andrii", 89.5),
    }
    assert all(row.source_event_id.startswith("xlsx:weight:r") for row in weights)
    assert any(skip.ident.endswith("r6:andrii") and skip.reason == "missing time" for skip in parsed.skips)


def test_bp_skips_empty_time_and_does_not_emit_pulse_kind(tmp_path: Path) -> None:
    header = [
        "Дата",
        "Время",
        "Систолическое, мм рт. ст.",
        "Диастолическое, мм рт. ст.",
        "Пульс, уд/мин",
        "pp",
        "map",
        "Тип измерения",
        "Источник",
        "Комментарий",
        "Дата внесения",
    ]
    path = tmp_path / "bp.xlsx"
    _write_xlsx(
        path,
        {
            "Andrii": [
                ["title"],
                ["note"],
                [],
                header,
                ["21.07.2026", "10:11:06", 148.0, 106.0, 69.0, 42, 120, "Артериальное давление", "Фото тонометра", "", "21.07.2026"],
                [],
                ["12.08.2026", None, 150, 102, 85, 48, 118, "Артериальное давление", "Со слов пользователя", "no time", "12.08.2026"],
            ],
            "Сон Andrii": [["x"]] * 5,
            "Valentyna": [["x"]] * 5,
            "Вес": [["x"]] * 5,
            "Приём препаратов Andrii": [
                ["title"],
                ["note"],
                ["upd"],
                ["Препарат", "Статус", "Дата начала", "Доза", "Частота", "Еда", "Когда", "Курс", "Пропуски", "Примечание"],
                ["DemoMed", "Принимается", "23.07.2026", "1 tab", "1x", "with food", "morning", "none", "none", "note"],
                ["NotYet", "Не начат", "—", "2 mg", "1x", "n/a", "n/a", "n/a", "n/a", "not bought"],
            ],
        },
    )
    parsed = parse_workbook(path)
    assert [row.kind for row in parsed.measurements] == ["blood_pressure"]
    assert parsed.measurements[0].values == {"systolic": 148, "diastolic": 106, "pulse": 69}
    assert parsed.measurements[0].status == "confirmed_by_document"
    assert parsed.medications[0].name == "DemoMed"
    assert any("Не начат" in skip.reason for skip in parsed.skips)
    assert any(skip.reason == "missing time" for skip in parsed.skips)
