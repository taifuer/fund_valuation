from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import shutil
import sqlite3
import subprocess
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

import requests
from flask import Flask, Response, g, jsonify, request
from werkzeug.exceptions import HTTPException, TooManyRequests


ROOT_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.environ.get("FUND_VALUATION_DATA_DIR", ROOT_DIR / "data"))
DB_PATH = DATA_DIR / "fund_valuation.db"
RAW_DIR = DATA_DIR / "raw"

DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
}
SLOW_REQUEST_LOG_MS = int(os.environ.get("FUND_VALUATION_SLOW_REQUEST_MS", "500"))

app = Flask(__name__)
_UPSTREAM_LOCKS: dict[str, threading.Lock] = {}
_UPSTREAM_LOCKS_GUARD = threading.Lock()
_RATE_LIMIT_BUCKETS: dict[str, deque[float]] = {}
_RATE_LIMIT_GUARD = threading.Lock()
_RESPONSE_CACHE: dict[str, tuple[float, int, str, bytes]] = {}
_RESPONSE_CACHE_GUARD = threading.Lock()
_MARKET_HISTORY_REFRESHING: set[str] = set()
_MARKET_HISTORY_REFRESH_GUARD = threading.Lock()
_EASTMONEY_SESSION = requests.Session()
_EASTMONEY_SESSION.trust_env = False

FUND_CODE_RE = re.compile(r"^\d{6}$")
SINA_SYMBOL_RE = re.compile(r"^[A-Za-z0-9_]{1,40}$")
MARKET_HISTORY_SYMBOL_RE = re.compile(r"^[A-Za-z0-9_.-]{1,40}$")
MAX_FUND_CODES_PER_REQUEST = 50
MAX_SINA_SYMBOLS_PER_REQUEST = 160
MAX_MARKET_STATE_SYMBOLS_PER_REQUEST = 160
MAX_FUND_HISTORY_REFRESH_ROWS = 3000
FUND_HISTORY_AUTO_REFRESH_ROWS = 80
HISTORY_AUTO_REFRESH_TTL_MS = 30 * 60 * 1000
MARKET_RETURNS_CACHE_TTL_SECONDS = 30 * 60

RATE_LIMIT_RULES: dict[str, tuple[int, int]] = {
    "sina": (240, 60),
    "dashboard": (180, 60),
    "marketstates": (240, 60),
    "fundnav": (120, 60),
    "fundholdings": (80, 60),
    "fundholdings_refresh": (10, 60),
    "fundhistory": (120, 60),
    "fundhistory_refresh": (10, 60),
    "fundreturns": (120, 60),
    "fundprofiles": (80, 60),
    "fundprofiles_refresh": (10, 60),
    "fundpurchase": (80, 60),
    "fundpurchase_refresh": (10, 60),
    "markethistory": (120, 60),
    "markethistory_refresh": (20, 60),
    "marketreturns": (120, 60),
    "fundbacktest": (60, 60),
    "fundbacktest_refresh": (6, 60),
}

BACKTEST_MODEL_VERSION = "top_holdings_v1"
EASTMONEY_GLOBAL_QUOTES: dict[str, tuple[str, str]] = {
    "int_nikkei": ("100.N225", "日经指数"),
    "b_TWSE": ("100.TWII", "台湾台北指数"),
}
SINA_GLOBAL_FALLBACK_QUOTES: dict[str, tuple[str, str]] = {
    "b_TWSE": ("znb_TWJQ", "台湾加权"),
}


def now_ms() -> int:
    return int(time.time() * 1000)


