from health_mcp.ingest.ramus import parse_ramus_pair, parse_reference


def test_parse_reference_bounds() -> None:
    assert parse_reference("3.9 - 10.2", female=False, apply_sex=True) == (3.9, 10.2)
    assert parse_reference("<15", female=False, apply_sex=True) == (None, 15.0)
    assert parse_reference("<=5.00", female=False, apply_sex=True) == (None, 5.0)
    assert parse_reference(">=1.55", female=False, apply_sex=True) == (1.55, None)
    assert parse_reference(">30; >150 toxic", female=False, apply_sex=True) == (None, None)
    assert parse_reference("< 3.60; препоръчани стойности < 3.0", female=True, apply_sex=True) == (None, None)
    assert parse_reference("<15 m; <20 f", female=True, apply_sex=True) == (None, 20.0)
    assert parse_reference("3.2-7.4 m; 2.5-6.7 f", female=True, apply_sex=True) == (2.5, 6.7)


def test_ramus_skips_inequality_and_empty() -> None:
    en = """
Sample collection date:      01.02.2026
ESR                                     Blood   H                  12 mm/h          <15
Glucose random or fasting         Serum                     4.4 mmol/l         3.5 - 5.6
Lipoprotein (a)                   Serum                    < 3.1 mg/dl         <=30
Lipase                                  Serum                      U/l            0 - 63
Protein (spot urine)                            (-) negative
"""
    bg = """
Sample collection date:      01.02.2026
ESR Blood H 12 mm/h <15 m; <20 f
Glucose random or fasting Serum 4.4 mmol/l 3.5 - 5.6
"""
    parsed = parse_ramus_pair(
        person="valentyna",
        en_text=en,
        bg_text=bg,
        source_document="raw/valentyna/fake.pdf",
        female=True,
    )
    names = {row.test_name: row for row in parsed.labs}
    assert set(names) == {"ESR", "Glucose random or fasting"}
    assert names["ESR"].value == 12.0
    assert names["ESR"].flag == "H"
    assert names["ESR"].test_date == "2026-02-01"
    skip_ids = {skip.ident for skip in parsed.skips}
    assert "pdf:valentyna:Lipoprotein (a)" in skip_ids
    assert "pdf:valentyna:Pancreatic lipase" in skip_ids
    assert "pdf:valentyna:Protein (spot urine)" in skip_ids
