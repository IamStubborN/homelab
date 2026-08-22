from __future__ import annotations

import re
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

SOFIA = ZoneInfo("Europe/Sofia")
_EXCEL_EPOCH = datetime(1899, 12, 30)
_INT_RE = re.compile(r"^-?\d+(?:\.0+)?$")
_FLOAT_RE = re.compile(r"^-?\d+(?:\.\d+)?$")
_SERIAL_RE = re.compile(r"^\d+(?:\.\d+)?$")


def combine_sofia(day: date, clock: time) -> str:
    return datetime(day.year, day.month, day.day, clock.hour, clock.minute, clock.second, tzinfo=SOFIA).isoformat()


def sofia_midnight(day: date) -> str:
    return combine_sofia(day, time(0, 0, 0))


def parse_sheet_date(value: object) -> date | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return _serial_date(float(value))
    text = str(value).strip()
    if _SERIAL_RE.fullmatch(text) and "." in text:
        serial = float(text)
        if serial >= 20000:
            return _serial_date(serial)
    if _SERIAL_RE.fullmatch(text) and "." not in text:
        serial = float(text)
        if serial >= 20000:
            return _serial_date(serial)
    for fmt in ("%d.%m.%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


def parse_sheet_time(value: object) -> time | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.time().replace(microsecond=0)
    if isinstance(value, time):
        return value.replace(microsecond=0)
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return _fraction_time(float(value))
    text = str(value).strip()
    if _SERIAL_RE.fullmatch(text):
        number = float(text)
        if 0 <= number < 1.0000001:
            return _fraction_time(number)
    for fmt in ("%H:%M:%S", "%H:%M"):
        try:
            return datetime.strptime(text, fmt).time()
        except ValueError:
            continue
    return None


def as_int(value: object) -> int | None:
    if value is None or value == "" or isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        rounded = round(value)
        if abs(value - rounded) < 1e-9:
            return int(rounded)
        return None
    text = str(value).strip().replace(",", ".")
    if _INT_RE.fullmatch(text):
        return int(float(text))
    if _FLOAT_RE.fullmatch(text):
        number = float(text)
        rounded = round(number)
        if abs(number - rounded) < 1e-9:
            return int(rounded)
    return None


def as_float(value: object) -> float | None:
    if value is None or value == "" or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(",", ".")
    if _FLOAT_RE.fullmatch(text):
        return float(text)
    return None


def _serial_date(serial: float) -> date:
    return (_EXCEL_EPOCH + timedelta(days=serial)).date()


def _fraction_time(fraction: float) -> time | None:
    if fraction < 0 or fraction >= 1.0000001:
        return None
    seconds = int(round(min(fraction, 1.0) * 86400))
    if seconds >= 86400:
        seconds = 86399
    hours, rem = divmod(seconds, 3600)
    minutes, secs = divmod(rem, 60)
    return time(hours, minutes, secs)