def beijing_today() -> str:
    return datetime.now(ZoneInfo("Asia/Shanghai")).date().isoformat()


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

            CREATE TABLE IF NOT EXISTS stock_daily_history (
              sina_symbol TEXT NOT NULL,
              date TEXT NOT NULL,
              close REAL NOT NULL,
              change_percent REAL NOT NULL,
              fetched_at INTEGER NOT NULL,
              PRIMARY KEY (sina_symbol, date)
            );

            CREATE TABLE IF NOT EXISTS fund_estimate_backtest (
              code TEXT NOT NULL,
              date TEXT NOT NULL,
              model_version TEXT NOT NULL,
              predicted_change REAL NOT NULL,
              fitted_change REAL NOT NULL,
              actual_change REAL NOT NULL,
              error REAL NOT NULL,
              fitted_error REAL NOT NULL,
              coverage REAL NOT NULL,
              fetched_at INTEGER NOT NULL,
              PRIMARY KEY (code, date, model_version)
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


def between_sessions(sessions: list[list[str]] | list[tuple[str, str]], minutes: int) -> bool:
    day_sessions: list[tuple[int, int]] = []
    for start_raw, end_raw in sessions:
        start = parse_hhmm(str(start_raw))
        end = parse_hhmm(str(end_raw))
        if start < end:
            day_sessions.append((start, end))
    day_sessions.sort()
    for (_, end), (next_start, _) in zip(day_sessions, day_sessions[1:]):
        if end <= minutes < next_start:
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


def first_session_start_minutes(sessions: list[list[str]] | list[tuple[str, str]]) -> int | None:
    starts: list[int] = []
    for start_raw, _end_raw in sessions:
        try:
            starts.append(parse_hhmm(str(start_raw)))
        except (TypeError, ValueError):
            continue
    return min(starts) if starts else None


def previous_trading_day(market: str, local: datetime) -> str | None:
    for days_back in range(1, 15):
        candidate = local - timedelta(days=days_back)
        row = market_calendar_row(market, candidate.strftime("%Y-%m-%d"))
        if row and row["status"] in {"open", "half_day"}:
            return str(row["date"])
    return None


def expected_quote_date_for_symbol(symbol: str, now: datetime | None = None) -> str | None:
    market = market_key_for_symbol(symbol)
    if not market or market not in MARKET_CALENDARS:
        return None
    current = now or datetime.now(ZoneInfo("Asia/Shanghai"))
    calendar = MARKET_CALENDARS[market]
    local = current.astimezone(ZoneInfo(str(calendar["timezone"])))
    day = local.strftime("%Y-%m-%d")
    row = market_calendar_row(market, day)
    if row and row["status"] in {"open", "half_day"}:
        first_start = first_session_start_minutes(row["sessions"])
        minutes = local.hour * 60 + local.minute
        if first_start is not None and minutes >= first_start:
            return day
    return previous_trading_day(market, local)


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
        if in_sessions(row["sessions"], minutes):
            state = "live"
        elif between_sessions(row["sessions"], minutes):
            state = "break"
        else:
            state = "closed"
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


def beijing_datetime_from_timestamp(timestamp: int) -> datetime:
    return datetime.fromtimestamp(timestamp, tz=ZoneInfo("Asia/Shanghai"))


def scaled_eastmoney_value(raw: Any, scale: int = 100) -> float | None:
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    if value <= -1_000_000_000:
        return None
    return value / scale


def fetch_eastmoney_json(
    url: str,
    *,
    cache_key: str,
    kind: str,
    ttl_seconds: int,
) -> dict[str, Any] | None:
    cached = cache_get(cache_key, ttl_seconds)
    if cached:
        try:
            return json.loads(decode_body(cached[2]))
        except json.JSONDecodeError:
            return None

    lock = upstream_lock(cache_key)
    with lock:
        cached = cache_get(cache_key, ttl_seconds)
        if cached:
            try:
                return json.loads(decode_body(cached[2]))
            except json.JSONDecodeError:
                return None

        headers = {
            **DEFAULT_HEADERS,
            "Accept": "application/json,text/plain,*/*",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Connection": "close",
            "Referer": "https://quote.eastmoney.com/",
        }
        try:
            body, status, content_type = fetch_eastmoney_body(url, headers)
            if status >= 400:
                stale = cache_any(cache_key)
                if stale:
                    return json.loads(decode_body(stale[2]))
                return None
            cache_put(cache_key, url, status, content_type, body)
            write_raw(kind, cache_key, body)
            return json.loads(decode_body(body))
        except (requests.RequestException, subprocess.SubprocessError, json.JSONDecodeError, OSError):
            stale = cache_any(cache_key)
            if stale:
                try:
                    return json.loads(decode_body(stale[2]))
                except json.JSONDecodeError:
                    return None
            return None


def fetch_eastmoney_body(url: str, headers: dict[str, str]) -> tuple[bytes, int, str]:
    curl_bin = shutil.which("curl")
    if curl_bin:
        command = [curl_bin, "--noproxy", "*", "-sS", "-L", "--max-time", "4"]
        for key, value in headers.items():
            command.extend(["-H", f"{key}: {value}"])
        command.append(url)
        result = subprocess.run(command, capture_output=True, check=False, timeout=5)
        if result.returncode == 0 and result.stdout:
            return result.stdout, 200, "application/json; charset=utf-8"
        return b"", 599, "application/json; charset=utf-8"

    response = _EASTMONEY_SESSION.get(url, headers=headers, timeout=4)
    return response.content, response.status_code, response.headers.get("Content-Type") or "application/json; charset=utf-8"


def sina_global_fallback_quote_line(symbol: str) -> str | None:
    config = SINA_GLOBAL_FALLBACK_QUOTES.get(symbol)
    if not config:
        return None
    fallback_symbol, fallback_name = config
    status, _content_type, body = fetch_upstream(
        f"https://hq.sinajs.cn/list={fallback_symbol}",
        referer="https://finance.sina.com.cn/",
        content_type="text/plain; charset=gb18030",
        cache_key=f"sina-global-fallback:{fallback_symbol}",
        kind="sina-global-fallback",
        ttl_seconds=30,
    )
    if status >= 400:
        return None
    match = re.search(rf'var\s+hq_str_{re.escape(fallback_symbol)}="([^"]*)"', decode_body(body))
    if not match:
        return None
    fields = match.group(1).split(",")
    if len(fields) < 8:
        return None
    try:
        price = float(fields[1])
        change = float(fields[2])
        change_percent = float(fields[3])
    except (TypeError, ValueError):
        return None
    date = next((field for field in fields[4:] if re.match(r"^\d{4}-\d{2}-\d{2}$", field)), "")
    if not date:
        return None
    expected_date = expected_quote_date_for_symbol(symbol)
    if expected_date and date < expected_date:
        return None
    return f'var hq_str_{symbol}="{fallback_name},{price:.2f},{change:.2f},{change_percent:.2f},{date}";'


def eastmoney_global_quote_line(symbol: str) -> str | None:
    config = EASTMONEY_GLOBAL_QUOTES.get(symbol)
    if not config:
        return None
    secid, fallback_name = config
    fields = "f43,f57,f58,f60,f86,f169,f170"
    url = f"https://push2.eastmoney.com/api/qt/stock/get?secid={quote(secid)}&fields={fields}"
    payload = fetch_eastmoney_json(
        url,
        cache_key=f"eastmoney-global:{secid}",
        kind="eastmoney-global",
        ttl_seconds=30,
    )
    data = payload.get("data") if isinstance(payload, dict) else None
    if isinstance(data, dict):
        price = scaled_eastmoney_value(data.get("f43"))
        change = scaled_eastmoney_value(data.get("f169"))
        change_percent = scaled_eastmoney_value(data.get("f170"))
        timestamp = data.get("f86")
        if price is not None and change is not None and change_percent is not None:
            try:
                updated_at = beijing_datetime_from_timestamp(int(timestamp))
            except (TypeError, ValueError, OSError):
                updated_at = datetime.now(ZoneInfo("Asia/Shanghai"))
            expected_date = expected_quote_date_for_symbol(symbol)
            date = updated_at.date().isoformat()
            if expected_date and date >= expected_date:
                name = str(data.get("f58") or fallback_name)
                return f'var hq_str_{symbol}="{name},{price:.2f},{change:.2f},{change_percent:.2f},{date}";'
            if not expected_date and abs((datetime.now(ZoneInfo("Asia/Shanghai")) - updated_at).days) <= 7:
                name = str(data.get("f58") or fallback_name)
                return f'var hq_str_{symbol}="{name},{price:.2f},{change:.2f},{change_percent:.2f},{date}";'

    return eastmoney_global_kline_quote_line(symbol, secid, fallback_name)


def eastmoney_global_kline_quote_line(symbol: str, secid: str, fallback_name: str) -> str | None:
    query = urlencode({
        "secid": secid,
        "fields1": "f1,f2,f3,f4,f5,f6",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
        "klt": "101",
        "fqt": "0",
        "end": "20500101",
        "lmt": "2",
    })
    url = f"https://push2his.eastmoney.com/api/qt/stock/kline/get?{query}"
    payload = fetch_eastmoney_json(
        url,
        cache_key=f"eastmoney-global-kline:{secid}",
        kind="eastmoney-global-kline",
        ttl_seconds=30,
    )
    data = payload.get("data") if isinstance(payload, dict) else None
    klines = data.get("klines") if isinstance(data, dict) else None
    if not isinstance(klines, list) or not klines:
        return None
    fields = str(klines[-1]).split(",")
    if len(fields) < 10:
        return None
    try:
        date = fields[0]
        price = float(fields[2])
        change_percent = float(fields[8])
        change = float(fields[9])
    except (TypeError, ValueError):
        return None
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
        return None
    expected_date = expected_quote_date_for_symbol(symbol)
    if expected_date and date < expected_date:
        return None
    if not expected_date and abs((datetime.now(ZoneInfo("Asia/Shanghai")).date() - datetime.fromisoformat(date).date()).days) > 7:
        return None
    name = str(data.get("name") or fallback_name) if isinstance(data, dict) else fallback_name
    return f'var hq_str_{symbol}="{name},{price:.2f},{change:.2f},{change_percent:.2f},{date}";'


def append_eastmoney_global_quotes(text: str, symbols: list[str]) -> str:
    lines = [text.rstrip()] if text.strip() else []
    for symbol in sorted(set(symbols)):
        try:
            line = sina_global_fallback_quote_line(symbol) or eastmoney_global_quote_line(symbol)
        except Exception:
            line = None
        if line:
            lines.append(line)
    return "\n".join(line for line in lines if line) + ("\n" if lines else "")


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


def latest_fund_history_meta(code: str) -> tuple[str | None, int]:
    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute(
            """
            SELECT MAX(date), MAX(fetched_at)
            FROM fund_nav_history
            WHERE code = ?
            """,
            (code,),
        ).fetchone()
    return (str(row[0]) if row and row[0] else None, int(row[1] if row and row[1] else 0))


def history_needs_auto_refresh(latest_date: str | None, fetched_at: int) -> bool:
    if not latest_date:
        return False
    if latest_date >= beijing_today():
        return False
    return now_ms() - fetched_at > HISTORY_AUTO_REFRESH_TTL_MS


def auto_refresh_fund_history_if_stale(code: str, target_count: int) -> None:
    latest_date, fetched_at = latest_fund_history_meta(code)
    if not history_needs_auto_refresh(latest_date, fetched_at):
        return
    fetch_and_store_fund_history(
        code,
        min(max(target_count, 2), FUND_HISTORY_AUTO_REFRESH_ROWS),
        refresh=True,
    )


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


def parse_default_fund_holdings_from_constants(code: str) -> list[dict[str, Any]]:
    constants_path = ROOT_DIR / "src" / "constants.ts"
    try:
        text = constants_path.read_text(encoding="utf-8")
    except OSError:
        return []

    match = re.search(
        rf"symbol:\s*'{re.escape(code)}'.*?code:\s*'{re.escape(code)}'.*?holdings:\s*\[(.*?)\]\s*,\s*\}}",
        text,
        re.S,
    )
    if not match:
        return []

    helpers = {
        "us": ("us", "USD", lambda symbol: f"gb_{symbol.lower()}"),
        "cn": ("cn", "CNY", lambda symbol: symbol.lower()),
        "hk": ("hk", "HKD", lambda symbol: f"hk{symbol.zfill(5)}"),
        "kr": ("kr", "KRW", lambda symbol: f"kr{symbol}"),
    }
    holdings: list[dict[str, Any]] = []
    for rank, item in enumerate(
        re.finditer(r"(us|cn|hk|kr)\('([^']+)'\s*,\s*'([^']+)'\s*,\s*([0-9.]+)\)", match.group(1)),
        start=1,
    ):
        helper, symbol, name, weight_raw = item.groups()
        market, currency, sina_symbol_fn = helpers[helper]
        try:
            weight = float(weight_raw)
        except ValueError:
            continue
        holdings.append({
            "code": code,
            "reportDate": "2026-03-31",
            "rank": rank,
            "stockCode": symbol.upper(),
            "symbol": symbol.upper(),
            "name": name,
            "weight": weight,
            "market": market,
            "sinaSymbol": sina_symbol_fn(symbol),
            "currency": currency,
        })
    return holdings


def read_fund_holdings_for_backtest(code: str) -> list[dict[str, Any]]:
    rows = read_fund_holdings_from_db(code)
    return rows if rows else parse_default_fund_holdings_from_constants(code)


def configured_fund_codes_from_constants() -> list[str]:
    constants_path = ROOT_DIR / "src" / "constants.ts"
    try:
        text = constants_path.read_text(encoding="utf-8")
    except OSError:
        return []
    return list(dict.fromkeys(re.findall(r"code:\s*'(\d{6})'", text)))


def configured_market_return_items_from_constants() -> list[str]:
    constants_path = ROOT_DIR / "src" / "constants.ts"
    try:
        text = constants_path.read_text(encoding="utf-8")
    except OSError:
        return []
    pairs = re.findall(
        r"history:\s*\{\s*source:\s*'([^']+)'\s*,\s*symbol:\s*'([^']+)'",
        text,
    )
    items = [
        f"{source}:{symbol}"
        for source, symbol in pairs
        if source in {"sina-cn", "sina-us", "sina-futures", "tencent-hk"}
        and MARKET_HISTORY_SYMBOL_RE.fullmatch(symbol)
    ]
    return sorted(dict.fromkeys(items))


def prewarm_response_cache() -> None:
    fund_codes = configured_fund_codes_from_constants()
    fund_payload = {
        code: summary
        for code in sorted(fund_codes)
        if (summary := read_fund_return_summary_from_db(code))
    }
    if fund_payload:
        response_cache_set(
            f"api:fundreturns:{','.join(sorted(fund_codes))}",
            json_response(fund_payload),
            5 * 60,
        )

    market_items = configured_market_return_items_from_constants()
    market_payload: dict[str, Any] = {}
    for item in market_items:
        source, symbol = item.split(":", 1)
        summary = read_market_return_summary_from_db(source, symbol)
        if summary:
            market_payload[item] = summary
    if market_payload:
        response_cache_set(
            f"api:marketreturns:{','.join(market_items)}",
            json_response(market_payload),
            MARKET_RETURNS_CACHE_TTL_SECONDS,
        )

    print(
        f"Prewarmed caches: fundreturns {len(fund_payload)}/{len(fund_codes)}, "
        f"marketreturns {len(market_payload)}/{len(market_items)}",
        flush=True,
    )


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
    elif source == "tencent-hk":
        parsed = json.loads(text)
        data = parsed.get("data") if isinstance(parsed, dict) else None
        symbol_data = data.get(symbol) if isinstance(data, dict) else None
        day_rows = symbol_data.get("day") if isinstance(symbol_data, dict) else None
        if isinstance(day_rows, list):
            for row in day_rows:
                if not isinstance(row, list) or len(row) < 3:
                    continue
                rows.append({"date": row[0], "close": row[2]})

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


def stock_history_url(sina_symbol: str) -> tuple[str, str] | None:
    if sina_symbol.startswith("gb_"):
        symbol = sina_symbol[3:].upper()
        return (
            f"https://stock.finance.sina.com.cn/usstock/api/jsonp.php/var%20_=/US_MinKService.getDailyK?symbol={quote(symbol)}",
            "https://finance.sina.com.cn/stock/usstock/",
        )
    if re.match(r"^(sh|sz)\d{6}$", sina_symbol):
        return (
            f"https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketData.getKLineData?symbol={quote(sina_symbol)}&scale=240&ma=no&datalen=1023",
            "https://finance.sina.com.cn/",
        )
    if re.match(r"^hk\d{5}$", sina_symbol):
        symbol = sina_symbol[2:]
        return (
            f"https://quotes.sina.cn/hk/api/jsonp.php/var%20_=/HK_MarketData.getKLine?symbol={quote(symbol)}&scale=240&ma=no&datalen=1023",
            "https://finance.sina.com.cn/stock/hkstock/",
        )
    return None


def parse_stock_history_rows(sina_symbol: str, text: str) -> list[dict[str, Any]]:
    if sina_symbol.startswith("gb_") or sina_symbol.startswith("hk"):
        return parse_sina_array_jsonp(text)
    if re.match(r"^(sh|sz)\d{6}$", sina_symbol):
        parsed = json.loads(text)
        return parsed if isinstance(parsed, list) else []
    return []


def store_stock_history(sina_symbol: str, text: str) -> int:
    rows = parse_stock_history_rows(sina_symbol, text)
    raw_points: list[tuple[str, float]] = []
    for row in rows:
        date = str(row.get("day") or row.get("d") or row.get("date") or "")
        try:
            close = float(row.get("close") or row.get("c") or 0)
        except (TypeError, ValueError):
            continue
        if re.match(r"^\d{4}-\d{2}-\d{2}$", date) and close > 0:
            raw_points.append((date, close))

    deduped = sorted(dict(raw_points).items())
    if not deduped:
        return 0

    existing: dict[str, float] = {}
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            """
            SELECT date, close
            FROM stock_daily_history
            WHERE sina_symbol = ?
            ORDER BY date ASC
            """,
            (sina_symbol,),
        ).fetchall()
    existing = {str(date): float(close) for date, close in rows}

    merged = sorted({**existing, **dict(deduped)}.items())
    previous_close_by_date: dict[str, float] = {}
    previous_close: float | None = None
    for date, close in merged:
        if previous_close is not None and previous_close > 0:
            previous_close_by_date[date] = previous_close
        previous_close = close

    fetched_at = now_ms()
    points: list[tuple[str, str, float, float, int]] = []
    for date, close in deduped:
        previous = previous_close_by_date.get(date)
        change_percent = ((close - previous) / previous) * 100 if previous and previous > 0 else 0.0
        points.append((sina_symbol, date, close, change_percent, fetched_at))

    with sqlite3.connect(DB_PATH) as conn:
        conn.executemany(
            """
            INSERT INTO stock_daily_history(sina_symbol, date, close, change_percent, fetched_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(sina_symbol, date) DO UPDATE SET
              close = excluded.close,
              change_percent = excluded.change_percent,
              fetched_at = excluded.fetched_at
            """,
            points,
        )
    return len(points)


