"""Keep displayed raw prices separate from corporate-action-aware returns."""
from __future__ import annotations

import sqlite3

from .performance import adjusted_market_rows


def history_basis(symbol: str, basis: str | None) -> str:
    # Old HK data may have come from Tencent qfqday; it must be refetched.
    return basis or ("unknown" if symbol.startswith("hk") else "raw")


def holding_price_return(
    conn: sqlite3.Connection, symbol: str, base_day: str, target_day: str,
    base_price: float, target_price: float,
) -> float | None:
    if target_day < base_day:
        return None
    rows = conn.execute("""
        SELECT h.date, h.close, b.basis FROM stock_daily_history h
        LEFT JOIN stock_price_basis b ON b.sina_symbol=h.sina_symbol AND b.date=h.date
        WHERE h.sina_symbol=? AND h.date>? AND h.date<? ORDER BY h.date
    """, (symbol, base_day, target_day)).fetchall()
    if any(history_basis(symbol, basis) != "raw" for _, _, basis in rows):
        return None
    factors = [dict(zip(("date", "factor", "shares", "cash"), row)) for row in conn.execute(
        "SELECT date,factor,shares,cash FROM market_adjustment_factors WHERE symbol=? AND date<=? ORDER BY date",
        (symbol, target_day),
    )]
    points = [{"date": base_day, "close": base_price}]
    points.extend({"date": day, "close": close} for day, close, _ in rows)
    points.append({"date": target_day, "close": target_price})
    adjusted = adjusted_market_rows(points, factors)
    if adjusted[-1]["returnSegment"] != adjusted[0]["returnSegment"]:
        return None
    return adjusted[-1]["close"] / adjusted[0]["close"] - 1
