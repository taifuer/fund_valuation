from __future__ import annotations

import csv
import io
from collections import defaultdict
from typing import Any

from .storage import get_conn


ECB_CURRENCIES = ("USD", "EUR", "JPY", "KRW", "HKD")


def parse_ecb_reference_rates(text: str) -> list[tuple[str, str, float]]:
    by_date: dict[str, dict[str, float]] = defaultdict(dict)
    for row in csv.DictReader(io.StringIO(text)):
        currency = str(row.get("CURRENCY") or "").upper()
        date = str(row.get("TIME_PERIOD") or "")
        try:
            value = float(row.get("OBS_VALUE") or 0)
        except (TypeError, ValueError):
            continue
        if currency and date and value > 0:
            by_date[date][currency] = value

    points: list[tuple[str, str, float]] = []
    for date, values in sorted(by_date.items()):
        cny_per_eur = values.get("CNY")
        if not cny_per_eur:
            continue
        points.append(("EUR", date, cny_per_eur))
        for currency in ECB_CURRENCIES:
            if currency == "EUR":
                continue
            currency_per_eur = values.get(currency)
            if currency_per_eur:
                points.append((currency, date, cny_per_eur / currency_per_eur))
    return points


def store_ecb_reference_rates(text: str, fetched_at: int) -> int:
    parsed = parse_ecb_reference_rates(text)
    if not parsed:
        return 0
    grouped: dict[str, list[tuple[str, float]]] = defaultdict(list)
    for currency, date, rate in parsed:
        grouped[currency].append((date, rate))

    rows: list[tuple[str, str, float, float, int]] = []
    with get_conn() as conn:
        for currency, points in grouped.items():
            points.sort()
            previous_row = conn.execute(
                "SELECT rate FROM fx_daily_history WHERE currency = ? AND date < ? ORDER BY date DESC LIMIT 1",
                (currency, points[0][0]),
            ).fetchone()
            previous_rate = float(previous_row[0]) if previous_row else None
            for date, rate in points:
                change_percent = ((rate - previous_rate) / previous_rate * 100) if previous_rate else 0.0
                rows.append((currency, date, rate, change_percent, fetched_at))
                previous_rate = rate
        conn.executemany(
            """
            INSERT INTO fx_daily_history(currency, date, rate, change_percent, fetched_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(currency, date) DO UPDATE SET
              rate = excluded.rate,
              change_percent = excluded.change_percent,
              fetched_at = excluded.fetched_at
            """,
            rows,
        )
    return len(rows)


def latest_fx_history_date() -> str | None:
    with get_conn() as conn:
        row = conn.execute("SELECT MAX(date) FROM fx_daily_history").fetchone()
    return str(row[0]) if row and row[0] else None


def fx_history_summary() -> dict[str, Any]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT currency, MIN(date), MAX(date), COUNT(*) FROM fx_daily_history GROUP BY currency ORDER BY currency"
        ).fetchall()
    return {
        str(currency): {"startDate": str(start), "endDate": str(end), "count": int(count)}
        for currency, start, end, count in rows
    }
