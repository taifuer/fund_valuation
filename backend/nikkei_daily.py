"""Nikkei's official cash-index daily CSV, separate from the NK futures archive."""
from __future__ import annotations

import csv
import io
import math
from datetime import date

DAILY_URL = "https://indexes.nikkei.co.jp/nkave/historical/nikkei_stock_average_daily_jp.csv"
HEADER = ["\u30c7\u30fc\u30bf\u65e5\u4ed8", "\u7d42\u5024", "\u59cb\u5024", "\u9ad8\u5024", "\u5b89\u5024"]


def parse_daily(text: str, cutoff: str) -> list[dict]:
    date.fromisoformat(cutoff)
    reader = csv.reader(io.StringIO(text.lstrip('\ufeff')))
    if next(reader, None) != HEADER:
        raise ValueError("Unexpected Nikkei daily CSV header")
    points = {}
    for row in reader:
        # The official file ends with a single-field copyright notice.
        if len(row) == 1 and row[0].startswith('\u672c\u8cc7\u6599'):
            continue
        if not row:
            continue
        if len(row) != 5:
            raise ValueError("Invalid Nikkei daily row")
        day = date.fromisoformat(row[0].replace('/', '-')).isoformat()
        close = float(row[1].replace(',', ''))
        if not math.isfinite(close) or close <= 0 or day in points:
            raise ValueError("Invalid or duplicate Nikkei daily close")
        points[day] = close
    result = [{'date': day, 'close': close} for day, close in sorted(points.items()) if day <= cutoff]
    if not result:
        raise ValueError("No completed Nikkei cash sessions")
    return result
