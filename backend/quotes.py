from __future__ import annotations

import re
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo


LINE_RE = re.compile(r'^var\s+hq_str_(\w+)="([^"]*)"')
DATE_RE = re.compile(r"^\d{4}[-/]\d{2}[-/]\d{2}$")
TIME_RE = re.compile(r"^\d{1,2}:\d{2}(?::\d{2})?$")


def number(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result


def beijing_datetime(captured_at: int) -> str:
    return datetime.fromtimestamp(captured_at / 1000, ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d %H:%M:%S")


def stale_date(value: str, captured_at: int, max_days: int = 2) -> bool:
    try:
        quote_date = datetime.fromisoformat(value[:10]).date()
        current_date = datetime.fromtimestamp(captured_at / 1000, ZoneInfo("Asia/Shanghai")).date()
    except (ValueError, OSError):
        return True
    return abs((quote_date - current_date).days) > max_days


def max_reasonable_change(symbol: str) -> float:
    if symbol.startswith("hf_") or symbol.startswith(("s_", "int_", "b_", "hk")):
        return 25
    if re.match(r"^(sh000|sz399)\d{3}$", symbol):
        return 25
    if re.match(r"^(sh|sz)\d{6}$", symbol):
        return 80
    return 120


def combine_date_time(date: str, time_text: str) -> str:
    normalized_date = date.replace("/", "-")
    if DATE_RE.fullmatch(normalized_date) and TIME_RE.fullmatch(time_text):
        return f"{normalized_date} {time_text if time_text.count(':') == 2 else time_text + ':00'}"
    return normalized_date


def dated_field(fields: list[str]) -> tuple[str, str]:
    for index in range(len(fields) - 1, -1, -1):
        if DATE_RE.fullmatch(fields[index]):
            candidate = fields[index + 1] if index + 1 < len(fields) and TIME_RE.fullmatch(fields[index + 1]) else ""
            return fields[index], candidate
    return "", ""


def korea_time_to_beijing(date: str, time_text: str) -> str:
    try:
        local = datetime.fromisoformat(f"{date}T{time_text}").replace(tzinfo=ZoneInfo("Asia/Seoul"))
        return local.astimezone(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d %H:%M:%S")
    except ValueError:
        return combine_date_time(date, time_text)


def us_extended_datetime(raw: str, fallback_year: str) -> tuple[str, str | None]:
    match = re.match(r"^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})(AM|PM)\s+(EDT|EST)$", raw)
    if not match or not fallback_year:
        return "", None
    months = {name: index for index, name in enumerate(("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"), start=1)}
    month = months.get(match.group(1))
    if month is None:
        return "", None
    hour = int(match.group(3)) % 12 + (12 if match.group(5) == "PM" else 0)
    offset = "-04:00" if match.group(6) == "EDT" else "-05:00"
    local = datetime.fromisoformat(f"{fallback_year}-{month:02d}-{int(match.group(2)):02d}T{hour:02d}:{match.group(4)}:00{offset}")
    session = "pre" if hour * 60 + int(match.group(4)) < 570 else "post" if hour >= 16 else None
    return local.astimezone(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d %H:%M:%S"), session


def normalize_quote_line(symbol: str, line: str, captured_at: int) -> dict[str, Any] | None:
    match = LINE_RE.match(line.strip())
    if not match:
        return None
    fields = match.group(2).split(",")
    price: float | None = None
    previous_close: float | None = None
    change_percent: float | None = None
    quote_time = ""
    session: str | None = None
    regular_price: float | None = None
    regular_change: float | None = None
    regular_time = ""

    if symbol.startswith("gb_") and len(fields) >= 27:
        price, change_percent, previous_close = number(fields[1]), number(fields[2]), number(fields[26])
        quote_time = fields[3]
        session = "regular"
        regular_price, regular_change, regular_time = price, change_percent, quote_time
        if len(fields) > 29:
            extended_price = number(fields[21])
            extended_change = number(fields[22])
            extended_time, extended_session = us_extended_datetime(fields[24], fields[29] or quote_time[:4])
            if extended_price and extended_session and extended_time:
                price = extended_price
                quote_time = extended_time
                session = extended_session
                if extended_session == "pre":
                    previous_close = regular_price
                    change_percent = extended_change
                elif previous_close:
                    change_percent = (extended_price - previous_close) / previous_close * 100
    elif symbol.startswith("s_") and len(fields) >= 4:
        price = number(fields[1])
        change = number(fields[2])
        change_percent = number(fields[3])
        previous_close = price - change if price is not None and change is not None else None
        date, time_text = dated_field(fields)
        quote_time = combine_date_time(date, time_text)
    elif re.match(r"^(sh|sz)\d{6}$", symbol) and len(fields) >= 10:
        previous_close, price = number(fields[2]), number(fields[3])
        date, time_text = dated_field(fields)
        quote_time = combine_date_time(date, time_text)
    elif symbol.startswith("hk") and len(fields) >= 19:
        previous_close, price, change_percent = number(fields[3]), number(fields[6]), number(fields[8])
        quote_time = combine_date_time(fields[17], fields[18])
    elif symbol.startswith("hf_") and len(fields) >= 13:
        price = number(fields[0])
        previous_close = number(fields[7]) or number(fields[8])
        quote_time = combine_date_time(fields[12], fields[6])
    elif (symbol.startswith("int_") or symbol.startswith("b_")) and len(fields) >= 4:
        price = number(fields[1])
        change = number(fields[2])
        change_percent = number(fields[3])
        previous_close = price - change if price is not None and change is not None else None
        date, time_text = dated_field(fields)
        quote_time = korea_time_to_beijing(date, time_text) if symbol == "b_KOSPI" and time_text else combine_date_time(date, time_text)
    elif symbol == "fx_sbtcusd" and len(fields) >= 12:
        price = number(fields[1])
        change = number(fields[11])
        change_percent = number(fields[10])
        previous_close = price - change if price is not None and change is not None else None
        date, _ = dated_field(fields)
        quote_time = combine_date_time(date, fields[0])

    if price is None or price <= 0 or previous_close is None or previous_close <= 0:
        return None
    if change_percent is None:
        change_percent = (price - previous_close) / previous_close * 100
    if abs(change_percent) > max_reasonable_change(symbol):
        return None

    date_reliable = bool(quote_time)
    if not quote_time:
        if symbol == "int_nikkei":
            return None
        quote_time = beijing_datetime(captured_at)
        date_reliable = False
    elif stale_date(quote_time, captured_at):
        date_reliable = False
        if symbol == "int_nikkei":
            return None
        if not (symbol.startswith("int_") or symbol.startswith("b_")):
            quote_time = beijing_datetime(captured_at)
    return {
        "symbol": symbol,
        "price": round(price, 4),
        "previousClose": round(previous_close, 4),
        "change": round(price - previous_close, 4),
        "changePercent": round(change_percent, 4),
        "time": quote_time,
        "dateReliable": date_reliable,
        "fetchedAt": captured_at,
        **({"session": session} if session else {}),
        **({"regularPrice": regular_price} if regular_price is not None else {}),
        **({"regularChangePercent": regular_change} if regular_change is not None else {}),
        **({"regularTime": regular_time} if regular_time else {}),
    }


def normalize_quote_text(text: str, captured_at: int) -> dict[str, dict[str, Any]]:
    records: dict[str, dict[str, Any]] = {}
    for line in text.splitlines():
        match = LINE_RE.match(line.strip())
        if not match:
            continue
        symbol = match.group(1)
        record = normalize_quote_line(symbol, line, captured_at)
        if record:
            records[symbol] = record
    return records