def fetch_and_store_stock_history(sina_symbol: str, *, refresh: bool = False) -> bool:
    target = stock_history_url(sina_symbol)
    if target is None:
        return False
    url, referer = target
    status, _, body = fetch_upstream(
        url,
        referer=referer,
        content_type="application/json; charset=utf-8",
        cache_key=f"stockhistory:{sina_symbol}",
        kind="stockhistory",
        ttl_seconds=300,
        force_refresh=refresh,
    )
    if status >= 400:
        return False
    try:
        return store_stock_history(sina_symbol, decode_body(body)) > 0
    except Exception:
        return False


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

MARKET_RETURN_RANGES: dict[str, tuple[str, int | None]] = {
    "1w": ("近1周", 7),
    "1m": ("近1月", 30),
    "3m": ("近3月", 90),
    "6m": ("近半年", 182),
    "1y": ("近1年", 365),
    "3y": ("近3年", 365 * 3),
    "ytd": ("今年", None),
}


def history_risk_metrics(points: list[tuple[str, float]], start_date: str, end_date: str) -> dict[str, float | None]:
    window = [
        value
        for date, value in points
        if start_date <= date <= end_date and value > 0
    ]
    if len(window) < 2:
        return {"maxDrawdownPercent": None, "winRatePercent": None}

    peak = window[0]
    max_drawdown = 0.0
    positive_days = 0
    comparable_days = 0
    for value in window:
        peak = max(peak, value)
        if peak > 0:
            max_drawdown = min(max_drawdown, (value - peak) / peak * 100)
    for previous, current in zip(window, window[1:]):
        if previous <= 0:
            continue
        comparable_days += 1
        if current > previous:
            positive_days += 1

    win_rate = positive_days / comparable_days * 100 if comparable_days else None

    return {
        "maxDrawdownPercent": round(max_drawdown, 2),
        "winRatePercent": round(win_rate, 2) if win_rate is not None else None,
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
            **history_risk_metrics(points, start_date, latest_date),
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


def latest_market_history_meta(source: str, symbol: str) -> tuple[str | None, int]:
    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute(
            """
            SELECT MAX(date), MAX(fetched_at)
            FROM market_history
            WHERE source = ? AND symbol = ?
            """,
            (source, symbol),
        ).fetchone()
    return (str(row[0]) if row and row[0] else None, int(row[1] if row and row[1] else 0))


def auto_refresh_market_history_if_stale(source: str, symbol: str) -> bool:
    latest_date, fetched_at = latest_market_history_meta(source, symbol)
    if not history_needs_auto_refresh(latest_date, fetched_at):
        return False

    try:
        url, referer = market_history_url(source, symbol)
        status, _, body = fetch_upstream(
            url,
            referer=referer,
            content_type="application/json; charset=utf-8",
            cache_key=f"markethistory:{source}:{symbol}",
            kind="markethistory",
            ttl_seconds=300,
            force_refresh=True,
        )
        if status >= 400:
            return False
        return store_market_history(source, symbol, decode_body(body)) > 0
    except Exception:
        return False


def ensure_market_history_for_returns(source: str, symbol: str) -> None:
    latest_date, fetched_at = latest_market_history_meta(source, symbol)
    if latest_date:
        auto_refresh_market_history_if_stale(source, symbol)
        return

    try:
        url, referer = market_history_url(source, symbol)
        status, _, body = fetch_upstream(
            url,
            referer=referer,
            content_type="application/json; charset=utf-8",
            cache_key=f"markethistory:{source}:{symbol}",
            kind="markethistory",
            ttl_seconds=300,
            force_refresh=now_ms() - fetched_at > HISTORY_AUTO_REFRESH_TTL_MS,
        )
        if status < 400:
            store_market_history(source, symbol, decode_body(body))
    except Exception:
        pass


def refresh_market_history_background(source: str, symbol: str) -> None:
    key = f"{source}:{symbol}"
    try:
        ensure_market_history_for_returns(source, symbol)
        response_cache_clear_prefix("api:marketreturns:")
    finally:
        with _MARKET_HISTORY_REFRESH_GUARD:
            _MARKET_HISTORY_REFRESHING.discard(key)


def schedule_market_history_refresh(source: str, symbol: str) -> None:
    key = f"{source}:{symbol}"
    with _MARKET_HISTORY_REFRESH_GUARD:
        if key in _MARKET_HISTORY_REFRESHING:
            return
        _MARKET_HISTORY_REFRESHING.add(key)
    worker = threading.Thread(
        target=refresh_market_history_background,
        args=(source, symbol),
        daemon=True,
        name=f"market-history-refresh:{key}",
    )
    worker.start()


def market_history_should_refresh_for_returns(source: str, symbol: str) -> bool:
    latest_date, fetched_at = latest_market_history_meta(source, symbol)
    return not latest_date or history_needs_auto_refresh(latest_date, fetched_at)


def read_market_return_summary_from_db(source: str, symbol: str) -> dict[str, Any] | None:
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

    def point_on_or_before(target: str) -> tuple[str, float] | None:
        candidate = None
        for point in points:
            if point[0] <= target:
                candidate = point
            else:
                break
        return candidate

    def first_point_on_or_after(target: str) -> tuple[str, float] | None:
        for point in points:
            if point[0] >= target:
                return point
        return None

    ranges: dict[str, Any] = {}
    for key, (label, days) in MARKET_RETURN_RANGES.items():
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
        start_date, start_close = start
        if start_date == latest_date or start_close <= 0:
            continue
        return_percent = ((latest_close - start_close) / start_close) * 100
        ranges[key] = {
            "key": key,
            "label": label,
            "returnPercent": round(return_percent, 2),
            **history_risk_metrics(points, start_date, latest_date),
            "startDate": start_date,
            "endDate": latest_date,
            "startClose": round(start_close, 4),
            "endClose": round(latest_close, 4),
        }

    if not ranges:
        return None

    ytd = ranges.get("ytd")
    return {
        "source": source,
        "symbol": symbol,
        "asOf": latest_date,
        "ranges": ranges,
        "label": ytd["label"] if ytd else "",
        "returnPercent": ytd["returnPercent"] if ytd else 0,
        "startDate": ytd["startDate"] if ytd else "",
        "endDate": latest_date,
        "startClose": ytd["startClose"] if ytd else 0,
        "endClose": round(latest_close, 4),
    }


def read_fund_nav_changes(code: str, days: int) -> list[tuple[str, float]]:
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            """
            SELECT date, change_percent
            FROM fund_nav_history
            WHERE code = ?
            ORDER BY date DESC
            LIMIT ?
            """,
            (code, days),
        ).fetchall()
    return [(str(date), float(change)) for date, change in reversed(rows)]


