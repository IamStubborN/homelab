from __future__ import annotations

from datetime import UTC, datetime

import pytest

from health_mcp.auth import Identity
from health_mcp.charts import kyiv_date_label, render_measurement_chart
from health_mcp.store import WikiStore
from health_mcp.types import CashierError

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def test_empty_series_errors() -> None:
    with pytest.raises(CashierError, match="measurement series is empty"):
        render_measurement_chart(title="empty", kind="weight", points=[])


def test_png_magic_and_cyrillic_title() -> None:
    when = datetime(2026, 3, 29, 12, 0, tzinfo=UTC)
    png = render_measurement_chart(
        title="Андрей — давление, 30 дней",
        kind="blood_pressure",
        points=[(when, {"systolic": 120, "diastolic": 80})],
    )
    assert png.startswith(PNG_MAGIC)


def test_kyiv_dst_labels() -> None:
    march = datetime(2026, 3, 29, 0, 0, tzinfo=UTC)
    october = datetime(2026, 10, 25, 0, 0, tzinfo=UTC)
    assert kyiv_date_label(march) == "29.03"
    assert kyiv_date_label(october) == "25.10"


def test_generate_chart_tool_returns_png(store: WikiStore, identity: Identity) -> None:
    store.add_measurement(
        identity,
        kind="weight",
        values={"value": 80, "unit": "kg"},
        event_time="2026-08-04T14:30:00+03:00",
    )
    png = store.generate_chart(identity, kind="weight", title="Андрей — вес")
    assert png.startswith(PNG_MAGIC)


def test_chart_days_limit(store: WikiStore, identity: Identity) -> None:
    with pytest.raises(CashierError, match="invalid days: maximum is 3650"):
        store.generate_chart(identity, kind="weight", days=3651)
