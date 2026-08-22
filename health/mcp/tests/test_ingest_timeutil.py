from datetime import date, time

from health_mcp.ingest.timeutil import as_float, as_int, combine_sofia, parse_sheet_date, parse_sheet_time


def test_excel_serial_date_and_fraction_time() -> None:
    assert parse_sheet_date(46224.0) == date(2026, 7, 21)
    assert parse_sheet_date("26.07.2026") == date(2026, 7, 26)
    assert parse_sheet_time(0.424375) == time(10, 11, 6)
    assert parse_sheet_time("03:39:01") == time(3, 39, 1)
    assert parse_sheet_time("14:59") == time(14, 59, 0)
    assert combine_sofia(date(2026, 7, 21), time(10, 11, 6)) == "2026-07-21T10:11:06+03:00"


def test_missing_time_is_none() -> None:
    assert parse_sheet_time(None) is None
    assert parse_sheet_time("") is None
    assert parse_sheet_date(None) is None


def test_cast_sheet_floats_to_int() -> None:
    assert as_int(148.0) == 148
    assert as_int("148.0") == 148
    assert as_int("") is None
    assert as_float("75,9") == 75.9
    assert as_float(None) is None