def read_stock_changes(symbols: list[str], start_date: str, end_date: str) -> dict[str, dict[str, float]]:
    supported = [symbol for symbol in dict.fromkeys(symbols) if symbol]
    if not supported:
        return {}
    placeholders = ",".join("?" for _ in supported)
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            f"""
            SELECT sina_symbol, date, change_percent
            FROM stock_daily_history
            WHERE sina_symbol IN ({placeholders})
              AND date BETWEEN ? AND ?
            """,
            (*supported, start_date, end_date),
        ).fetchall()
    changes: dict[str, dict[str, float]] = {symbol: {} for symbol in supported}
    for symbol, date, change in rows:
        changes.setdefault(str(symbol), {})[str(date)] = float(change)
    return changes


def linear_fit(points: list[dict[str, float]], key: str = "predictedChange") -> tuple[float, float]:
    if len(points) < 2:
        return 0.0, 1.0
    xs = [point[key] for point in points]
    ys = [point["actualChange"] for point in points]
    mean_x = sum(xs) / len(xs)
    mean_y = sum(ys) / len(ys)
    variance = sum((x - mean_x) ** 2 for x in xs)
    if variance <= 1e-12:
        return mean_y, 0.0
    beta = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys)) / variance
    alpha = mean_y - beta * mean_x
    return alpha, beta


