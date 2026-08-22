from __future__ import annotations

import io
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
from matplotlib import font_manager

from health_mcp.types import CashierError

WIDTH = 900
HEIGHT = 500
DPI = 100
KYIV = ZoneInfo("Europe/Kyiv")
FONT_PATH = Path(__file__).resolve().parents[1] / "assets" / "DejaVuSans.ttf"

_font_registered = False


def _ensure_font() -> font_manager.FontProperties:
    global _font_registered
    if not FONT_PATH.is_file():
        raise CashierError("chart rendering failed: missing DejaVuSans.ttf")
    if not _font_registered:
        font_manager.fontManager.addfont(str(FONT_PATH))
        _font_registered = True
    return font_manager.FontProperties(fname=str(FONT_PATH))


def kyiv_date_label(event_time: datetime) -> str:
    local = event_time.astimezone(KYIV)
    return f"{local.day:02d}.{local.month:02d}"


def render_measurement_chart(
    *,
    title: str,
    kind: str,
    points: list[tuple[datetime, dict[str, Any]]],
) -> bytes:
    if not points:
        raise CashierError("measurement series is empty")

    font = _ensure_font()
    fields = ("systolic", "diastolic") if kind == "blood_pressure" else ("value",)
    series: dict[str, list[tuple[float, float]]] = {}
    all_values: list[float] = []
    for index, (_when, values) in enumerate(points):
        for field in fields:
            raw = values.get(field)
            if raw is None:
                continue
            number = float(raw)
            series.setdefault(field, []).append((float(index), number))
            all_values.append(number)
    if not all_values:
        raise CashierError("measurement series is empty")

    y_min = min(all_values)
    y_max = max(all_values)
    if y_min == y_max:
        pad = 1.0 if y_min == 0 else abs(y_min) * 0.05
        y_min -= pad
        y_max += pad
    else:
        pad = (y_max - y_min) * 0.08
        y_min -= pad
        y_max += pad

    labels = [kyiv_date_label(when) for when, _values in points]
    fig, ax = plt.subplots(figsize=(WIDTH / DPI, HEIGHT / DPI), dpi=DPI)
    try:
        ax.set_title(title, fontproperties=font, fontsize=16)
        ax.set_xlim(0, max(len(points) - 1, 1))
        ax.set_ylim(y_min, y_max)
        ticks = _x_ticks(len(points))
        ax.set_xticks(ticks)
        ax.set_xticklabels([labels[i] for i in ticks], fontproperties=font)
        for label in ax.get_yticklabels():
            label.set_fontproperties(font)

        colors = {"systolic": "#cc0000", "diastolic": "#1f4e79", "value": "#1f4e79"}
        for field, values in series.items():
            xs = [x for x, _y in values]
            ys = [y for _x, y in values]
            color = colors.get(field, "#1f4e79")
            ax.plot(xs, ys, color=color, linewidth=2.2, label=field)
            ax.scatter(xs, ys, color=color, s=28, zorder=3)

        if kind == "blood_pressure":
            ax.legend(prop=font)
        ax.grid(True, alpha=0.25)
        fig.tight_layout()
        buf = io.BytesIO()
        fig.savefig(buf, format="png", dpi=DPI)
        return buf.getvalue()
    finally:
        plt.close(fig)


def _x_ticks(count: int) -> list[int]:
    if count <= 1:
        return [0]
    max_labels = min(10, count)
    if count <= max_labels:
        return list(range(count))
    step = (count - 1) / (max_labels - 1)
    return sorted({round(i * step) for i in range(max_labels)})
