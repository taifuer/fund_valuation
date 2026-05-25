from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import sqlite3
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

from flask import Flask, Response, jsonify, request
from werkzeug.exceptions import HTTPException


ROOT_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.environ.get("FUND_VALUATION_DATA_DIR", ROOT_DIR / "data"))
DB_PATH = DATA_DIR / "fund_valuation.db"
RAW_DIR = DATA_DIR / "raw"

DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
}

app = Flask(__name__)
_UPSTREAM_LOCKS: dict[str, threading.Lock] = {}
_UPSTREAM_LOCKS_GUARD = threading.Lock()


def now_ms() -> int:
    return int(time.time() * 1000)


def ensure_storage() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS response_cache (
              cache_key TEXT PRIMARY KEY,
              url TEXT NOT NULL,
              status INTEGER NOT NULL,
              content_type TEXT NOT NULL,
              body BLOB NOT NULL,
              fetched_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS fund_nav_history (
              code TEXT NOT NULL,
              date TEXT NOT NULL,
              nav REAL NOT NULL,
              change_percent REAL NOT NULL,
              fetched_at INTEGER NOT NULL,
              PRIMARY KEY (code, date)
            );

            CREATE TABLE IF NOT EXISTS fund_purchase_status (
              code TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              fund_type TEXT NOT NULL,
              nav_date TEXT NOT NULL,
              purchase_status TEXT NOT NULL,
              redeem_status TEXT NOT NULL,
              next_open_date TEXT NOT NULL,
              min_purchase TEXT NOT NULL,
              daily_limit TEXT NOT NULL,
              fee_rate TEXT NOT NULL,
              fetched_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS fund_holdings (
              code TEXT NOT NULL,
              report_date TEXT NOT NULL,
              rank INTEGER NOT NULL,
              stock_code TEXT NOT NULL,
              stock_name TEXT NOT NULL,
              weight REAL NOT NULL,
              market TEXT NOT NULL,
              sina_symbol TEXT NOT NULL,
              currency TEXT NOT NULL,
              fetched_at INTEGER NOT NULL,
              PRIMARY KEY (code, report_date, rank)
            );

            CREATE TABLE IF NOT EXISTS market_history (
              source TEXT NOT NULL,
              symbol TEXT NOT NULL,
              date TEXT NOT NULL,
              close REAL NOT NULL,
              fetched_at INTEGER NOT NULL,
              PRIMARY KEY (source, symbol, date)
            );

            CREATE TABLE IF NOT EXISTS market_calendar (
              market TEXT NOT NULL,
              date TEXT NOT NULL,
              status TEXT NOT NULL,
              sessions TEXT NOT NULL,
              timezone TEXT NOT NULL,
              source TEXT NOT NULL,
              fetched_at INTEGER NOT NULL,
              PRIMARY KEY (market, date)
            );

            """
        )
    ensure_market_calendar_seeded()


HOLIDAYS_2026 = {
    "cn": {
        "2026-01-01", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20",
        "2026-04-06", "2026-05-01", "2026-05-04", "2026-05-05", "2026-06-19",
        "2026-09-25", "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07",
    },
    "hk": {
        "2026-01-01", "2026-02-17", "2026-02-18", "2026-02-19", "2026-04-03", "2026-04-06",
        "2026-04-07", "2026-05-01", "2026-05-25", "2026-07-01", "2026-09-26",
        "2026-10-01", "2026-10-19", "2026-12-25",
    },
    "us": {
        "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19",
        "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
    },
    "jp": {
        "2026-01-01", "2026-01-02", "2026-01-12", "2026-02-11", "2026-02-23", "2026-03-20",
        "2026-04-29", "2026-05-04", "2026-05-05", "2026-05-06", "2026-07-20", "2026-08-11",
        "2026-09-21", "2026-09-22", "2026-09-23", "2026-10-12", "2026-11-03", "2026-11-23",
        "2026-12-31",
    },
    "kr": {
        "2026-01-01", "2026-02-16", "2026-02-17", "2026-02-18", "2026-03-02", "2026-05-01",
        "2026-05-05", "2026-05-25", "2026-08-17", "2026-09-24", "2026-09-25", "2026-09-26",
        "2026-10-05", "2026-10-09", "2026-12-25", "2026-12-31",
    },
    "tw": {
        "2026-01-01", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20",
        "2026-02-27", "2026-04-03", "2026-04-06", "2026-05-01", "2026-06-19",
        "2026-09-25", "2026-10-09",
    },
}

MARKET_CALENDARS: dict[str, dict[str, Any]] = {
    "cn": {
        "timezone": "Asia/Shanghai",
        "sessions": [("09:30", "11:30"), ("13:00", "15:00")],
        "holidays": HOLIDAYS_2026["cn"],
        "source": "SSE/SZSE holiday calendar",
    },
    "hk": {
        "timezone": "Asia/Hong_Kong",
        "sessions": [("09:30", "12:00"), ("13:00", "16:10")],
        "holidays": HOLIDAYS_2026["hk"],
        "half_days": {
            "2026-12-24": [("09:30", "12:10")],
            "2026-12-31": [("09:30", "12:10")],
        },
        "source": "HKEX calendar",
    },
    "us": {
        "timezone": "America/New_York",
        "sessions": [("09:30", "16:00")],
        "holidays": HOLIDAYS_2026["us"],
        "half_days": {
            "2026-11-27": [("09:30", "13:00")],
            "2026-12-24": [("09:30", "13:00")],
        },
        "source": "NYSE/Nasdaq holiday calendar",
    },
    "jp": {
        "timezone": "Asia/Tokyo",
        "sessions": [("09:00", "11:30"), ("12:30", "15:30")],
        "holidays": HOLIDAYS_2026["jp"],
        "source": "JPX market holidays",
    },
    "kr": {
        "timezone": "Asia/Seoul",
        "sessions": [("09:00", "15:30")],
        "holidays": HOLIDAYS_2026["kr"],
        "source": "KRX trading days and holidays",
    },
    "tw": {
        "timezone": "Asia/Taipei",
        "sessions": [("09:00", "13:30")],
        "holidays": HOLIDAYS_2026["tw"],
        "source": "TWSE/TAIFEX trading calendar",
    },
    "hk_futures": {
        "timezone": "Asia/Hong_Kong",
        "sessions": [("09:15", "12:00"), ("13:00", "16:30"), ("17:15", "03:00")],
        "holidays": HOLIDAYS_2026["hk"],
        "source": "HKEX derivatives calendar",
    },
    "jp_futures": {
        "timezone": "Asia/Tokyo",
        "sessions": [("07:30", "14:25"), ("14:55", "05:15")],
        "holidays": HOLIDAYS_2026["jp"],
        "source": "JPX/OSE derivatives calendar",
    },
}


def is_weekend(dt: datetime) -> bool:
    return dt.weekday() >= 5


def ensure_market_calendar_seeded(year: int = 2026) -> None:
    start = datetime(year, 1, 1)
    end = datetime(year, 12, 31)
    fetched_at = now_ms()
    rows: list[tuple[str, str, str, str, str, str, int]] = []
    with sqlite3.connect(DB_PATH) as conn:
        existing = conn.execute(
            "SELECT COUNT(*) FROM market_calendar WHERE date BETWEEN ? AND ?",
            (f"{year}-01-01", f"{year}-12-31"),
        ).fetchone()[0]
        if int(existing) >= len(MARKET_CALENDARS) * 360:
            return

        for market, calendar in MARKET_CALENDARS.items():
            current = start
            while current <= end:
                day = current.strftime("%Y-%m-%d")
                sessions = calendar.get("half_days", {}).get(day) or calendar["sessions"]
                if is_weekend(current):
                    status = "weekend"
                elif day in calendar["holidays"]:
                    status = "holiday"
                elif calendar.get("half_days", {}).get(day):
                    status = "half_day"
                else:
                    status = "open"
                rows.append((
                    market,
                    day,
                    status,
                    json.dumps(sessions, ensure_ascii=False),
                    str(calendar["timezone"]),
                    str(calendar["source"]),
                    fetched_at,
                ))
                current += timedelta(days=1)

        conn.executemany(
            """
            INSERT INTO market_calendar(market, date, status, sessions, timezone, source, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(market, date) DO UPDATE SET
              status = excluded.status,
              sessions = excluded.sessions,
              timezone = excluded.timezone,
              source = excluded.source,
              fetched_at = excluded.fetched_at
            """,
            rows,
        )


def market_calendar_row(market: str, day: str) -> dict[str, Any] | None:
    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute(
            """
            SELECT market, date, status, sessions, timezone, source, fetched_at
            FROM market_calendar
            WHERE market = ? AND date = ?
            """,
            (market, day),
        ).fetchone()
    if not row:
        return None
    sessions = json.loads(str(row[3]))
    return {
        "market": str(row[0]),
        "date": str(row[1]),
        "status": str(row[2]),
        "sessions": sessions if isinstance(sessions, list) else [],
        "timezone": str(row[4]),
        "source": str(row[5]),
        "fetchedAt": int(row[6]),
    }


def parse_hhmm(value: str) -> int:
    hour, minute = value.split(":", 1)
    return int(hour) * 60 + int(minute)


def in_sessions(sessions: list[list[str]] | list[tuple[str, str]], minutes: int) -> bool:
    for start_raw, end_raw in sessions:
        start = parse_hhmm(str(start_raw))
        end = parse_hhmm(str(end_raw))
        if start <= minutes < end:
            return True
    return False


def in_futures_sessions(market: str, local: datetime) -> bool:
    row = market_calendar_row(market, local.strftime("%Y-%m-%d"))
    if not row:
        return False
    minutes = local.hour * 60 + local.minute
    for start_raw, end_raw in row["sessions"]:
        start = parse_hhmm(str(start_raw))
        end = parse_hhmm(str(end_raw))
        if start < end:
            if row["status"] == "open" and start <= minutes < end:
                return True
            continue
        if minutes >= start and row["status"] == "open":
            return True
        if minutes < end:
            prev_day = (local - timedelta(days=1)).strftime("%Y-%m-%d")
            prev_row = market_calendar_row(market, prev_day)
            if prev_row and prev_row["status"] == "open":
                return True
    return False


def market_key_for_symbol(symbol: str) -> str | None:
    if symbol in {"hf_NQ", "hf_ES", "hf_YM", "hf_GC", "hf_SI", "hf_CL"}:
        return "us_futures"
    if symbol == "hf_HSI":
        return "hk_futures"
    if symbol == "hf_NK":
        return "jp_futures"
    if symbol.startswith("gb_"):
        return "us"
    if symbol.startswith("hk"):
        return "hk"
    if symbol.startswith("s_") or re.match(r"^(sz|sh)\d", symbol):
        return "cn"
    if symbol == "int_nikkei":
        return "jp"
    if symbol == "b_KOSPI":
        return "kr"
    if symbol == "b_TWSE":
        return "tw"
    if symbol == "fx_sbtcusd":
        return "crypto"
    return None


def parse_market_now(raw: str | None) -> datetime:
    if not raw:
        return datetime.now(ZoneInfo("Asia/Shanghai"))
    normalized = raw.strip()
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=ZoneInfo("Asia/Shanghai"))
    return parsed


def us_futures_state(now: datetime) -> str:
    local = now.astimezone(ZoneInfo("America/New_York"))
    minutes = local.hour * 60 + local.minute
    maintenance_start = 17 * 60
    maintenance_end = 18 * 60
    if local.weekday() == 5:
        return "weekend"
    if local.weekday() == 6:
        return "live" if minutes >= maintenance_end else "closed"
    if local.weekday() == 4:
        return "live" if minutes < maintenance_start else "closed"
    if maintenance_start <= minutes < maintenance_end:
        return "closed"
    return "live"


def market_state_for_symbol(symbol: str, now: datetime) -> dict[str, Any]:
    market = market_key_for_symbol(symbol)
    if not market:
        return {"symbol": symbol, "market": "", "state": "closed", "source": "unknown"}
    if market == "crypto":
        return {"symbol": symbol, "market": market, "state": "live", "source": "continuous crypto market"}
    if market == "us_futures":
        return {"symbol": symbol, "market": market, "state": us_futures_state(now), "source": "CME Globex session rule"}

    calendar = MARKET_CALENDARS[market]
    local = now.astimezone(ZoneInfo(str(calendar["timezone"])))
    day = local.strftime("%Y-%m-%d")

    if market in {"hk_futures", "jp_futures"}:
        if in_futures_sessions(market, local):
            state = "live"
        else:
            row = market_calendar_row(market, day)
            state = str(row["status"]) if row and row["status"] in {"holiday", "weekend"} else "closed"
        row = market_calendar_row(market, day)
        return {
            "symbol": symbol,
            "market": market,
            "date": day,
            "state": state,
            "source": row["source"] if row else str(calendar["source"]),
        }

    row = market_calendar_row(market, day)
    if not row:
        return {"symbol": symbol, "market": market, "date": day, "state": "closed", "source": str(calendar["source"])}
    if row["status"] in {"holiday", "weekend"}:
        state = row["status"]
    else:
        minutes = local.hour * 60 + local.minute
        state = "live" if in_sessions(row["sessions"], minutes) else "closed"
    return {
        "symbol": symbol,
        "market": market,
        "date": day,
        "state": state,
        "source": row["source"],
    }


def cache_get(cache_key: str, max_age_seconds: int) -> tuple[int, str, bytes] | None:
    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute(
            "SELECT status, content_type, body, fetched_at FROM response_cache WHERE cache_key = ?",
            (cache_key,),
        ).fetchone()
    if not row:
        return None
    status, content_type, body, fetched_at = row
    if max_age_seconds > 0 and now_ms() - int(fetched_at) > max_age_seconds * 1000:
        return None
    return int(status), str(content_type), bytes(body)


def cache_put(cache_key: str, url: str, status: int, content_type: str, body: bytes) -> None:
    fetched_at = now_ms()
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            INSERT INTO response_cache(cache_key, url, status, content_type, body, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(cache_key) DO UPDATE SET
              url = excluded.url,
              status = excluded.status,
              content_type = excluded.content_type,
              body = excluded.body,
              fetched_at = excluded.fetched_at
            """,
            (cache_key, url, status, content_type, body, fetched_at),
        )


def cache_any(cache_key: str) -> tuple[int, str, bytes] | None:
    return cache_get(cache_key, 0)


def upstream_lock(cache_key: str) -> threading.Lock:
    with _UPSTREAM_LOCKS_GUARD:
        lock = _UPSTREAM_LOCKS.get(cache_key)
        if lock is None:
            lock = threading.Lock()
            _UPSTREAM_LOCKS[cache_key] = lock
        return lock


def write_raw(kind: str, cache_key: str, body: bytes) -> None:
    day = datetime.now().strftime("%Y%m%d")
    digest = hashlib.sha1(cache_key.encode("utf-8")).hexdigest()[:16]
    folder = RAW_DIR / day
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{kind}-{digest}.txt").write_bytes(body)


def fetch_upstream(
    url: str,
    *,
    referer: str,
    content_type: str,
    cache_key: str,
    kind: str,
    ttl_seconds: int,
    force_refresh: bool = False,
) -> tuple[int, str, bytes]:
    if not force_refresh:
        cached = cache_get(cache_key, ttl_seconds)
        if cached:
            return cached

    lock = upstream_lock(cache_key)
    with lock:
        if not force_refresh:
            cached = cache_get(cache_key, ttl_seconds)
            if cached:
                return cached

        headers = {**DEFAULT_HEADERS, "Referer": referer}
        req = Request(url, headers=headers)
        try:
            with urlopen(req, timeout=12) as response:
                body = response.read()
                status = int(response.status)
                upstream_content_type = response.headers.get("Content-Type") or content_type
            resolved_content_type = content_type or upstream_content_type
            cache_put(cache_key, url, status, resolved_content_type, body)
            write_raw(kind, cache_key, body)
            return status, resolved_content_type, body
        except URLError:
            stale = cache_any(cache_key)
            if stale:
                return stale
            raise


def decode_body(body: bytes) -> str:
    for encoding in ("utf-8", "gb18030"):
        try:
            return body.decode(encoding)
        except UnicodeDecodeError:
            continue
    return body.decode("utf-8", errors="replace")


def parse_jsonp_call(text: str, name: str) -> Any | None:
    match = re.search(rf"{re.escape(name)}\((.+)\)\s*;?\s*$", text, re.S)
    if not match:
        return None
    try:
        return json.loads(match.group(1))
    except json.JSONDecodeError:
        return None


def parse_sina_array_jsonp(text: str) -> list[dict[str, Any]]:
    match = re.search(r"=\((.*)\);?\s*$", text, re.S)
    if not match:
        return []
    try:
        parsed = json.loads(match.group(1))
        return parsed if isinstance(parsed, list) else []
    except json.JSONDecodeError:
        return []


def store_fund_history(code: str, rows: list[dict[str, Any]]) -> None:
    points = []
    fetched_at = now_ms()
    for row in rows:
        date = str(row.get("FSRQ") or "")
        try:
            nav = float(row.get("DWJZ") or 0)
            change_percent = float(row.get("JZZZL") or 0)
        except (TypeError, ValueError):
            continue
        if date and nav > 0:
            points.append((code, date, nav, change_percent, fetched_at))
    if not points:
        return
    with sqlite3.connect(DB_PATH) as conn:
        conn.executemany(
            """
            INSERT INTO fund_nav_history(code, date, nav, change_percent, fetched_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(code, date) DO UPDATE SET
              nav = excluded.nav,
              change_percent = excluded.change_percent,
              fetched_at = excluded.fetched_at
            """,
            points,
        )


def parse_fund_history_api(text: str) -> tuple[list[dict[str, Any]], int | None]:
    parsed = parse_jsonp_call(text, "jQuery")
    data = parsed.get("Data") if isinstance(parsed, dict) else None
    rows = data.get("LSJZList") if isinstance(data, dict) else None
    raw_total = data.get("TotalCount") if isinstance(data, dict) else None
    if raw_total is None and isinstance(parsed, dict):
        raw_total = parsed.get("TotalCount")
    try:
        total_count = int(raw_total) if raw_total is not None else None
    except (TypeError, ValueError):
        total_count = None
    return (rows if isinstance(rows, list) else []), total_count


def parse_fund_history_legacy(text: str) -> tuple[list[dict[str, Any]], int | None]:
    content_match = re.search(r'content:"(.*?)",records:(\d+)', text, re.S)
    if not content_match:
        return [], None

    content = js_string_unescape(content_match.group(1))
    try:
        total_count = int(content_match.group(2))
    except ValueError:
        total_count = None

    rows: list[dict[str, Any]] = []
    for row_html in re.findall(r"<tr>(.*?)</tr>", content, re.S):
        cells = [strip_tags(cell) for cell in re.findall(r"<td[^>]*>(.*?)</td>", row_html, re.S)]
        if len(cells) < 6 or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", cells[0]):
            continue
        rows.append(
            {
                "FSRQ": cells[0],
                "DWJZ": cells[1],
                "LJJZ": cells[2] if len(cells) > 2 else "",
                "JZZZL": cells[3].replace("%", ""),
                "SGZT": cells[4],
                "SHZT": cells[5],
                "FHFCZ": cells[6] if len(cells) > 6 else "",
            }
        )
    return rows, total_count


def normalize_cn_date(value: str) -> str:
    value = strip_tags(value)
    match = re.search(r"(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})", value)
    if not match:
        return value
    year, month, day = match.groups()
    return f"{year}-{int(month):02d}-{int(day):02d}"


def normalize_fee(value: str) -> str:
    value = strip_tags(value)
    if not value or value.startswith("---"):
        return "0.00%"
    match = re.search(r"[\d.]+%", value)
    return match.group(0) if match else value


def parse_fund_profile(text: str) -> dict[str, str] | None:
    table_match = re.search(r"<table[^>]*class=\"info w790\"[^>]*>(.*?)</table>", text, re.S)
    if not table_match:
        return None

    fields: dict[str, str] = {}
    rows = re.findall(r"<tr>(.*?)</tr>", table_match.group(1), re.S)
    for row in rows:
        cells = re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", row, re.S)
        for index in range(0, len(cells) - 1, 2):
            key = strip_tags(cells[index])
            value = strip_tags(cells[index + 1])
            if key:
                fields[key] = value

    inception_text = fields.get("成立日期/规模", "")
    asset_text = fields.get("净资产规模", "")
    scale_match = re.search(r"(.+?)（截止至：(.+?)）", asset_text)
    return {
        "inceptionDate": normalize_cn_date(inception_text),
        "assetScale": strip_tags(scale_match.group(1)) if scale_match else asset_text,
        "scaleDate": normalize_cn_date(scale_match.group(2)) if scale_match else "",
        "managementFee": normalize_fee(fields.get("管理费率", "")),
        "custodianFee": normalize_fee(fields.get("托管费率", "")),
        "salesServiceFee": normalize_fee(fields.get("销售服务费率", "")),
    }


def fetch_fund_history_page(code: str, page_index: int, page_size: int, *, refresh: bool) -> tuple[list[dict[str, Any]], int | None]:
    query = urlencode(
        {
            "callback": "jQuery",
            "fundCode": code,
            "pageIndex": page_index,
            "pageSize": page_size,
            "_": int(time.time() * 1000),
        }
    )
    url = f"https://api.fund.eastmoney.com/f10/lsjz?{query}"
    status, _, body = fetch_upstream(
        url,
        referer="https://fund.eastmoney.com/",
        content_type="text/plain; charset=utf-8",
        cache_key=f"fundhistory:{code}:{page_index}:{page_size}",
        kind="fundhistory",
        ttl_seconds=120,
        force_refresh=refresh,
    )
    if status < 400:
        rows, total_count = parse_fund_history_api(decode_body(body))
        if rows:
            return rows, total_count

    legacy_query = urlencode({"type": "lsjz", "code": code, "page": page_index, "per": page_size})
    legacy_url = f"https://fundf10.eastmoney.com/F10DataApi.aspx?{legacy_query}"
    status, _, body = fetch_upstream(
        legacy_url,
        referer=f"https://fundf10.eastmoney.com/jjjz_{quote(code)}.html",
        content_type="text/plain; charset=utf-8",
        cache_key=f"fundhistory-legacy:{code}:{page_index}:{page_size}",
        kind="fundhistory",
        ttl_seconds=120,
        force_refresh=refresh,
    )
    if status >= 400:
        return [], None
    return parse_fund_history_legacy(decode_body(body))


def fetch_and_store_fund_history(code: str, target_count: int, *, refresh: bool) -> None:
    fetched_rows = 0
    total_count: int | None = None
    # East Money may cap a page to 20 rows even when pageSize is larger.
    # Continue paging until SQLite has enough rows for the requested view.
    max_pages = min(max((target_count // 20) + 5, 1), 260)
    for page_index in range(1, max_pages + 1):
        rows, total_count = fetch_fund_history_page(code, page_index, target_count, refresh=refresh)
        if not rows:
            break
        store_fund_history(code, rows)
        fetched_rows += len(rows)
        if fetched_rows >= target_count:
            break
        if total_count is not None and fetched_rows >= total_count:
            break
        if total_count is None and len(rows) >= target_count:
            break


def count_fund_history_rows(code: str) -> int:
    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute("SELECT COUNT(*) FROM fund_nav_history WHERE code = ?", (code,)).fetchone()
    return int(row[0] if row else 0)


def strip_tags(value: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", value)).strip()


def js_string_unescape(value: str) -> str:
    return (
        value
        .replace(r"\/", "/")
        .replace(r"\"" , '"')
        .replace(r"\r", "")
        .replace(r"\n", "")
        .replace(r"\t", "")
    )


def classify_holding_symbol(stock_code: str, href: str, stock_name: str) -> tuple[str, str, str]:
    code = stock_code.strip().upper()
    href_match = re.search(r"/unify/r/(\d+)\.([A-Za-z0-9.]+)", href)
    if href_match:
        market_id, raw_symbol = href_match.groups()
        symbol = raw_symbol.upper()
        if market_id in {"105", "106"}:
            return "us", f"gb_{symbol.lower()}", "USD"
        if market_id == "116":
            return "hk", f"hk{symbol.zfill(5)}", "HKD"
        if market_id == "0":
            return "cn", f"sz{symbol.lower()}", "CNY"
        if market_id == "1":
            return "cn", f"sh{symbol.lower()}", "CNY"

    if re.fullmatch(r"\d{5}", code):
        return "hk", f"hk{code}", "HKD"
    if re.fullmatch(r"\d{6}", code) and (stock_name.startswith(("三星", "SK")) or code in {"005930", "000660"}):
        return "kr", f"kr{code}", "KRW"
    if re.fullmatch(r"(00|30)\d{4}", code):
        return "cn", f"sz{code}", "CNY"
    if re.fullmatch(r"(60|68)\d{4}", code):
        return "cn", f"sh{code}", "CNY"
    if code.endswith("JP"):
        return "jp", "", "JPY"
    if re.fullmatch(r"\d{4}", code):
        return "tw", "", "CNY"
    return "unknown", "", "CNY"


def parse_fund_holdings(code: str, text: str) -> list[dict[str, Any]]:
    content_match = re.search(r'content:"(.*?)",arryear:', text, re.S)
    if not content_match:
        return []

    content = js_string_unescape(content_match.group(1))
    report_match = re.search(r"截止至：\s*<font[^>]*>(\d{4}-\d{2}-\d{2})</font>", content)
    report_date = report_match.group(1) if report_match else ""
    tbody_match = re.search(r"<tbody>(.*?)</tbody>", content, re.S)
    if not tbody_match or not report_date:
        return []

    holdings: list[dict[str, Any]] = []
    for row_html in re.findall(r"<tr>(.*?)</tr>", tbody_match.group(1), re.S):
        cells = re.findall(r"<td[^>]*>(.*?)</td>", row_html, re.S)
        if len(cells) < 7:
            continue
        try:
            rank = int(strip_tags(cells[0]))
        except ValueError:
            continue
        href_match = re.search(r"href=['\"]([^'\"]+)['\"]", cells[1])
        href = href_match.group(1) if href_match else ""
        stock_code = strip_tags(cells[1]).upper()
        stock_name = strip_tags(cells[2])
        weight_text = strip_tags(cells[6]).replace("%", "").replace(",", "")
        try:
            weight = float(weight_text) / 100
        except ValueError:
            continue
        if not stock_code or not stock_name or weight <= 0:
            continue
        market, sina_symbol, currency = classify_holding_symbol(stock_code, href, stock_name)
        holdings.append({
            "code": code,
            "reportDate": report_date,
            "rank": rank,
            "stockCode": stock_code,
            "symbol": stock_code,
            "name": stock_name,
            "weight": weight,
            "market": market,
            "sinaSymbol": sina_symbol,
            "currency": currency,
        })
    return holdings


def store_fund_holdings(code: str, holdings: list[dict[str, Any]]) -> None:
    if not holdings:
        return
    report_date = str(holdings[0].get("reportDate") or "")
    if not report_date:
        return
    fetched_at = now_ms()
    points = []
    for item in holdings:
        try:
            rank = int(item.get("rank") or 0)
            weight = float(item.get("weight") or 0)
        except (TypeError, ValueError):
            continue
        if rank <= 0 or weight <= 0:
            continue
        points.append((
            code,
            report_date,
            rank,
            str(item.get("stockCode") or item.get("symbol") or ""),
            str(item.get("name") or ""),
            weight,
            str(item.get("market") or "unknown"),
            str(item.get("sinaSymbol") or ""),
            str(item.get("currency") or "CNY"),
            fetched_at,
        ))
    if not points:
        return
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("DELETE FROM fund_holdings WHERE code = ? AND report_date = ?", (code, report_date))
        conn.executemany(
            """
            INSERT INTO fund_holdings(
              code, report_date, rank, stock_code, stock_name, weight, market, sina_symbol, currency, fetched_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            points,
        )


def read_fund_holdings_from_db(code: str) -> list[dict[str, Any]]:
    with sqlite3.connect(DB_PATH) as conn:
        latest = conn.execute(
            "SELECT report_date FROM fund_holdings WHERE code = ? ORDER BY report_date DESC LIMIT 1",
            (code,),
        ).fetchone()
        if not latest:
            return []
        rows = conn.execute(
            """
            SELECT report_date, rank, stock_code, stock_name, weight, market, sina_symbol, currency, fetched_at
            FROM fund_holdings
            WHERE code = ? AND report_date = ?
            ORDER BY rank ASC
            """,
            (code, latest[0]),
        ).fetchall()
    return [
        {
            "code": code,
            "reportDate": str(report_date),
            "rank": int(rank),
            "stockCode": str(stock_code),
            "symbol": str(stock_code),
            "name": str(stock_name),
            "weight": float(weight),
            "market": str(market),
            "sinaSymbol": str(sina_symbol),
            "currency": str(currency),
            "fetchedAt": int(fetched_at),
        }
        for report_date, rank, stock_code, stock_name, weight, market, sina_symbol, currency, fetched_at in rows
    ]


def purchase_status_date(raw_date: str, show_days: list[Any]) -> str:
    if re.match(r"^\d{4}-\d{2}-\d{2}$", raw_date):
        return raw_date
    match = re.match(r"^(\d{2})-(\d{2})$", raw_date)
    if not match:
        return raw_date
    for day in show_days:
        day_text = str(day)
        if day_text.endswith(raw_date):
            return day_text
    year = datetime.now(ZoneInfo("Asia/Shanghai")).year
    return f"{year}-{match.group(1)}-{match.group(2)}"


def parse_purchase_status_text(text: str) -> tuple[list[list[Any]], list[Any]]:
    match = re.search(r"var\s+\w+\s*=\s*(\{.*\})\s*;?\s*$", text, re.S)
    if not match:
        return [], []
    object_text = re.sub(r"(\{|,)\s*([A-Za-z_]\w*)\s*:", r'\1"\2":', match.group(1))
    try:
        parsed = json.loads(object_text)
    except json.JSONDecodeError:
        return [], []
    datas = parsed.get("datas") if isinstance(parsed, dict) else None
    show_days = parsed.get("showday") if isinstance(parsed, dict) else None
    return (datas if isinstance(datas, list) else [], show_days if isinstance(show_days, list) else [])


def store_purchase_status(text: str) -> None:
    rows, show_days = parse_purchase_status_text(text)
    points = []
    fetched_at = now_ms()
    for row in rows:
        if not isinstance(row, list) or len(row) < 13:
            continue
        code = str(row[0] or "")
        if not re.match(r"^\d{6}$", code):
            continue
        points.append(
            (
                code,
                str(row[1] or ""),
                str(row[2] or ""),
                purchase_status_date(str(row[4] or ""), show_days),
                str(row[5] or ""),
                str(row[6] or ""),
                str(row[7] or ""),
                str(row[8] or ""),
                str(row[9] or ""),
                str(row[12] or ""),
                fetched_at,
            )
        )
    if not points:
        return
    with sqlite3.connect(DB_PATH) as conn:
        conn.executemany(
            """
            INSERT INTO fund_purchase_status(
              code, name, fund_type, nav_date, purchase_status, redeem_status,
              next_open_date, min_purchase, daily_limit, fee_rate, fetched_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(code) DO UPDATE SET
              name = excluded.name,
              fund_type = excluded.fund_type,
              nav_date = excluded.nav_date,
              purchase_status = excluded.purchase_status,
              redeem_status = excluded.redeem_status,
              next_open_date = excluded.next_open_date,
              min_purchase = excluded.min_purchase,
              daily_limit = excluded.daily_limit,
              fee_rate = excluded.fee_rate,
              fetched_at = excluded.fetched_at
            """,
            points,
        )


def store_market_history(source: str, symbol: str, text: str) -> int:
    rows: list[dict[str, Any]] = []
    if source == "sina-cn":
        parsed = json.loads(text)
        rows = parsed if isinstance(parsed, list) else []
    elif source == "sina-us":
        rows = parse_sina_array_jsonp(text)
    elif source == "sina-futures":
        parsed = json.loads(text)
        rows = parsed if isinstance(parsed, list) else []

    points = []
    fetched_at = now_ms()
    for row in rows:
        date = str(row.get("day") or row.get("d") or row.get("date") or "")
        try:
            close = float(row.get("close") or row.get("c") or 0)
        except (TypeError, ValueError):
            continue
        if re.match(r"^\d{4}-\d{2}-\d{2}$", date) and close > 0:
            points.append((source, symbol, date, close, fetched_at))
    if not points:
        return 0
    with sqlite3.connect(DB_PATH) as conn:
        conn.executemany(
            """
            INSERT INTO market_history(source, symbol, date, close, fetched_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(source, symbol, date) DO UPDATE SET
              close = excluded.close,
              fetched_at = excluded.fetched_at
            """,
            points,
        )
    return len(points)


def read_fund_history_from_db(code: str, page_size: int, page_index: int) -> list[dict[str, str]]:
    offset = (page_index - 1) * page_size
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            """
            SELECT date, nav, change_percent
            FROM fund_nav_history
            WHERE code = ?
            ORDER BY date DESC
            LIMIT ? OFFSET ?
            """,
            (code, page_size, offset),
        ).fetchall()
    return [
        {
            "FSRQ": str(date),
            "DWJZ": f"{float(nav):.4f}",
            "JZZZL": f"{float(change_percent):.2f}",
        }
        for date, nav, change_percent in rows
    ]


FUND_RETURN_RANGES: dict[str, tuple[str, int | None]] = {
    "1w": ("近1周", 7),
    "1m": ("近1月", 30),
    "3m": ("近3月", 90),
    "6m": ("近半年", 182),
    "1y": ("近1年", 365),
    "3y": ("近3年", 365 * 3),
    "ytd": ("今年", None),
}


def read_fund_return_summary_from_db(code: str) -> dict[str, Any] | None:
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            """
            SELECT date, nav
            FROM fund_nav_history
            WHERE code = ?
            ORDER BY date ASC
            """,
            (code,),
        ).fetchall()
    points = [(str(date), float(nav)) for date, nav in rows if float(nav) > 0]
    if len(points) < 2:
        return None

    latest_date, latest_nav = points[-1]
    try:
        latest_day = datetime.fromisoformat(latest_date).date()
    except ValueError:
        return None

    def point_on_or_before(target: str) -> tuple[str, float] | None:
        candidate = None
        for item in points:
            if item[0] <= target:
                candidate = item
            else:
                break
        return candidate

    def first_point_on_or_after(target: str) -> tuple[str, float] | None:
        for item in points:
            if item[0] >= target:
                return item
        return None

    ranges: dict[str, Any] = {}
    for key, (label, days) in FUND_RETURN_RANGES.items():
        if days is None:
            year_start = f"{latest_day.year}-01-01"
            start = point_on_or_before(year_start)
            if start is None or start[0] == latest_date:
                start = first_point_on_or_after(year_start)
        else:
            target = (latest_day - timedelta(days=days)).isoformat()
            start = point_on_or_before(target)

        if start is None:
            continue
        start_date, start_nav = start
        if start_date == latest_date or start_nav <= 0:
            continue
        return_percent = ((latest_nav - start_nav) / start_nav) * 100
        ranges[key] = {
            "key": key,
            "label": label,
            "returnPercent": round(return_percent, 2),
            "startDate": start_date,
            "endDate": latest_date,
            "startNav": round(start_nav, 4),
            "endNav": round(latest_nav, 4),
        }

    return {
        "code": code,
        "asOf": latest_date,
        "ranges": ranges,
    }


def read_purchase_status_from_db(codes: list[str], max_age_seconds: int) -> dict[str, dict[str, Any]]:
    if not codes:
        return {}
    placeholders = ",".join("?" for _ in codes)
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            f"""
            SELECT code, name, fund_type, nav_date, purchase_status, redeem_status,
                   next_open_date, min_purchase, daily_limit, fee_rate, fetched_at
            FROM fund_purchase_status
            WHERE code IN ({placeholders})
            """,
            tuple(codes),
        ).fetchall()
    min_fetched_at = now_ms() - max_age_seconds * 1000
    results: dict[str, dict[str, Any]] = {}
    for row in rows:
        (
            code,
            name,
            fund_type,
            nav_date,
            purchase_status,
            redeem_status,
            next_open_date,
            min_purchase,
            daily_limit,
            fee_rate,
            fetched_at,
        ) = row
        if int(fetched_at) < min_fetched_at:
            continue
        results[str(code)] = {
            "code": str(code),
            "name": str(name),
            "fundType": str(fund_type),
            "navDate": str(nav_date),
            "purchaseStatus": str(purchase_status),
            "redeemStatus": str(redeem_status),
            "nextOpenDate": str(next_open_date),
            "minPurchase": str(min_purchase),
            "dailyLimit": str(daily_limit),
            "feeRate": str(fee_rate),
            "fetchedAt": int(fetched_at),
        }
    return results


def read_market_history_from_db(source: str, symbol: str) -> list[dict[str, float | str]]:
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            """
            SELECT date, close
            FROM market_history
            WHERE source = ? AND symbol = ?
            ORDER BY date ASC
            """,
            (source, symbol),
        ).fetchall()
    return [{"date": str(date), "close": float(close)} for date, close in rows]


def read_market_ytd_return_from_db(source: str, symbol: str) -> dict[str, Any] | None:
    rows = read_market_history_from_db(source, symbol)
    points = [
        (str(row["date"]), float(row["close"]))
        for row in rows
        if float(row["close"]) > 0
    ]
    if len(points) < 2:
        return None

    latest_date, latest_close = points[-1]
    try:
        latest_day = datetime.fromisoformat(latest_date).date()
    except ValueError:
        return None

    year_start = f"{latest_day.year}-01-01"
    start: tuple[str, float] | None = None
    for point in points:
        if point[0] <= year_start:
            start = point
        else:
            break

    if start is None or start[0] == latest_date:
        for point in points:
            if point[0] >= year_start:
                start = point
                break

    if start is None or start[0] == latest_date or start[1] <= 0:
        return None

    start_date, start_close = start
    return_percent = ((latest_close - start_close) / start_close) * 100
    return {
        "source": source,
        "symbol": symbol,
        "label": "今年",
        "returnPercent": round(return_percent, 2),
        "startDate": start_date,
        "endDate": latest_date,
        "startClose": round(start_close, 4),
        "endClose": round(latest_close, 4),
    }


def clamp_int(raw: str, low: int, high: int, default: int) -> int:
    try:
        value = int(float(raw))
    except (TypeError, ValueError):
        return default
    return min(max(value, low), high)


def require_arg(name: str) -> str:
    value = request.args.get(name, "")
    if not value:
        raise ValueError(f"Missing {name} parameter")
    return value


def should_refresh() -> bool:
    return request.args.get("refresh", "").lower() in {"1", "true", "yes"}


def bytes_response(body: bytes, *, status: int = 200, content_type: str = "application/json") -> Response:
    response = Response(body, status=status, content_type=content_type)
    response.headers["Cache-Control"] = "public, max-age=30"
    return response


def text_response(text: str, *, status: int = 200, content_type: str = "text/plain; charset=utf-8") -> Response:
    response = Response(text, status=status, content_type=content_type)
    response.headers["Cache-Control"] = "public, max-age=30"
    return response


def json_response(payload: Any, *, status: int = 200) -> Response:
    return app.response_class(
        json.dumps(payload, ensure_ascii=False),
        status=status,
        mimetype="application/json",
    )


@app.after_request
def add_cors_headers(response: Response) -> Response:
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response


@app.errorhandler(Exception)
def handle_error(exc: Exception) -> Response:
    if isinstance(exc, HTTPException):
        return json_response({"error": exc.description}, status=exc.code or 500)
    status = 400 if isinstance(exc, ValueError) else 502
    return json_response({"error": str(exc) or "Internal server error"}, status=status)


@app.get("/api/health")
def health() -> Response:
    return jsonify({"ok": True, "db": str(DB_PATH)})


@app.get("/api/sina")
def sina() -> Response:
    symbols = ",".join(sorted(dict.fromkeys(symbol for symbol in require_arg("list").split(",") if symbol)))
    url = f"https://hq.sinajs.cn/list={symbols}"
    status, content_type, body = fetch_upstream(
        url,
        referer="https://finance.sina.com.cn/",
        content_type="text/plain; charset=utf-8",
        cache_key=f"sina:{symbols}",
        kind="sina",
        ttl_seconds=30,
    )
    del content_type
    return text_response(decode_body(body), status=status)


@app.get("/api/marketstates")
def market_states() -> Response:
    ensure_market_calendar_seeded()
    symbols = [symbol for symbol in require_arg("symbols").split(",") if symbol]
    now = parse_market_now(request.args.get("now"))
    return json_response({symbol: market_state_for_symbol(symbol, now) for symbol in symbols})


@app.get("/api/fundnav")
def fund_nav() -> Response:
    codes = require_arg("codes").split(",")
    results: dict[str, Any] = {}
    for code in codes:
        url = f"https://fundgz.1234567.com.cn/js/{quote(code)}.js"
        status, _, body = fetch_upstream(
            url,
            referer="https://fund.eastmoney.com/",
            content_type="text/plain; charset=utf-8",
            cache_key=f"fundnav:{code}",
            kind="fundnav",
            ttl_seconds=60,
        )
        if status >= 400:
            continue
        parsed = parse_jsonp_call(decode_body(body), "jsonpgz")
        if parsed:
            results[code] = parsed
    return json_response(results)


@app.get("/api/fundholdings")
def fund_holdings() -> Response:
    codes = [code for code in require_arg("codes").split(",") if code]
    refresh = should_refresh()
    results: dict[str, Any] = {}
    for code in codes:
        cached_rows = read_fund_holdings_from_db(code)
        if cached_rows and not refresh:
            results[code] = cached_rows
            continue

        query = urlencode({
            "type": "jjcc",
            "code": code,
            "topline": 10,
            "year": "",
            "month": "",
        })
        url = f"https://fundf10.eastmoney.com/FundArchivesDatas.aspx?{query}"
        status, _, body = fetch_upstream(
            url,
            referer=f"https://fundf10.eastmoney.com/ccmx_{quote(code)}.html",
            content_type="text/plain; charset=utf-8",
            cache_key=f"fundholdings:{code}",
            kind="fundholdings",
            ttl_seconds=86400,
            force_refresh=refresh,
        )
        if status >= 400:
            if cached_rows:
                results[code] = cached_rows
            continue

        parsed_rows = parse_fund_holdings(code, decode_body(body))
        if parsed_rows:
            store_fund_holdings(code, parsed_rows)
            results[code] = read_fund_holdings_from_db(code) or parsed_rows
        elif cached_rows:
            results[code] = cached_rows
    return json_response(results)


@app.get("/api/fundhistory")
def fund_history() -> Response:
    codes = require_arg("codes").split(",")
    page_size = clamp_int(request.args.get("pageSize", "2"), 2, 5000, 2)
    page_index = max(clamp_int(request.args.get("pageIndex", "1"), 1, 100000, 1), 1)
    refresh = should_refresh()
    results: dict[str, Any] = {}
    for code in codes:
        cached_rows = read_fund_history_from_db(code, page_size, page_index)
        if not refresh:
            enough_large_history = page_size > 200 and len(cached_rows) >= min(page_size, 200)
            if len(cached_rows) >= page_size or enough_large_history:
                results[code] = cached_rows
                continue

        fetch_and_store_fund_history(code, page_size * page_index, refresh=refresh)
        merged_rows = read_fund_history_from_db(code, page_size, page_index)
        if merged_rows:
            results[code] = merged_rows
        elif cached_rows:
            results[code] = cached_rows
    return json_response(results)


@app.get("/api/fundreturns")
def fund_returns() -> Response:
    codes = [code for code in require_arg("codes").split(",") if code]
    results: dict[str, Any] = {}
    for code in codes:
        summary = read_fund_return_summary_from_db(code)
        ranges = summary.get("ranges", {}) if isinstance(summary, dict) else {}
        if not summary or "1y" not in ranges or "3y" not in ranges:
            before = count_fund_history_rows(code)
            fetch_and_store_fund_history(code, 900, refresh=False)
            if count_fund_history_rows(code) > before or not summary:
                summary = read_fund_return_summary_from_db(code)
        if summary:
            results[code] = summary
    return json_response(results)


@app.get("/api/fundprofiles")
def fund_profiles() -> Response:
    codes = [code for code in require_arg("codes").split(",") if code]
    results: dict[str, Any] = {}
    refresh = should_refresh()
    for code in codes:
        url = f"https://fundf10.eastmoney.com/jbgk_{quote(code)}.html"
        status, _, body = fetch_upstream(
            url,
            referer="https://fundf10.eastmoney.com/",
            content_type="text/html; charset=utf-8",
            cache_key=f"fundprofile:{code}",
            kind="fundprofile",
            ttl_seconds=6 * 60 * 60,
            force_refresh=refresh,
        )
        if status >= 400:
            continue
        profile = parse_fund_profile(decode_body(body))
        if profile and profile.get("inceptionDate"):
            results[code] = profile
    return json_response(results)


@app.get("/api/fundpurchase")
def fund_purchase() -> Response:
    codes = [code for code in require_arg("codes").split(",") if code]
    ttl_seconds = 6 * 60 * 60
    refresh = should_refresh()

    if not refresh:
        cached_results = read_purchase_status_from_db(codes, ttl_seconds)
        if len(cached_results) >= len(set(codes)):
            return json_response(cached_results)

    query = urlencode(
        {
            "t": "8",
            "page": "1,30000",
            "js": "reData",
            "sort": "fcode,asc",
            "_": int(time.time() * 1000),
        }
    )
    url = f"http://fund.eastmoney.com/Data/Fund_JJJZ_Data.aspx?{query}"
    status, _, body = fetch_upstream(
        url,
        referer="https://fund.eastmoney.com/Fund_sgzt.html",
        content_type="text/plain; charset=utf-8",
        cache_key="fundpurchase:all",
        kind="fundpurchase",
        ttl_seconds=ttl_seconds,
        force_refresh=refresh,
    )
    if status < 400:
        store_purchase_status(decode_body(body))

    return json_response(read_purchase_status_from_db(codes, ttl_seconds))


def market_history_url(source: str, symbol: str) -> tuple[str, str]:
    if source == "sina-cn":
        return (
            f"https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketData.getKLineData?symbol={quote(symbol)}&scale=240&ma=no&datalen=1023",
            "https://finance.sina.com.cn/",
        )
    if source == "sina-us":
        return (
            f"https://stock.finance.sina.com.cn/usstock/api/jsonp.php/var%20_=/US_MinKService.getDailyK?symbol={quote(symbol)}",
            "https://finance.sina.com.cn/stock/usstock/",
        )
    if source == "sina-futures":
        return (
            f"https://stock2.finance.sina.com.cn/futures/api/json.php/GlobalFuturesService.getGlobalFuturesDailyKLine?symbol={quote(symbol)}",
            "https://finance.sina.com.cn/futures/",
        )
    raise ValueError("Unsupported source")


@app.get("/api/markethistory")
def market_history() -> Response:
    source = require_arg("source")
    symbol = require_arg("symbol")
    refresh = should_refresh()
    cached_rows = read_market_history_from_db(source, symbol)
    if not refresh and cached_rows:
        return json_response(cached_rows)

    url, referer = market_history_url(source, symbol)
    status, content_type, body = fetch_upstream(
        url,
        referer=referer,
        content_type="application/json; charset=utf-8",
        cache_key=f"markethistory:{source}:{symbol}",
        kind="markethistory",
        ttl_seconds=300,
        force_refresh=refresh,
    )
    if status >= 400:
        if cached_rows:
            return json_response(cached_rows)
        return bytes_response(body, status=status, content_type=content_type)

    try:
        stored_count = store_market_history(source, symbol, decode_body(body))
    except Exception:
        if cached_rows:
            return json_response(cached_rows)
    else:
        if stored_count == 0 and cached_rows:
            return json_response(cached_rows)
    return bytes_response(body, status=status, content_type=content_type)


@app.get("/api/marketreturns")
def market_returns() -> Response:
    items = request.args.get("items", "")
    results: dict[str, Any] = {}
    for item in [part for part in items.split(",") if part]:
        pieces = item.split(":", 1)
        if len(pieces) != 2:
            continue
        source, symbol = pieces
        summary = read_market_ytd_return_from_db(source, symbol)
        if summary:
            results[item] = summary
    return json_response(results)


def main() -> None:
    parser = argparse.ArgumentParser(description="Fund valuation Flask data backend")
    parser.add_argument("--host", default=os.environ.get("FUND_VALUATION_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("FUND_VALUATION_PORT", "8000")))
    parser.add_argument("--debug", action="store_true", default=os.environ.get("FLASK_DEBUG") == "1")
    args = parser.parse_args()

    ensure_storage()
    print(f"Flask backend listening on http://{args.host}:{args.port}")
    print(f"SQLite database: {DB_PATH}")
    app.run(host=args.host, port=args.port, debug=args.debug, threaded=True)


if __name__ == "__main__":
    main()