def backtest_metrics(points: list[dict[str, float]], key: str) -> dict[str, Any]:
    if not points:
        return {"mae": None, "rmse": None, "directionAccuracy": None}
    errors = [float(point[key]) - float(point["actualChange"]) for point in points]
    mae = sum(abs(error) for error in errors) / len(errors)
    rmse = (sum(error * error for error in errors) / len(errors)) ** 0.5
    direction_hits = 0
    direction_count = 0
    for point in points:
        predicted = float(point[key])
        actual = float(point["actualChange"])
        if predicted == 0 or actual == 0:
            continue
        direction_count += 1
        if (predicted > 0) == (actual > 0):
            direction_hits += 1
    return {
        "mae": round(mae, 4),
        "rmse": round(rmse, 4),
        "directionAccuracy": round(direction_hits / direction_count * 100, 2) if direction_count else None,
    }


def split_backtest_points(points: list[dict[str, float]]) -> tuple[list[dict[str, float]], list[dict[str, float]]]:
    if len(points) < 12:
        return points, points
    split_index = int(len(points) * 0.7)
    split_index = min(max(split_index, 8), len(points) - 4)
    return points[:split_index], points[split_index:]


def store_backtest_points(code: str, points: list[dict[str, float]]) -> None:
    if not points:
        return
    fetched_at = now_ms()
    rows = [
        (
            code,
            str(point["date"]),
            BACKTEST_MODEL_VERSION,
            float(point["predictedChange"]),
            float(point["fittedChange"]),
            float(point["actualChange"]),
            float(point["error"]),
            float(point["fittedError"]),
            float(point["coverage"]),
            fetched_at,
        )
        for point in points
    ]
    with sqlite3.connect(DB_PATH) as conn:
        conn.executemany(
            """
            INSERT INTO fund_estimate_backtest(
              code, date, model_version, predicted_change, fitted_change, actual_change,
              error, fitted_error, coverage, fetched_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(code, date, model_version) DO UPDATE SET
              predicted_change = excluded.predicted_change,
              fitted_change = excluded.fitted_change,
              actual_change = excluded.actual_change,
              error = excluded.error,
              fitted_error = excluded.fitted_error,
              coverage = excluded.coverage,
              fetched_at = excluded.fetched_at
            """,
            rows,
        )


