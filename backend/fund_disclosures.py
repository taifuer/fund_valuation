"""Parse public fund disclosures as data, without executing upstream JavaScript."""
from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from .performance import finite_number


def assignment(text: str, name: str) -> Any:
    match = re.search(rf"\bvar\s+{re.escape(name)}\s*=\s*", text)
    if not match:
        return None
    try:
        return json.JSONDecoder().raw_decode(text, match.end())[0]
    except (ValueError, TypeError):
        return None


def disclosure_history(text: str) -> list[dict[str, Any]]:
    accumulated = assignment(text, "Data_ACWorthTrend")
    accumulated_by_time = {row[0]: row[1] for row in accumulated if isinstance(row, list) and len(row) == 2} if isinstance(accumulated, list) else {}
    trend = assignment(text, "Data_netWorthTrend")
    points = []
    previous_nav = None
    for row in trend if isinstance(trend, list) else []:
        if not isinstance(row, dict):
            continue
        stamp = finite_number(row.get("x"))
        nav = finite_number(row.get("y"))
        if stamp is None or nav is None or nav <= 0:
            continue
        try:
            day = datetime.fromtimestamp(stamp / 1000, ZoneInfo("Asia/Shanghai")).date().isoformat()
        except (ValueError, OverflowError, OSError):
            continue
        change = finite_number(row.get("equityReturn"))
        # Older trend records sometimes use 0 as a placeholder, not a return.
        if change == 0 and (previous_nav is None or abs(nav - previous_nav) > 0.0001):
            change = None
        points.append({"FSRQ": day, "DWJZ": nav, "JZZZL": change, "LJJZ": accumulated_by_time.get(row["x"])})
        previous_nav = nav
    return points


def disclosure_allocations(text: str) -> list[tuple[str, float]]:
    allocation = assignment(text, "Data_assetAllocation")
    if not isinstance(allocation, dict):
        return []
    categories = allocation.get("categories", [])
    for series in allocation.get("series", []):
        if not isinstance(series, dict) or series.get("name") != "股票占净比":
            continue
        result = []
        for day, raw in zip(categories, series.get("data", [])):
            value = finite_number(raw)
            if isinstance(day, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", day) and value is not None and 0 <= value <= 100:
                result.append((day, value / 100))
        return result
    return []
