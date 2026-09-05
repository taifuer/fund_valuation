"""Historical performance math, separate from fetching and Flask responses."""
from __future__ import annotations

import json
import math
from datetime import date
from typing import Any


def finite_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (ValueError, TypeError):
        return None
    return number if math.isfinite(number) else None


def fund_performance_rows(rows: list[tuple[Any, ...]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    growth = 1.0
    segment = 0
    previous: tuple[float, float | None] | None = None
    adjusted = False
    for day, raw_nav, change, accumulated in rows:
        nav = float(raw_nav)
        if not math.isfinite(nav) or nav <= 0:
            continue
        official_change = finite_number(change)
        accumulated_nav = finite_number(accumulated)
        if previous:
            previous_nav, previous_accumulated = previous
            gross = nav / previous_nav
            cash = None
            if accumulated_nav is not None and previous_accumulated is not None:
                cash = (accumulated_nav - nav) - (previous_accumulated - previous_nav)
            if official_change is not None and official_change > -100:
                official_gross = 1 + official_change / 100
                # Prefer precise NAV ratios on ordinary days, but preserve the
                # provider's distribution-adjusted change on corporate actions.
                tolerance = max(0.00025, 0.00011 / previous_nav)
                if abs(official_gross - gross) > tolerance:
                    gross = official_gross
                    adjusted = True
                elif cash is not None and cash > 0.00001:
                    gross = (nav + cash) / previous_nav
                    adjusted = True
            elif cash is not None and cash > 0.00001:
                gross = (nav + cash) / previous_nav
                adjusted = True
            elif not 0.65 <= gross <= 1 / 0.65:
                # A price discontinuity is not proof of a split or a loss.
                segment += 1
                growth = 1.0
                gross = 1.0
            growth *= gross
        result.append({
            "date": str(day), "nav": nav, "changePercent": official_change,
            "accumulatedNav": accumulated_nav, "returnValue": growth,
            "returnSegment": segment, "adjusted": adjusted,
        })
        previous = (nav, accumulated_nav)
    return result


def parse_sina_adjustments(text: str) -> list[dict[str, Any]]:
    """Parse Sina's JSON assignment without evaluating upstream JavaScript."""
    start = text.find("=")
    if start < 0:
        return []
    try:
        payload, _ = json.JSONDecoder().raw_decode(text[start + 1:].lstrip())
    except (ValueError, TypeError):
        return []
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list) or not data:
        return []
    result = []
    for point in data:
        if not isinstance(point, dict):
            return []
        day = str(point.get("d") or "")
        factor = finite_number(point.get("f"))
        shares = finite_number(point.get("s", 1))
        cash = finite_number(point.get("u", 0))
        try:
            valid_day = len(day) == 10 and date.fromisoformat(day).isoformat() == day
        except ValueError:
            valid_day = False
        if not valid_day or factor is None or factor <= 0 or shares is None or shares <= 0 or cash is None or cash < 0:
            return []
        result.append({"date": day, "factor": factor, "shares": shares, "cash": cash})
    if len({row['date'] for row in result}) != len(result):
        return []
    return sorted(result, key=lambda row: row["date"])


def adjusted_market_rows(
    rows: list[dict[str, Any]], factors: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Chain daily total returns using verified backward-adjustment events."""
    result: list[dict[str, Any]] = []
    factors = sorted(factors or [], key=lambda row: row["date"])
    factor_index = -1
    previous_factor: dict[str, Any] | None = None
    previous_close: float | None = None
    growth = 1.0
    segment = 0
    for row in rows:
        day, close = str(row["date"]), float(row["close"])
        while factor_index + 1 < len(factors) and factors[factor_index + 1]["date"] <= day:
            factor_index += 1
        current = factors[factor_index] if factor_index >= 0 else None
        if previous_close is not None:
            gross = close / previous_close
            if current is not None and previous_factor is not None:
                share_ratio = current["shares"] / previous_factor["shares"]
                dividend = (current["cash"] - previous_factor["cash"]) / previous_factor["shares"]
                gross = (close * share_ratio + dividend) / previous_close
                gross *= current["factor"] / previous_factor["factor"]
            if not math.isfinite(gross) or not 0.65 <= gross <= 1 / 0.65:
                segment += 1
                growth = 1.0
                gross = 1.0
            growth *= gross
        else:
            growth = close
        point = {"date": day, "close": growth, "rawClose": close, "returnSegment": segment}
        if current is not None:
            point["adjusted"] = True
            point["adjustmentSource"] = "sina-hfq"
        if segment:
            point["quality"] = "unverifiedCorporateAction"
        result.append(point)
        previous_close, previous_factor = close, current
    return result


def history_risk_metrics(points: list[tuple[str, float]], start_date: str, end_date: str) -> dict[str, float | None]:
    values = [value for day, value in points if start_date <= day <= end_date and value > 0]
    if len(values) < 2:
        return {"maxDrawdownPercent": None, "winRatePercent": None}
    peak, drawdown = values[0], 0.0
    for value in values:
        peak = max(peak, value)
        drawdown = min(drawdown, (value / peak - 1) * 100)
    wins = sum(current > previous for previous, current in zip(values, values[1:]))
    return {"maxDrawdownPercent": round(drawdown, 2), "winRatePercent": round(wins / (len(values) - 1) * 100, 2)}