def compute_fund_backtest(code: str, days: int, *, refresh: bool = False) -> dict[str, Any] | None:
    holdings = read_fund_holdings_for_backtest(code)
    holdings = [item for item in holdings if item.get("sinaSymbol")]
    nav_changes = read_fund_nav_changes(code, days)
    if not holdings or len(nav_changes) < 2:
        return None

    if refresh:
        for symbol in dict.fromkeys(str(item.get("sinaSymbol") or "") for item in holdings):
            if symbol:
                fetch_and_store_stock_history(symbol, refresh=True)

    start_date = nav_changes[0][0]
    end_date = nav_changes[-1][0]
    changes = read_stock_changes([str(item["sinaSymbol"]) for item in holdings], start_date, end_date)
    total_weight = sum(float(item.get("weight") or 0) for item in holdings)
    points: list[dict[str, float]] = []

    for date, actual_change in nav_changes:
        predicted = 0.0
        covered_weight = 0.0
        for item in holdings:
            weight = float(item.get("weight") or 0)
            change = changes.get(str(item["sinaSymbol"]), {}).get(date)
            if change is None:
                continue
            predicted += weight * change
            covered_weight += weight
        if covered_weight <= 0:
            continue
        coverage = covered_weight / total_weight if total_weight > 0 else 0
        points.append({
            "date": date,  # type: ignore[dict-item]
            "predictedChange": predicted,
            "normalizedChange": predicted / covered_weight if covered_weight > 0 else predicted,
            "actualChange": actual_change,
            "coverage": coverage,
            "coveredWeight": covered_weight,
        })

    if len(points) < 2:
        return None

    train_points, validation_points = split_backtest_points(points)
    alpha, beta = linear_fit(train_points, "predictedChange")
    normalized_alpha, normalized_beta = linear_fit(train_points, "normalizedChange")
    for point in points:
        raw_fitted = alpha + beta * float(point["predictedChange"])
        normalized_fitted = normalized_alpha + normalized_beta * float(point["normalizedChange"])
        point["rawFittedChange"] = raw_fitted
        point["normalizedFittedChange"] = normalized_fitted
        point["error"] = float(point["predictedChange"]) - float(point["actualChange"])

    validation_raw = backtest_metrics(validation_points, "predictedChange")
    validation_raw_fitted = backtest_metrics(validation_points, "rawFittedChange")
    validation_normalized_fitted = backtest_metrics(validation_points, "normalizedFittedChange")
    candidates = [
        ("raw", validation_raw.get("mae")),
        ("linear", validation_raw_fitted.get("mae")),
        ("normalizedLinear", validation_normalized_fitted.get("mae")),
    ]
    valid_candidates = [(name, float(mae)) for name, mae in candidates if mae is not None]
    recommended_model = min(valid_candidates, key=lambda item: item[1])[0] if valid_candidates else "raw"
    fitted_key = {
        "raw": "predictedChange",
        "linear": "rawFittedChange",
        "normalizedLinear": "normalizedFittedChange",
    }[recommended_model]

    for point in points:
        point["fittedChange"] = float(point[fitted_key])
        point["fittedError"] = float(point["fittedChange"]) - float(point["actualChange"])
        for key in (
            "predictedChange",
            "normalizedChange",
            "actualChange",
            "coverage",
            "coveredWeight",
            "rawFittedChange",
            "normalizedFittedChange",
            "fittedChange",
            "error",
            "fittedError",
        ):
            point[key] = round(float(point[key]), 4)

    store_backtest_points(code, points)
    coverage_avg = sum(float(point["coverage"]) for point in points) / len(points)
    top_holding_weight = total_weight * 100
    train_summary = {
        "raw": backtest_metrics(train_points, "predictedChange"),
        "linear": backtest_metrics(train_points, "rawFittedChange"),
        "normalizedLinear": backtest_metrics(train_points, "normalizedFittedChange"),
        "selected": backtest_metrics(train_points, fitted_key),
    }
    validation_summary = {
        "raw": validation_raw,
        "linear": validation_raw_fitted,
        "normalizedLinear": validation_normalized_fitted,
        "selected": backtest_metrics(validation_points, fitted_key),
    }
    return {
        "code": code,
        "modelVersion": BACKTEST_MODEL_VERSION,
        "sampleCount": len(points),
        "trainSampleCount": len(train_points),
        "validationSampleCount": len(validation_points),
        "startDate": points[0]["date"],
        "endDate": points[-1]["date"],
        "holdingCount": len(holdings),
        "supportedHoldingCount": len([item for item in holdings if stock_history_url(str(item.get("sinaSymbol") or ""))]),
        "coverageAvg": round(coverage_avg * 100, 2),
        "topHoldingWeight": round(top_holding_weight, 2),
        "fit": {"alpha": round(alpha, 4), "beta": round(beta, 4), "source": "predictedChange"},
        "normalizedFit": {
            "alpha": round(normalized_alpha, 4),
            "beta": round(normalized_beta, 4),
            "source": "normalizedChange",
        },
        "recommendedModel": recommended_model,
        "shouldApplyFitted": recommended_model != "raw",
        "expectedError": validation_summary["selected"].get("mae"),
        "train": train_summary,
        "validation": validation_summary,
        "raw": backtest_metrics(points, "predictedChange"),
        "normalized": backtest_metrics(points, "normalizedChange"),
        "fitted": backtest_metrics(points, "fittedChange"),
        "points": points,
        "limitations": [
            "当前版本使用最新披露/配置的前十大持仓回测，尚未按历史季度切换持仓。",
            "历史汇率暂未纳入，外币持仓回测使用股票本币涨跌。",
            "未披露持仓、现金仓位和基金费用会体现在残差中。",
        ],
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


def unique_csv_values(raw: str) -> list[str]:
    return list(dict.fromkeys(part.strip() for part in raw.split(",") if part.strip()))


def require_fund_codes(name: str = "codes", *, max_codes: int = MAX_FUND_CODES_PER_REQUEST) -> list[str]:
    codes = unique_csv_values(require_arg(name))
    if not codes:
        raise ValueError(f"Missing {name} parameter")
    invalid = [code for code in codes if not FUND_CODE_RE.fullmatch(code)]
    if invalid:
        preview = ", ".join(invalid[:3])
        raise ValueError(f"Invalid fund code: {preview}; fund codes must be 6 digits")
    if len(codes) > max_codes:
        raise ValueError(f"Too many fund codes; maximum is {max_codes}")
    return codes


def require_symbol_list(name: str, *, pattern: re.Pattern[str], max_symbols: int) -> list[str]:
    symbols = unique_csv_values(require_arg(name))
    if not symbols:
        raise ValueError(f"Missing {name} parameter")
    invalid = [symbol for symbol in symbols if not pattern.fullmatch(symbol)]
    if invalid:
        preview = ", ".join(invalid[:3])
        raise ValueError(f"Invalid symbol: {preview}")
    if len(symbols) > max_symbols:
        raise ValueError(f"Too many symbols; maximum is {max_symbols}")
    return symbols


def should_refresh() -> bool:
    return request.args.get("refresh", "").lower() in {"1", "true", "yes"}


def client_rate_key() -> str:
    forwarded = request.headers.get("X-Forwarded-For", "").split(",", 1)[0].strip()
    return forwarded or request.remote_addr or "unknown"


def enforce_rate_limit(rule: str) -> None:
    limit, window_seconds = RATE_LIMIT_RULES.get(rule, (0, 0))
    if limit <= 0 or window_seconds <= 0:
        return

    now = time.monotonic()
    bucket_key = f"{rule}:{client_rate_key()}"
    with _RATE_LIMIT_GUARD:
        bucket = _RATE_LIMIT_BUCKETS.setdefault(bucket_key, deque())
        while bucket and now - bucket[0] >= window_seconds:
            bucket.popleft()
        if len(bucket) >= limit:
            raise TooManyRequests(description=f"Rate limit exceeded for {rule}; please retry later")
        bucket.append(now)


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


def response_cache_get(cache_key: str, ttl_seconds: int) -> Response | None:
    if should_refresh() or ttl_seconds <= 0:
        return None
    now = time.monotonic()
    with _RESPONSE_CACHE_GUARD:
        cached = _RESPONSE_CACHE.get(cache_key)
        if not cached:
            return None
        expires_at, status, content_type, body = cached
        if now >= expires_at:
            _RESPONSE_CACHE.pop(cache_key, None)
            return None
    response = bytes_response(body, status=status, content_type=content_type)
    response.headers["X-Cache"] = "HIT"
    return response


def response_cache_set(cache_key: str, response: Response, ttl_seconds: int) -> Response:
    if ttl_seconds <= 0 or response.status_code != 200:
        return response
    body = response.get_data()
    content_type = response.content_type or "application/json"
    with _RESPONSE_CACHE_GUARD:
        _RESPONSE_CACHE[cache_key] = (
            time.monotonic() + ttl_seconds,
            response.status_code,
            content_type,
            body,
        )
    response.headers["X-Cache"] = "MISS"
    return response


def response_cache_clear_prefix(prefix: str) -> None:
    with _RESPONSE_CACHE_GUARD:
        for key in list(_RESPONSE_CACHE):
            if key.startswith(prefix):
                _RESPONSE_CACHE.pop(key, None)


def cached_json_response(cache_key: str, ttl_seconds: int, payload_factory: Any) -> Response:
    cached = response_cache_get(cache_key, ttl_seconds)
    if cached is not None:
        return cached
    lock = upstream_lock(f"response:{cache_key}")
    with lock:
        cached = response_cache_get(cache_key, ttl_seconds)
        if cached is not None:
            return cached
        return response_cache_set(cache_key, json_response(payload_factory()), ttl_seconds)


def cached_text_response(cache_key: str, ttl_seconds: int, text_factory: Any) -> Response:
    cached = response_cache_get(cache_key, ttl_seconds)
    if cached is not None:
        return cached
    lock = upstream_lock(f"response:{cache_key}")
    with lock:
        cached = response_cache_get(cache_key, ttl_seconds)
        if cached is not None:
            return cached
        text, status = text_factory()
        return response_cache_set(cache_key, text_response(text, status=status), ttl_seconds)


@app.before_request
def mark_request_start() -> None:
    g.request_started_at = time.perf_counter()


@app.after_request
def add_response_headers(response: Response) -> Response:
    started_at = getattr(g, "request_started_at", None)
    if isinstance(started_at, float):
        elapsed_ms = (time.perf_counter() - started_at) * 1000
        response.headers["X-Elapsed-ms"] = f"{elapsed_ms:.1f}"
        if elapsed_ms >= SLOW_REQUEST_LOG_MS:
            cache_status = response.headers.get("X-Cache", "-")
            print(
                f"[slow-request] {request.method} {request.full_path.rstrip('?')} "
                f"{response.status_code} {elapsed_ms:.1f}ms cache={cache_status}",
                flush=True,
            )
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
    enforce_rate_limit("sina")
    symbol_list = sorted(require_symbol_list(
        "list",
        pattern=SINA_SYMBOL_RE,
        max_symbols=MAX_SINA_SYMBOLS_PER_REQUEST,
    ))
    symbols = ",".join(symbol_list)
    def build() -> tuple[str, int]:
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
        return append_eastmoney_global_quotes(decode_body(body), symbol_list), status
    return cached_text_response(f"api:sina:{symbols}", 15, build)


@app.get("/api/marketstates")
def market_states() -> Response:
    enforce_rate_limit("marketstates")
    symbols = sorted(require_symbol_list(
        "symbols",
        pattern=SINA_SYMBOL_RE,
        max_symbols=MAX_MARKET_STATE_SYMBOLS_PER_REQUEST,
    ))
    now_arg = request.args.get("now", "")
    cache_key = f"api:marketstates:{now_arg}:{','.join(symbols)}"

    def build() -> dict[str, Any]:
        ensure_market_calendar_seeded()
        now = parse_market_now(now_arg)
        return {symbol: market_state_for_symbol(symbol, now) for symbol in symbols}

    return cached_json_response(cache_key, 15, build)


@app.get("/api/dashboard")
def dashboard() -> Response:
    enforce_rate_limit("dashboard")
    symbols = sorted(require_symbol_list(
        "symbols",
        pattern=SINA_SYMBOL_RE,
        max_symbols=MAX_SINA_SYMBOLS_PER_REQUEST,
    ))
    currencies = sorted(dict.fromkeys(
        currency
        for currency in request.args.get("currencies", "").split(",")
        if currency in {"USD", "EUR", "JPY", "KRW", "HKD"}
    ))
    now_arg = request.args.get("now", "")
    cache_key = f"api:dashboard:{now_arg}:{','.join(currencies)}:{','.join(symbols)}"

    def build() -> dict[str, Any]:
        sina_text = ""
        if symbols:
            joined_symbols = ",".join(symbols)
            status, _, body = fetch_upstream(
                f"https://hq.sinajs.cn/list={joined_symbols}",
                referer="https://finance.sina.com.cn/",
                content_type="text/plain; charset=utf-8",
                cache_key=f"sina:{joined_symbols}",
                kind="sina",
                ttl_seconds=30,
            )
            if status < 400:
                sina_text = decode_body(body)
        sina_text = append_eastmoney_global_quotes(sina_text, symbols)

        fx_text = ""
        fx_symbols = {
            "USD": "fx_susdcny",
            "EUR": "fx_seurcny",
            "JPY": "fx_sjpycny",
            "KRW": "fx_skrwcny",
            "HKD": "fx_shkdcny",
        }
        requested_fx_symbols = [fx_symbols[currency] for currency in currencies if currency in fx_symbols]
        if requested_fx_symbols:
            joined_fx_symbols = ",".join(requested_fx_symbols)
            status, _, body = fetch_upstream(
                f"https://hq.sinajs.cn/list={joined_fx_symbols}",
                referer="https://finance.sina.com.cn/",
                content_type="text/plain; charset=utf-8",
                cache_key=f"sina:{joined_fx_symbols}",
                kind="sina",
                ttl_seconds=30,
            )
            if status < 400:
                fx_text = decode_body(body)

        ensure_market_calendar_seeded()
        now = parse_market_now(now_arg)
        return {
            "quotesText": sina_text,
            "fxText": fx_text,
            "marketStates": {symbol: market_state_for_symbol(symbol, now) for symbol in symbols},
        }

    return cached_json_response(cache_key, 15, build)


@app.get("/api/fundnav")
def fund_nav() -> Response:
    enforce_rate_limit("fundnav")
    codes = require_fund_codes()
    cache_key = f"api:fundnav:{','.join(sorted(codes))}"

    def build() -> dict[str, Any]:
        def fetch_one(code: str) -> tuple[str, Any | None]:
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
                return code, None
            return code, parse_jsonp_call(decode_body(body), "jsonpgz")

        results: dict[str, Any] = {}
        max_workers = min(8, len(codes))
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = [executor.submit(fetch_one, code) for code in codes]
            for future in as_completed(futures):
                code, parsed = future.result()
                if parsed:
                    results[code] = parsed
        return results

    return cached_json_response(cache_key, 60, build)


@app.get("/api/fundholdings")
def fund_holdings() -> Response:
    enforce_rate_limit("fundholdings")
    codes = require_fund_codes()
    refresh = should_refresh()
    if refresh:
        enforce_rate_limit("fundholdings_refresh")
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
    enforce_rate_limit("fundhistory")
    codes = require_fund_codes()
    page_size = clamp_int(request.args.get("pageSize", "2"), 2, 5000, 2)
    page_index = max(clamp_int(request.args.get("pageIndex", "1"), 1, 100000, 1), 1)
    refresh = should_refresh()
    if refresh:
        enforce_rate_limit("fundhistory_refresh")
    results: dict[str, Any] = {}
    for code in codes:
        cached_rows = read_fund_history_from_db(code, page_size, page_index)
        if not refresh:
            if cached_rows:
                try:
                    auto_refresh_fund_history_if_stale(code, page_size * page_index)
                except Exception:
                    pass
                results[code] = read_fund_history_from_db(code, page_size, page_index) or cached_rows
            continue

        target_count = min(page_size * page_index, MAX_FUND_HISTORY_REFRESH_ROWS)
        fetch_and_store_fund_history(code, target_count, refresh=refresh)
        merged_rows = read_fund_history_from_db(code, page_size, page_index)
        if merged_rows:
            results[code] = merged_rows
        elif cached_rows:
            results[code] = cached_rows
    return json_response(results)


@app.get("/api/fundreturns")
def fund_returns() -> Response:
    enforce_rate_limit("fundreturns")
    codes = require_fund_codes()
    cache_key = f"api:fundreturns:{','.join(sorted(codes))}"

    def build() -> dict[str, Any]:
        results: dict[str, Any] = {}
        for code in codes:
            try:
                auto_refresh_fund_history_if_stale(code, FUND_HISTORY_AUTO_REFRESH_ROWS)
            except Exception:
                pass
            summary = read_fund_return_summary_from_db(code)
            if summary:
                results[code] = summary
        return results

    return cached_json_response(cache_key, 5 * 60, build)


@app.get("/api/fundprofiles")
def fund_profiles() -> Response:
    enforce_rate_limit("fundprofiles")
    codes = require_fund_codes()
    results: dict[str, Any] = {}
    refresh = should_refresh()
    if refresh:
        enforce_rate_limit("fundprofiles_refresh")
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
    enforce_rate_limit("fundpurchase")
    codes = require_fund_codes()
    ttl_seconds = 6 * 60 * 60
    refresh = should_refresh()
    if refresh:
        enforce_rate_limit("fundpurchase_refresh")

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


@app.get("/api/fundbacktest")
def fund_backtest() -> Response:
    enforce_rate_limit("fundbacktest")
    codes = require_fund_codes()
    days = clamp_int(request.args.get("days", "90"), 20, 750, 90)
    refresh = should_refresh()
    if refresh:
        enforce_rate_limit("fundbacktest_refresh")
    results: dict[str, Any] = {}
    for code in codes:
        result = compute_fund_backtest(code, days, refresh=refresh)
        if result:
            results[code] = result
    return json_response(results)


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
    if source == "tencent-hk":
        return (
            f"https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param={quote(symbol)},day,,,1023",
            "https://gu.qq.com/",
        )
    raise ValueError("Unsupported source")


@app.get("/api/markethistory")
def market_history() -> Response:
    enforce_rate_limit("markethistory")
    source = require_arg("source")
    symbol = require_arg("symbol")
    if source not in {"sina-cn", "sina-us", "sina-futures", "tencent-hk"}:
        raise ValueError("Unsupported source")
    if not MARKET_HISTORY_SYMBOL_RE.fullmatch(symbol):
        raise ValueError("Invalid symbol")
    refresh = should_refresh()
    if refresh:
        enforce_rate_limit("markethistory_refresh")
    cached_rows = read_market_history_from_db(source, symbol)
    if not refresh:
        if cached_rows:
            auto_refresh_market_history_if_stale(source, symbol)
            return json_response(read_market_history_from_db(source, symbol) or cached_rows)
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
    enforce_rate_limit("marketreturns")
    items = request.args.get("items", "")
    normalized_items: list[str] = []
    for item in [part for part in items.split(",") if part]:
        pieces = item.split(":", 1)
        if len(pieces) != 2:
            continue
        source, symbol = pieces
        if source not in {"sina-cn", "sina-us", "sina-futures", "tencent-hk"}:
            continue
        if not MARKET_HISTORY_SYMBOL_RE.fullmatch(symbol):
            continue
        normalized_items.append(f"{source}:{symbol}")
    normalized_items = sorted(dict.fromkeys(normalized_items))
    cache_key = f"api:marketreturns:{','.join(normalized_items)}"

    def build() -> dict[str, Any]:
        results: dict[str, Any] = {}
        for item in normalized_items:
            source, symbol = item.split(":", 1)
            summary = read_market_return_summary_from_db(source, symbol)
            if summary:
                results[item] = summary
            if market_history_should_refresh_for_returns(source, symbol):
                schedule_market_history_refresh(source, symbol)
        return results

    return cached_json_response(cache_key, MARKET_RETURNS_CACHE_TTL_SECONDS, build)


def main() -> None:
    parser = argparse.ArgumentParser(description="Fund valuation Flask data backend")
    parser.add_argument("--host", default=os.environ.get("FUND_VALUATION_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("FUND_VALUATION_PORT", "8000")))
    parser.add_argument("--debug", action="store_true", default=os.environ.get("FLASK_DEBUG") == "1")
    args = parser.parse_args()

    ensure_storage()
    if os.environ.get("FUND_VALUATION_PREWARM", "1") != "0":
        with app.app_context():
            prewarm_response_cache()
    print(f"Flask backend listening on http://{args.host}:{args.port}")
    print(f"SQLite database: {DB_PATH}")
    app.run(host=args.host, port=args.port, debug=args.debug, threaded=True)


if __name__ == "__main__":
    main()
