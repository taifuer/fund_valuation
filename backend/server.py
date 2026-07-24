from __future__ import annotations

import argparse
import ast
import hashlib
import hmac
import html
import http.client
import json
import os
import re
import shutil
import socket
import sqlite3
import subprocess
import threading
import time
import uuid
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
from werkzeug.exceptions import Forbidden, HTTPException, TooManyRequests

from .config import (
    configured_fund_codes as universe_fund_codes,
    configured_market_return_items as universe_market_return_items,
    configured_sina_symbols as universe_sina_symbols,
    configured_unsupported_quote_symbols as universe_unsupported_quote_symbols,
    default_fund_holdings as universe_fund_holdings,
    quote_supported_symbol as universe_quote_supported_symbol,
)
from .quotes import normalize_quote_text
from .contracts import API_SCHEMA_VERSION, DASHBOARD_SCHEMA_VERSION, validate_dashboard_payload
from .observability import REQUEST_METRICS, log_event
from .fx_history import fx_history_summary, latest_fx_history_date, store_ecb_reference_rates
from .data_coverage import historical_data_coverage, missing_holding_requests
from .storage import DATA_DIR, DB_PATH, RAW_DIR, ROOT_DIR, SCHEMA_VERSION, get_conn, ensure_storage as ensure_database_storage


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
_FUND_NAV_REFRESHING: set[str] = set()
_FUND_NAV_REFRESH_GUARD = threading.Lock()
_FUND_HISTORY_REFRESHING: set[str] = set()
_FUND_HISTORY_REFRESH_GUARD = threading.Lock()
_FUND_PURCHASE_REFRESHING = False
_FUND_PURCHASE_REFRESH_GUARD = threading.Lock()
_FUND_PROFILE_REFRESHING: set[str] = set()
_FUND_PROFILE_REFRESH_GUARD = threading.Lock()
_UPSTREAM_HEALTH: dict[str, dict[str, Any]] = {}
_UPSTREAM_HEALTH_GUARD = threading.Lock()
_BACKGROUND_REFRESH_STATE: dict[str, Any] = {
    "started": False,
    "lastRunAt": 0,
    "lastSuccessAt": 0,
    "lastErrorAt": 0,
    "lastError": "",
    "runCount": 0,
}
_BACKGROUND_REFRESH_GUARD = threading.Lock()
_EASTMONEY_SESSION = requests.Session()
_EASTMONEY_SESSION.trust_env = False

FUND_CODE_RE = re.compile(r"^\d{6}$")
SINA_SYMBOL_RE = re.compile(r"^[A-Za-z0-9_]{1,40}$")
MARKET_HISTORY_SYMBOL_RE = re.compile(r"^[A-Za-z0-9_.-]{1,40}$")
CN_ETF_HISTORY_SYMBOL_RE = re.compile(r"^(?:sh5\d{5}|sz159\d{3})$")
MARKET_HISTORY_CORPORATE_ACTION_LOW_RATIO = 0.65
MARKET_HISTORY_CORPORATE_ACTION_HIGH_RATIO = 1 / MARKET_HISTORY_CORPORATE_ACTION_LOW_RATIO
MARKET_HISTORY_SOURCES = {"sina-cn", "sina-us", "sina-futures", "tencent-hk", "twse-official", "naver-korea"}
MAX_FUND_CODES_PER_REQUEST = 50
MAX_SINA_SYMBOLS_PER_REQUEST = 160
MAX_MARKET_STATE_SYMBOLS_PER_REQUEST = 160
MAX_FUND_HISTORY_REFRESH_ROWS = 3000
FUND_HISTORY_AUTO_REFRESH_ROWS = 80
FUND_HISTORY_UPSTREAM_PAGE_SIZE = 80
HISTORY_AUTO_REFRESH_TTL_MS = 30 * 60 * 1000
FUND_PROFILE_REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60
FUND_HOLDINGS_REFRESH_INTERVAL_SECONDS = 24 * 60 * 60
FUND_HOLDINGS_REFRESH_TTL_SECONDS = FUND_HOLDINGS_REFRESH_INTERVAL_SECONDS
FUND_HOLDINGS_REQUEST_DELAY_SECONDS = 0.25
FUND_HOLDINGS_MAX_AGE_DAYS = 550
MARKET_RETURNS_CACHE_TTL_SECONDS = 30 * 60
FUND_NAV_CACHE_TTL_SECONDS = 60
BACKGROUND_REFRESH_INTERVAL_SECONDS = int(os.environ.get("FUND_VALUATION_REFRESH_INTERVAL", "900"))
QUOTE_SNAPSHOT_RETENTION_DAYS = int(os.environ.get("FUND_VALUATION_SNAPSHOT_RETENTION_DAYS", "30"))
BACKGROUND_JOB_NAME = "data-refresh"


def fund_management_enabled() -> bool:
    value = os.environ.get("FUND_VALUATION_ENABLE_FUND_MANAGEMENT", "1").strip().lower()
    return value not in {"0", "false", "no", "off"}

RATE_LIMIT_RULES: dict[str, tuple[int, int]] = {
    "sina": (240, 60),
    "dashboard": (180, 60),
    "overview": (180, 60),
    "status": (120, 60),
    "meta": (120, 60),
    "datahealth": (120, 60),
    "diagnostics": (30, 60),
    "marketstates": (240, 60),
    "fundnav": (120, 60),
    "fundholdings": (80, 60),
    "fundholdings_refresh": (10, 60),
    "fundvaluationbasis": (120, 60),
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

BACKTEST_MODEL_VERSION = "quarterly_holdings_fx_v3"
EASTMONEY_GLOBAL_QUOTES: dict[str, tuple[str, str]] = {
    "int_nikkei": ("100.N225", "日经指数"),
}
EASTMONEY_SPOT_REPLACEMENT_SYMBOLS = {"int_nikkei"}
SINA_GLOBAL_FALLBACK_QUOTES: dict[str, tuple[str, str]] = {
    "int_nikkei": ("znb_NKY", "日经225"),
    "b_TWSE": ("znb_TWJQ", "台湾加权"),
}
FORCED_GLOBAL_REPLACEMENT_SYMBOLS = EASTMONEY_SPOT_REPLACEMENT_SYMBOLS | set(SINA_GLOBAL_FALLBACK_QUOTES)


def now_ms() -> int:
    return int(time.time() * 1000)


def beijing_today() -> str:
    return datetime.now(ZoneInfo("Asia/Shanghai")).date().isoformat()


def ensure_storage() -> None:
    ensure_database_storage()
    ensure_market_calendar_seeded()


# Holiday data is keyed by year. Add a new year block here when the year rolls
# over; unknown years fall back to an empty set (weekend-only detection), so the
# calendar degrades gracefully instead of breaking on Jan 1.
# Market holiday & half-day data is shipped as application configuration rather
# than runtime storage. Keeping it outside DATA_DIR prevents a database volume
# or custom FUND_VALUATION_DATA_DIR from hiding the calendar in production.
HOLIDAYS_FILE = Path(os.environ.get(
    "FUND_VALUATION_HOLIDAYS_FILE",
    ROOT_DIR / "config" / "holidays.json",
))
_HOLIDAYS_JSON_CACHE: dict[str, Any] | None = None
_HOLIDAYS_JSON_GUARD = threading.Lock()


def _load_holidays_json() -> dict[str, Any]:
    """Load and cache config/holidays.json. Returns {} if the file is missing or
    malformed (callers then degrade to weekend-only)."""
    global _HOLIDAYS_JSON_CACHE
    if _HOLIDAYS_JSON_CACHE is not None:
        return _HOLIDAYS_JSON_CACHE
    with _HOLIDAYS_JSON_GUARD:
        if _HOLIDAYS_JSON_CACHE is not None:
            return _HOLIDAYS_JSON_CACHE
        loaded: dict[str, Any] = {}
        try:
            text = HOLIDAYS_FILE.read_text(encoding="utf-8")
            data = json.loads(text)
            if isinstance(data, dict) and isinstance(data.get("years"), dict):
                loaded = data["years"]
        except (OSError, json.JSONDecodeError) as exc:
            print(f"[holidays] failed to load {HOLIDAYS_FILE}: {exc}", flush=True)
        _HOLIDAYS_JSON_CACHE = loaded
        return loaded


def _holidays_for(market: str, year: int) -> set[str]:
    raw = _load_holidays_json().get(str(year), {}).get(market, {})
    if not isinstance(raw, dict):
        return set()
    holidays = raw.get("holidays")
    return set(holidays) if isinstance(holidays, list) else set()


def _half_days_for(market: str, year: int) -> dict[str, list[tuple[str, str]]]:
    raw = _load_holidays_json().get(str(year), {}).get(market, {})
    if not isinstance(raw, dict):
        return {}
    half_days = raw.get("halfDays")
    if not isinstance(half_days, dict):
        return {}
    result: dict[str, list[tuple[str, str]]] = {}
    for date, sessions in half_days.items():
        if not isinstance(sessions, list):
            continue
        parsed: list[tuple[str, str]] = []
        for session in sessions:
            if isinstance(session, list) and len(session) == 2:
                parsed.append((str(session[0]), str(session[1])))
        if parsed:
            result[date] = parsed
    return result


MARKET_CALENDARS: dict[str, dict[str, Any]] = {
    "cn": {
        "timezone": "Asia/Shanghai",
        "sessions": [("09:30", "11:30"), ("13:00", "15:00")],
        "holidays": lambda year, m="cn": _holidays_for(m, year),
        "half_days": lambda year, m="cn": _half_days_for(m, year),
        "source": "SSE/SZSE holiday calendar",
    },
    "hk": {
        "timezone": "Asia/Hong_Kong",
        "sessions": [("09:30", "12:00"), ("13:00", "16:10")],
        "holidays": lambda year, m="hk": _holidays_for(m, year),
        "half_days": lambda year, m="hk": _half_days_for(m, year),
        "source": "HKEX calendar",
    },
    "us": {
        "timezone": "America/New_York",
        "sessions": [("09:30", "16:00")],
        "holidays": lambda year, m="us": _holidays_for(m, year),
        "half_days": lambda year, m="us": _half_days_for(m, year),
        "source": "NYSE/Nasdaq holiday calendar",
    },
    "jp": {
        "timezone": "Asia/Tokyo",
        "sessions": [("09:00", "11:30"), ("12:30", "15:30")],
        "holidays": lambda year, m="jp": _holidays_for(m, year),
        "half_days": lambda year, m="jp": _half_days_for(m, year),
        "source": "JPX market holidays",
    },
    "kr": {
        "timezone": "Asia/Seoul",
        "sessions": [("09:00", "15:30")],
        "holidays": lambda year, m="kr": _holidays_for(m, year),
        "half_days": lambda year, m="kr": _half_days_for(m, year),
        "source": "KRX trading days and holidays",
    },
    "tw": {
        "timezone": "Asia/Taipei",
        "sessions": [("09:00", "13:30")],
        "holidays": lambda year, m="tw": _holidays_for(m, year),
        "half_days": lambda year, m="tw": _half_days_for(m, year),
        "source": "TWSE/TAIFEX trading calendar",
    },
    "hk_futures": {
        "timezone": "Asia/Hong_Kong",
        "sessions": [("09:15", "12:00"), ("13:00", "16:30"), ("17:15", "03:00")],
        "holidays": lambda year, m="hk": _holidays_for(m, year),
        # Futures markets do NOT inherit equity half-day sessions (the old code
        # had no half_days key here); in_futures_sessions only treats status
        # 'open' as tradable, so an empty half_days map keeps them 'open'.
        "half_days": lambda year: {},
        "source": "HKEX derivatives calendar",
    },
    "jp_futures": {
        "timezone": "Asia/Tokyo",
        "sessions": [("07:30", "14:25"), ("14:55", "05:15")],
        "holidays": lambda year, m="jp": _holidays_for(m, year),
        "half_days": lambda year: {},
        "source": "JPX/OSE derivatives calendar",
    },
}


def is_weekend(dt: datetime) -> bool:
    return dt.weekday() >= 5


def ensure_market_calendar_seeded(year: int | None = None) -> None:
    # Seed both the current year and the next year so the calendar does not
    # expire on Jan 1. Unknown years degrade to weekend-only (empty holiday set).
    if year is None:
        current_year = datetime.now(ZoneInfo("Asia/Shanghai")).year
        for y in (current_year, current_year + 1):
            ensure_market_calendar_seeded(y)
        return

    start = datetime(year, 1, 1)
    end = datetime(year, 12, 31)
    fetched_at = now_ms()
    rows: list[tuple[str, str, str, str, str, str, int]] = []
    with get_conn() as conn:
        # Always upsert the inexpensive yearly calendar. Holiday corrections
        # must take effect for existing databases, not only fresh installs.
        for market, calendar in MARKET_CALENDARS.items():
            holidays = calendar["holidays"](year)
            half_days = calendar["half_days"](year)
            current = start
            while current <= end:
                day = current.strftime("%Y-%m-%d")
                sessions = half_days.get(day) or calendar["sessions"]
                if is_weekend(current):
                    status = "weekend"
                elif day in holidays:
                    status = "holiday"
                elif half_days.get(day):
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
    with get_conn() as conn:
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


def quote_date_is_usable(symbol: str, quote_date: str, now: datetime | None = None) -> bool:
    """Accept the expected session date or its latest official previous close."""
    current = now or datetime.now(ZoneInfo("Asia/Shanghai"))
    expected_date = expected_quote_date_for_symbol(symbol, current)
    if not expected_date or quote_date >= expected_date:
        return True
    market = market_key_for_symbol(symbol)
    if not market or market not in MARKET_CALENDARS:
        return False
    calendar = MARKET_CALENDARS[market]
    local = current.astimezone(ZoneInfo(str(calendar["timezone"])))
    return quote_date == previous_trading_day(market, local)


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
        return {"symbol": symbol, "market": "", "state": "closed", "source": "unknown", "lastTradingDay": None}
    if market == "crypto":
        return {"symbol": symbol, "market": market, "state": "live", "source": "continuous crypto market", "lastTradingDay": None}
    if market == "us_futures":
        return {"symbol": symbol, "market": market, "state": us_futures_state(now), "source": "CME Globex session rule", "lastTradingDay": None}

    calendar = MARKET_CALENDARS[market]
    local = now.astimezone(ZoneInfo(str(calendar["timezone"])))
    local_day = local.strftime("%Y-%m-%d")
    beijing_day = now.astimezone(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d")
    # The UI uses Beijing time throughout. During the one-hour KR/JP rollover
    # window, keep the Beijing calendar day's close/holiday status instead of
    # prematurely labeling the market as next-day weekend.
    day = beijing_day if local_day > beijing_day else local_day
    # The most recent trading day the symbol's quote could reflect: today if
    # the market is open/half-day (and past the first session start), else the
    # previous trading day. Frontends use this to date quotes from sources that
    # omit the date (e.g. Sina int_nikkei) instead of stamping them "today".
    last_trading_day = expected_quote_date_for_symbol(symbol, local)

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
            "lastTradingDay": last_trading_day,
        }

    row = market_calendar_row(market, day)
    if not row:
        return {"symbol": symbol, "market": market, "date": day, "state": "closed", "source": str(calendar["source"]), "lastTradingDay": last_trading_day}
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
        "lastTradingDay": last_trading_day,
    }


def cache_get(cache_key: str, max_age_seconds: int) -> tuple[int, str, bytes] | None:
    with get_conn() as conn:
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
    with get_conn() as conn:
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


def record_upstream_health(
    *,
    cache_key: str,
    kind: str,
    url: str,
    source: str,
    status: int | None = None,
    error: str = "",
) -> None:
    now = now_ms()
    key = cache_key
    with _UPSTREAM_HEALTH_GUARD:
        previous = _UPSTREAM_HEALTH.get(key, {})
        failure_count = int(previous.get("failureCount", 0) or 0)
        if error or source == "error":
            failure_count += 1
        elif source in {"network", "cache"}:
            failure_count = 0

        _UPSTREAM_HEALTH[key] = {
            "key": key,
            "kind": kind,
            "cacheKey": cache_key,
            "url": url,
            "source": source,
            "status": status,
            "error": error[:240],
            "failureCount": failure_count,
            "lastSeenAt": now,
            "lastSuccessAt": now if source in {"network", "cache"} and not error else previous.get("lastSuccessAt", 0),
            "lastStaleAt": now if source == "stale" else previous.get("lastStaleAt", 0),
            "lastFallbackAt": now if source == "fallback" else previous.get("lastFallbackAt", 0),
            "lastErrorAt": now if error or source == "error" else previous.get("lastErrorAt", 0),
        }

        if len(_UPSTREAM_HEALTH) > 240:
            oldest = sorted(_UPSTREAM_HEALTH.items(), key=lambda item: int(item[1].get("lastSeenAt", 0)))[:40]
            for old_key, _ in oldest:
                _UPSTREAM_HEALTH.pop(old_key, None)


def record_quote_health(symbol: str, source: str, message: str = "") -> None:
    record_upstream_health(
        cache_key=f"quote:{symbol}",
        kind="quote",
        url=f"sina:{symbol}",
        source=source,
        status=200 if source == "fallback" else None,
        error=message,
    )


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
            record_upstream_health(cache_key=cache_key, kind=kind, url=url, source="cache", status=cached[0])
            return cached

    lock = upstream_lock(cache_key)
    with lock:
        if not force_refresh:
            cached = cache_get(cache_key, ttl_seconds)
            if cached:
                record_upstream_health(cache_key=cache_key, kind=kind, url=url, source="cache", status=cached[0])
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
            record_upstream_health(cache_key=cache_key, kind=kind, url=url, source="network", status=status)
            return status, resolved_content_type, body
        except (URLError, OSError, socket.timeout, http.client.IncompleteRead, http.client.HTTPException) as exc:
            # Broaden beyond URLError so mid-body read timeouts / truncations
            # also fall back to stale cache instead of escaping as a 502.
            stale = cache_any(cache_key)
            if stale:
                record_upstream_health(
                    cache_key=cache_key,
                    kind=kind,
                    url=url,
                    source="stale",
                    status=stale[0],
                    error=str(exc),
                )
                return stale
            record_upstream_health(cache_key=cache_key, kind=kind, url=url, source="error", error=str(exc))
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
    allow_stale_cache: bool = True,
) -> dict[str, Any] | None:
    cached = cache_get(cache_key, ttl_seconds)
    if cached:
        record_upstream_health(cache_key=cache_key, kind=kind, url=url, source="cache", status=cached[0])
        try:
            return json.loads(decode_body(cached[2]))
        except json.JSONDecodeError as exc:
            record_upstream_health(cache_key=cache_key, kind=kind, url=url, source="error", status=cached[0], error=str(exc))
            return None

    lock = upstream_lock(cache_key)
    with lock:
        cached = cache_get(cache_key, ttl_seconds)
        if cached:
            record_upstream_health(cache_key=cache_key, kind=kind, url=url, source="cache", status=cached[0])
            try:
                return json.loads(decode_body(cached[2]))
            except json.JSONDecodeError as exc:
                record_upstream_health(cache_key=cache_key, kind=kind, url=url, source="error", status=cached[0], error=str(exc))
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
                stale = cache_any(cache_key) if allow_stale_cache else None
                if stale:
                    record_upstream_health(
                        cache_key=cache_key,
                        kind=kind,
                        url=url,
                        source="stale",
                        status=stale[0],
                        error=f"HTTP {status}",
                    )
                    return json.loads(decode_body(stale[2]))
                record_upstream_health(cache_key=cache_key, kind=kind, url=url, source="error", status=status, error=f"HTTP {status}")
                return None
            cache_put(cache_key, url, status, content_type, body)
            write_raw(kind, cache_key, body)
            record_upstream_health(cache_key=cache_key, kind=kind, url=url, source="network", status=status)
            return json.loads(decode_body(body))
        except (requests.RequestException, subprocess.SubprocessError, json.JSONDecodeError, OSError) as exc:
            stale = cache_any(cache_key) if allow_stale_cache else None
            if stale:
                try:
                    record_upstream_health(
                        cache_key=cache_key,
                        kind=kind,
                        url=url,
                        source="stale",
                        status=stale[0],
                        error=str(exc),
                    )
                    return json.loads(decode_body(stale[2]))
                except json.JSONDecodeError as stale_exc:
                    record_upstream_health(
                        cache_key=cache_key,
                        kind=kind,
                        url=url,
                        source="error",
                        status=stale[0],
                        error=str(stale_exc),
                    )
                    return None
            record_upstream_health(cache_key=cache_key, kind=kind, url=url, source="error", error=str(exc))
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
    date_index = next(
        (index for index in range(4, len(fields)) if re.match(r"^\d{4}-\d{2}-\d{2}$", fields[index])),
        -1,
    )
    date = fields[date_index] if date_index >= 0 else ""
    if not date:
        return None
    if not quote_date_is_usable(symbol, date):
        return None
    time_text = fields[date_index + 1] if date_index + 1 < len(fields) and re.match(r"^\d{1,2}:\d{2}(?::\d{2})?$", fields[date_index + 1]) else ""
    timestamp = f",{date},{time_text}" if time_text else f",{date}"
    return f'var hq_str_{symbol}="{fallback_name},{price:.2f},{change:.2f},{change_percent:.2f}{timestamp}";'


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
        allow_stale_cache=False,
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
            date = updated_at.date().isoformat()
            time_text = updated_at.strftime("%H:%M:%S")
            expected_date = expected_quote_date_for_symbol(symbol)
            if expected_date and quote_date_is_usable(symbol, date):
                name = str(data.get("f58") or fallback_name)
                return f'var hq_str_{symbol}="{name},{price:.2f},{change:.2f},{change_percent:.2f},{date},{time_text}";'
            if not expected_date and abs((datetime.now(ZoneInfo("Asia/Shanghai")) - updated_at).days) <= 7:
                name = str(data.get("f58") or fallback_name)
                return f'var hq_str_{symbol}="{name},{price:.2f},{change:.2f},{change_percent:.2f},{date},{time_text}";'

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
        allow_stale_cache=False,
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
    if expected_date and not quote_date_is_usable(symbol, date):
        return None
    if not expected_date and abs((datetime.now(ZoneInfo("Asia/Shanghai")).date() - datetime.fromisoformat(date).date()).days) > 7:
        return None
    name = str(data.get("name") or fallback_name) if isinstance(data, dict) else fallback_name
    return f'var hq_str_{symbol}="{name},{price:.2f},{change:.2f},{change_percent:.2f},{date}";'


def append_eastmoney_global_quotes(text: str, symbols: list[str]) -> str:
    requested = set(symbols)
    replacements: dict[str, str] = {}
    for symbol in sorted(set(symbols)):
        line = None
        if symbol in EASTMONEY_SPOT_REPLACEMENT_SYMBOLS:
            try:
                line = eastmoney_global_quote_line(symbol)
            except Exception:
                line = None
        if not line:
            try:
                line = sina_global_fallback_quote_line(symbol)
            except Exception:
                line = None
        if line:
            replacements[symbol] = line
            record_quote_health(symbol, "fallback", "replaced unreliable global spot quote")

    dropped_bad_spot_symbols = requested & FORCED_GLOBAL_REPLACEMENT_SYMBOLS
    lines: list[str] = []
    for line in text.rstrip().splitlines():
        match = re.match(r'^var\s+hq_str_(\w+)="', line.strip())
        existing_symbol = match.group(1) if match else ""
        if existing_symbol in replacements or existing_symbol in dropped_bad_spot_symbols:
            continue
        if line.strip():
            lines.append(line.rstrip())

    for symbol in sorted(replacements):
        lines.append(replacements[symbol])
    for symbol in sorted(dropped_bad_spot_symbols - set(replacements)):
        record_quote_health(symbol, "error", "unreliable global spot quote dropped without fallback")
    return "\n".join(line for line in lines if line) + ("\n" if lines else "")


def sina_cn_history_symbol(symbol: str) -> str | None:
    if re.match(r"^s_(sh|sz)\d{6}$", symbol):
        return symbol[2:]
    if re.match(r"^(sh|sz)\d{6}$", symbol):
        return symbol
    return None


def latest_cn_history_quote_line(
    symbol: str,
    name: str,
    *,
    stock_style: bool,
    as_of: str | None = None,
) -> str | None:
    history_symbol = sina_cn_history_symbol(symbol)
    if not history_symbol:
        return None
    rows = read_market_history_from_db("sina-cn", history_symbol)
    points = [
        (str(row["date"]), float(row["close"]))
        for row in rows
        if float(row["close"]) > 0 and (as_of is None or str(row["date"]) <= as_of)
    ]
    if not points:
        return None
    end_date, end_close = points[-1]
    start_close = points[-2][1] if len(points) >= 2 else end_close
    change = end_close - start_close if start_close > 0 else 0.0
    return_percent = change / start_close * 100 if start_close > 0 else 0.0
    if not stock_style:
        return f'var hq_str_{symbol}="{name},{end_close:.4f},{change:.4f},{return_percent:.2f},0,0,{end_date}";'

    fields = [
        name,
        f"{end_close:.4f}",
        f"{start_close if start_close > 0 else end_close:.4f}",
        f"{end_close:.4f}",
        f"{end_close:.4f}",
        f"{end_close:.4f}",
        f"{end_close:.4f}",
        f"{end_close:.4f}",
        "0",
        "0.000",
    ]
    while len(fields) < 30:
        fields.extend(["0", f"{end_close:.4f}"])
    fields = fields[:30]
    fields.extend([end_date, "15:00:00", "00"])
    return f'var hq_str_{symbol}="{",".join(fields)}";'


def safe_float(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result


def raw_sina_cn_price(symbol: str, fields: list[str]) -> float | None:
    if symbol.startswith("s_"):
        if len(fields) < 4:
            return None
        return safe_float(fields[1])
    if re.match(r"^(sh|sz)\d{6}$", symbol):
        if len(fields) < 10:
            return None
        return safe_float(fields[3])
    return None


def is_cn_index_quote_symbol(symbol: str) -> bool:
    return re.match(r"^(?:s_)?(?:sh000|sz399)\d{3}$", symbol) is not None


def cn_index_preopen_phase(now: datetime) -> str | None:
    local = now.astimezone(ZoneInfo("Asia/Shanghai"))
    row = market_calendar_row("cn", local.strftime("%Y-%m-%d"))
    if not row or row["status"] not in {"open", "half_day"}:
        return None
    minutes = local.hour * 60 + local.minute
    if minutes < 9 * 60 + 15:
        return "before_auction"
    if minutes < 9 * 60 + 30:
        return "auction"
    return None


def is_current_cn_index_auction_quote(symbol: str, fields: list[str], now: datetime) -> bool:
    # Compact s_ index quotes have no timestamp or independent previous-close
    # field, so they cannot be proven to represent today's call auction.
    if symbol.startswith("s_") or len(fields) < 10:
        return False
    previous_close = safe_float(fields[2])
    price = safe_float(fields[3])
    if not previous_close or previous_close <= 0 or not price or price <= 0:
        return False
    if abs((price - previous_close) / previous_close * 100) > 25:
        return False
    quote_date = ""
    quote_time = ""
    for index in range(len(fields) - 1, max(19, len(fields) - 12), -1):
        if re.match(r"^\d{4}-\d{2}-\d{2}$", fields[index]):
            quote_date = fields[index]
            quote_time = fields[index + 1] if index + 1 < len(fields) else ""
            break
    local = now.astimezone(ZoneInfo("Asia/Shanghai"))
    if quote_date != local.strftime("%Y-%m-%d"):
        return False
    try:
        quote_minutes = parse_hhmm(quote_time[:5])
    except (TypeError, ValueError):
        return False
    return 9 * 60 + 15 <= quote_minutes < 9 * 60 + 30


def sanitize_cn_quote_line(
    line: str,
    now: datetime,
    preopen_phase: str | None = None,
    previous_date: str | None = None,
) -> str | None:
    match = re.match(r'^var\s+hq_str_(\w+)="([^"]*)"', line.strip())
    if not match:
        return line if line.strip() else None
    symbol = match.group(1)
    fields = match.group(2).split(",")
    name = fields[0] if fields and fields[0] else symbol
    stock_style = re.match(r"^(sh|sz)\d{6}$", symbol) is not None

    if is_cn_index_quote_symbol(symbol):
        if preopen_phase == "before_auction" or (
            preopen_phase == "auction" and not is_current_cn_index_auction_quote(symbol, fields, now)
        ):
            replacement = latest_cn_history_quote_line(
                symbol,
                name,
                stock_style=stock_style,
                as_of=previous_date,
            )
            if replacement:
                return replacement

    price = raw_sina_cn_price(symbol, fields)
    if price is None or price > 0:
        return line.rstrip()

    replacement = latest_cn_history_quote_line(symbol, name, stock_style=stock_style)
    if replacement:
        record_quote_health(symbol, "fallback", "zero-price quote replaced with latest historical close")
        return replacement

    if stock_style and len(fields) >= 3:
        previous_close = safe_float(fields[2])
        if previous_close and previous_close > 0:
            fallback_fields = fields[:]
            fallback_fields[1] = f"{previous_close:.4f}"
            fallback_fields[3] = f"{previous_close:.4f}"
            if len(fallback_fields) > 4:
                fallback_fields[4] = f"{previous_close:.4f}"
            if len(fallback_fields) > 5:
                fallback_fields[5] = f"{previous_close:.4f}"
            record_quote_health(symbol, "fallback", "zero-price quote replaced with previous close")
            return f'var hq_str_{symbol}="{",".join(fallback_fields)}";'
    record_quote_health(symbol, "error", "zero-price quote without fallback")
    return line.rstrip()


def sanitize_sina_quote_text(text: str, symbols: list[str], now: datetime | None = None) -> str:
    text = append_eastmoney_global_quotes(text, symbols)
    current = now or datetime.now(ZoneInfo("Asia/Shanghai"))
    preopen_phase = None
    previous_date = None
    if any(is_cn_index_quote_symbol(symbol) for symbol in symbols):
        ensure_market_calendar_seeded()
        preopen_phase = cn_index_preopen_phase(current)
        if preopen_phase:
            previous_date = previous_trading_day("cn", current.astimezone(ZoneInfo("Asia/Shanghai")))
    seen_symbols: set[str] = set()
    lines = [
        sanitized
        for line in text.rstrip().splitlines()
        if (sanitized := sanitize_cn_quote_line(line, current, preopen_phase, previous_date))
    ]
    for line in lines:
        if match := re.match(r'^var\s+hq_str_(\w+)="', line.strip()):
            seen_symbols.add(match.group(1))
    for symbol in sorted(set(symbols) - seen_symbols):
        record_quote_health(symbol, "error", "missing quote line from upstream response")
    return "\n".join(lines) + ("\n" if lines else "")


def quote_lines_by_symbol(text: str) -> dict[str, str]:
    lines: dict[str, str] = {}
    for line in text.splitlines():
        match = re.match(r'^var\s+hq_str_(\w+)="', line.strip())
        if match:
            lines[match.group(1)] = line.strip()
    return lines


def quote_snapshot_bucket(now: datetime) -> int:
    local = now.astimezone(ZoneInfo("Asia/Shanghai"))
    minutes = local.hour * 60 + local.minute
    key_window = (
        9 * 60 <= minutes <= 9 * 60 + 35
        or 11 * 60 + 25 <= minutes <= 13 * 60 + 5
        or 14 * 60 + 50 <= minutes <= 15 * 60 + 10
    )
    bucket_seconds = 5 * 60 if key_window else 15 * 60
    timestamp = int(now.timestamp())
    return timestamp - timestamp % bucket_seconds


def parse_quote_snapshot_line(symbol: str, line: str) -> tuple[float | None, float | None, float | None, str]:
    match = re.match(r'^var\s+hq_str_\w+="([^"]*)"', line)
    if not match:
        return None, None, None, ""
    fields = match.group(1).split(",")
    price: float | None = None
    previous_close: float | None = None
    change_percent: float | None = None
    if symbol.startswith("s_") and len(fields) >= 4:
        price = safe_float(fields[1])
        change = safe_float(fields[2])
        change_percent = safe_float(fields[3])
        previous_close = price - change if price is not None and change is not None else None
    elif re.match(r"^(sh|sz)\d{6}$", symbol) and len(fields) >= 4:
        previous_close = safe_float(fields[2])
        price = safe_float(fields[3])
    elif symbol.startswith("gb_") and len(fields) >= 3:
        price = safe_float(fields[1])
        change_percent = safe_float(fields[2])
        previous_close = safe_float(fields[26]) if len(fields) > 26 else None
    elif symbol.startswith("hk") and len(fields) >= 9:
        previous_close = safe_float(fields[3])
        price = safe_float(fields[6])
        change_percent = safe_float(fields[8])
    elif symbol.startswith("hf_") and len(fields) >= 9:
        price = safe_float(fields[0])
        previous_close = safe_float(fields[7]) or safe_float(fields[8])
    elif (symbol.startswith("int_") or symbol.startswith("b_")) and len(fields) >= 4:
        price = safe_float(fields[1])
        change = safe_float(fields[2])
        change_percent = safe_float(fields[3])
        previous_close = price - change if price is not None and change is not None else None
    elif symbol == "fx_sbtcusd" and len(fields) >= 12:
        price = safe_float(fields[1])
        change = safe_float(fields[11])
        change_percent = safe_float(fields[10])
        previous_close = price - change if price is not None and change is not None else None

    if change_percent is None and price is not None and previous_close and previous_close > 0:
        change_percent = (price - previous_close) / previous_close * 100

    quote_date = next((field for field in reversed(fields) if re.match(r"^\d{4}[-/]\d{2}[-/]\d{2}$", field)), "")
    quote_time = ""
    if quote_date:
        index = fields.index(quote_date)
        candidate = fields[index + 1] if index + 1 < len(fields) else ""
        quote_time = f"{quote_date.replace('/', '-')} {candidate}".strip()
    elif symbol.startswith("gb_") and len(fields) > 3:
        quote_time = fields[3]
    return price, previous_close, change_percent, quote_time


def snapshot_validation(
    symbol: str,
    price: float | None,
    previous_close: float | None,
    change_percent: float | None,
    quote_time: str,
    state: dict[str, Any],
) -> tuple[str, str]:
    if price is None or price <= 0:
        return "error", "missing or non-positive price"
    if previous_close is None or previous_close <= 0:
        return "error", "missing or non-positive previous close"
    if change_percent is None or abs(change_percent) > 120:
        return "error", "invalid change percent"
    quote_date = quote_time[:10] if re.match(r"^\d{4}-\d{2}-\d{2}", quote_time) else ""
    last_trading_day = str(state.get("lastTradingDay") or "")
    if quote_date and last_trading_day and quote_date < last_trading_day:
        return "stale", f"quote date {quote_date} before {last_trading_day}"
    return "ok", ""


def store_quote_snapshots(
    raw_text: str,
    sanitized_text: str,
    symbols: list[str],
    states: dict[str, dict[str, Any]],
    now: datetime,
) -> int:
    raw_lines = quote_lines_by_symbol(raw_text)
    sanitized_lines = quote_lines_by_symbol(sanitized_text)
    bucket_at = quote_snapshot_bucket(now) * 1000
    captured_at = int(now.timestamp() * 1000)
    rows: list[tuple[Any, ...]] = []
    for symbol in symbols:
        raw_line = raw_lines.get(symbol, "")
        sanitized_line = sanitized_lines.get(symbol, "")
        price, previous_close, change_percent, quote_time = parse_quote_snapshot_line(symbol, sanitized_line)
        state = states.get(symbol, {})
        validation_status, validation_message = snapshot_validation(
            symbol, price, previous_close, change_percent, quote_time, state,
        )
        source = "upstream"
        if not raw_line and sanitized_line:
            source = "fallback"
        elif raw_line and raw_line != sanitized_line:
            source = "normalized"
        rows.append((
            symbol, bucket_at, captured_at, quote_time, str(state.get("state") or "unknown"), source,
            price, previous_close, change_percent, validation_status, validation_message,
            raw_line, sanitized_line,
        ))
    if not rows:
        return 0
    with get_conn() as conn:
        conn.executemany(
            """
            INSERT INTO market_quote_snapshots(
              symbol, bucket_at, captured_at, quote_time, market_state, source,
              price, previous_close, change_percent, validation_status,
              validation_message, raw_line, sanitized_line
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(symbol, bucket_at) DO UPDATE SET
              captured_at = excluded.captured_at,
              quote_time = excluded.quote_time,
              market_state = excluded.market_state,
              source = excluded.source,
              price = excluded.price,
              previous_close = excluded.previous_close,
              change_percent = excluded.change_percent,
              validation_status = excluded.validation_status,
              validation_message = excluded.validation_message,
              raw_line = excluded.raw_line,
              sanitized_line = excluded.sanitized_line
            """,
            rows,
        )
    return len(rows)


def prune_quote_snapshots(retention_days: int = QUOTE_SNAPSHOT_RETENTION_DAYS) -> int:
    cutoff = now_ms() - max(retention_days, 1) * 24 * 60 * 60 * 1000
    with get_conn() as conn:
        cursor = conn.execute("DELETE FROM market_quote_snapshots WHERE captured_at < ?", (cutoff,))
    return max(int(cursor.rowcount), 0)


def read_latest_quote_snapshot_text(
    symbols: list[str],
    max_age_seconds: int | None = None,
    max_age_by_symbol: dict[str, int] | None = None,
) -> tuple[str, list[str]]:
    normalized = sorted(dict.fromkeys(symbols))
    if not normalized:
        return "", []
    placeholders = ",".join("?" for _ in normalized)
    with get_conn() as conn:
        rows = conn.execute(
            f"""
            SELECT snapshot.symbol, snapshot.sanitized_line, snapshot.captured_at
            FROM market_quote_snapshots AS snapshot
            JOIN (
              SELECT symbol, MAX(bucket_at) AS bucket_at
              FROM market_quote_snapshots
              WHERE symbol IN ({placeholders})
              GROUP BY symbol
            ) AS latest
              ON latest.symbol = snapshot.symbol AND latest.bucket_at = snapshot.bucket_at
            """,
            normalized,
        ).fetchall()
    current_ms = now_ms()
    lines: dict[str, str] = {}
    for symbol, line, captured_at in rows:
        normalized_symbol = str(symbol)
        age_limit = (max_age_by_symbol or {}).get(normalized_symbol, max_age_seconds or 0)
        cutoff = current_ms - age_limit * 1000 if age_limit else 0
        if str(line) and (not cutoff or int(captured_at) >= cutoff):
            lines[normalized_symbol] = str(line)
    text = "\n".join(lines[symbol] for symbol in normalized if symbol in lines)
    return text + ("\n" if text else ""), [symbol for symbol in normalized if symbol not in lines]


def quote_snapshot_max_age_seconds(symbol: str, state: dict[str, Any]) -> int:
    market = market_key_for_symbol(symbol)
    current_state = str(state.get("state") or "closed")
    if current_state == "live":
        if market in {"us_futures", "hk_futures", "jp_futures"}:
            return 3 * 60
        if market == "crypto":
            return 6 * 60
        return 2 * 60
    if current_state == "break":
        return 6 * 60
    return 20 * 60


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
    with get_conn() as conn:
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


def store_fund_profile(code: str, profile: dict[str, str]) -> None:
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO fund_profiles(
              code, inception_date, asset_scale, scale_date,
              management_fee, custodian_fee, sales_service_fee, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(code) DO UPDATE SET
              inception_date = excluded.inception_date,
              asset_scale = excluded.asset_scale,
              scale_date = excluded.scale_date,
              management_fee = excluded.management_fee,
              custodian_fee = excluded.custodian_fee,
              sales_service_fee = excluded.sales_service_fee,
              fetched_at = excluded.fetched_at
            """,
            (
                code,
                profile.get("inceptionDate", ""),
                profile.get("assetScale", ""),
                profile.get("scaleDate", ""),
                profile.get("managementFee", ""),
                profile.get("custodianFee", ""),
                profile.get("salesServiceFee", ""),
                now_ms(),
            ),
        )


def read_fund_profiles_from_db(
    codes: list[str],
    max_age_seconds: int | None = None,
) -> dict[str, dict[str, Any]]:
    if not codes:
        return {}
    placeholders = ",".join("?" for _ in codes)
    with get_conn() as conn:
        rows = conn.execute(
            f"""
            SELECT code, inception_date, asset_scale, scale_date,
                   management_fee, custodian_fee, sales_service_fee, fetched_at
            FROM fund_profiles
            WHERE code IN ({placeholders})
            """,
            tuple(codes),
        ).fetchall()
    min_fetched_at = now_ms() - max_age_seconds * 1000 if max_age_seconds is not None else None
    results: dict[str, dict[str, Any]] = {}
    for row in rows:
        code, inception_date, asset_scale, scale_date, management_fee, custodian_fee, sales_service_fee, fetched_at = row
        if min_fetched_at is not None and int(fetched_at) < min_fetched_at:
            continue
        results[str(code)] = {
            "inceptionDate": str(inception_date),
            "assetScale": str(asset_scale),
            "scaleDate": str(scale_date),
            "managementFee": str(management_fee),
            "custodianFee": str(custodian_fee),
            "salesServiceFee": str(sales_service_fee),
            "fetchedAt": int(fetched_at),
        }
    return results


def fetch_and_store_fund_profile(code: str, *, force_refresh: bool = False) -> dict[str, Any] | None:
    status, _, body = fetch_upstream(
        f"https://fundf10.eastmoney.com/jbgk_{quote(code)}.html",
        referer="https://fundf10.eastmoney.com/",
        content_type="text/html; charset=utf-8",
        cache_key=f"fundprofile:{code}",
        kind="fundprofile",
        ttl_seconds=FUND_PROFILE_REFRESH_TTL_SECONDS,
        force_refresh=force_refresh,
    )
    if status >= 400:
        return None
    profile = parse_fund_profile(decode_body(body))
    if not profile or not profile.get("inceptionDate"):
        return None
    store_fund_profile(code, profile)
    return read_fund_profiles_from_db([code]).get(code)


def refresh_fund_profiles(
    codes: list[str] | None = None,
    *,
    force_refresh: bool = False,
) -> dict[str, Any]:
    fund_codes = sorted(dict.fromkeys(codes or configured_fund_codes_from_constants()))
    fresh = {} if force_refresh else read_fund_profiles_from_db(fund_codes, FUND_PROFILE_REFRESH_TTL_SECONDS)
    pending = [code for code in fund_codes if code not in fresh]
    updated = 0
    errors: list[str] = []
    for code in pending:
        try:
            updated += int(fetch_and_store_fund_profile(code, force_refresh=force_refresh) is not None)
        except Exception as exc:
            errors.append(f"{code}: {exc}")
    return {"checked": len(fund_codes), "updated": updated, "errors": errors}


def schedule_fund_profile_refresh(codes: list[str], *, force_refresh: bool = False) -> None:
    normalized_codes = sorted(dict.fromkeys(codes))
    with _FUND_PROFILE_REFRESH_GUARD:
        pending = [code for code in normalized_codes if code not in _FUND_PROFILE_REFRESHING]
        _FUND_PROFILE_REFRESHING.update(pending)
    if not pending:
        return

    def refresh() -> None:
        try:
            with app.app_context():
                result = refresh_fund_profiles(pending, force_refresh=force_refresh)
                if result["errors"]:
                    print(f"[fundprofile-refresh] {'; '.join(result['errors'][:5])}", flush=True)
        finally:
            with _FUND_PROFILE_REFRESH_GUARD:
                _FUND_PROFILE_REFRESHING.difference_update(pending)

    threading.Thread(target=refresh, name="fundprofile-refresh", daemon=True).start()


def fetch_fund_history_page(code: str, page_index: int, page_size: int, *, refresh: bool) -> tuple[list[dict[str, Any]], int | None]:
    upstream_page_size = min(max(page_size, 2), FUND_HISTORY_UPSTREAM_PAGE_SIZE)
    query = urlencode(
        {
            "callback": "jQuery",
            "fundCode": code,
            "pageIndex": page_index,
            "pageSize": upstream_page_size,
            "_": int(time.time() * 1000),
        }
    )
    url = f"https://api.fund.eastmoney.com/f10/lsjz?{query}"
    status, _, body = fetch_upstream(
        url,
        referer="https://fund.eastmoney.com/",
        content_type="text/plain; charset=utf-8",
        cache_key=f"fundhistory:{code}:{page_index}:{upstream_page_size}",
        kind="fundhistory",
        ttl_seconds=120,
        force_refresh=refresh,
    )
    if status < 400:
        rows, total_count = parse_fund_history_api(decode_body(body))
        if rows:
            return rows, total_count

    legacy_query = urlencode({"type": "lsjz", "code": code, "page": page_index, "per": upstream_page_size})
    legacy_url = f"https://fundf10.eastmoney.com/F10DataApi.aspx?{legacy_query}"
    status, _, body = fetch_upstream(
        legacy_url,
        referer=f"https://fundf10.eastmoney.com/jjjz_{quote(code)}.html",
        content_type="text/plain; charset=utf-8",
        cache_key=f"fundhistory-legacy:{code}:{page_index}:{upstream_page_size}",
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
    with get_conn() as conn:
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


def recent_trading_days(market: str, *, before: datetime, count: int) -> list[str]:
    days: list[str] = []
    candidate = before
    for _ in range(21):
        candidate -= timedelta(days=1)
        row = market_calendar_row(market, candidate.strftime("%Y-%m-%d"))
        if row and row["status"] in {"open", "half_day"}:
            days.append(str(row["date"]))
            if len(days) >= count:
                break
    return days


def fund_history_is_stale(latest_date: str | None, now: datetime | None = None) -> bool:
    if not latest_date:
        return True
    current = now or datetime.now(ZoneInfo("Asia/Shanghai"))
    # QDII NAV disclosure commonly trails the valuation day by one session.
    # Treat the second previous mainland session as the oldest healthy date.
    recent = recent_trading_days("cn", before=current, count=2)
    return bool(recent) and latest_date < recent[-1]


def market_history_quote_symbol(source: str, symbol: str) -> str | None:
    if source == "sina-cn":
        return symbol
    if source == "sina-us":
        return f"gb_{symbol.lstrip('.').lower()}"
    if source == "tencent-hk":
        return symbol
    if source == "naver-korea":
        return "b_KOSPI"
    if source == "twse-official":
        return "b_TWSE"
    if source == "sina-futures":
        if symbol == "NK":
            return "int_nikkei"
        return f"hf_{symbol}"
    return None


def latest_completed_trading_day(symbol: str, now: datetime | None = None) -> str | None:
    market = market_key_for_symbol(symbol)
    if not market or market not in MARKET_CALENDARS:
        return None
    current = now or datetime.now(ZoneInfo("Asia/Shanghai"))
    calendar = MARKET_CALENDARS[market]
    local = current.astimezone(ZoneInfo(str(calendar["timezone"])))
    day = local.strftime("%Y-%m-%d")
    row = market_calendar_row(market, day)
    if row and row["status"] in {"open", "half_day"}:
        regular_ends = [
            parse_hhmm(str(end))
            for start, end in row["sessions"]
            if parse_hhmm(str(start)) < parse_hhmm(str(end))
        ]
        if regular_ends and local.hour * 60 + local.minute >= max(regular_ends):
            return day
    return previous_trading_day(market, local)


def market_history_is_stale(source: str, symbol: str, latest_date: str | None, now: datetime | None = None) -> bool:
    if not latest_date:
        return True
    quote_symbol = market_history_quote_symbol(source, symbol)
    expected = latest_completed_trading_day(quote_symbol, now) if quote_symbol else None
    return bool(expected) and latest_date < expected


def auto_refresh_fund_history_if_stale(code: str, target_count: int) -> None:
    latest_date, fetched_at = latest_fund_history_meta(code)
    if not history_needs_auto_refresh(latest_date, fetched_at):
        return
    fetch_and_store_fund_history(
        code,
        min(max(target_count, 2), FUND_HISTORY_AUTO_REFRESH_ROWS),
        refresh=True,
    )


def fund_history_should_refresh_for_overview(code: str) -> bool:
    latest_date, fetched_at = latest_fund_history_meta(code)
    return not latest_date or history_needs_auto_refresh(latest_date, fetched_at)


def schedule_fund_history_refresh(codes: list[str], target_count: int) -> None:
    normalized_codes = sorted(dict.fromkeys(codes))
    if not normalized_codes:
        return
    refresh_key = ",".join(normalized_codes)
    with _FUND_HISTORY_REFRESH_GUARD:
        if refresh_key in _FUND_HISTORY_REFRESHING:
            return
        _FUND_HISTORY_REFRESHING.add(refresh_key)

    def refresh() -> None:
        try:
            with app.app_context():
                for code in normalized_codes:
                    try:
                        latest_date, _fetched_at = latest_fund_history_meta(code)
                        if latest_date:
                            auto_refresh_fund_history_if_stale(code, target_count)
                        else:
                            fetch_and_store_fund_history(code, target_count, refresh=True)
                    except Exception as exc:
                        print(f"[fundhistory-refresh] failed for {code}: {exc}", flush=True)
                response_cache_clear_prefix("api:overview:")
                response_cache_clear_prefix("api:fundreturns:")
        finally:
            with _FUND_HISTORY_REFRESH_GUARD:
                _FUND_HISTORY_REFRESHING.discard(refresh_key)

    thread = threading.Thread(
        target=refresh,
        name=f"fundhistory-refresh-{hashlib.sha1(refresh_key.encode()).hexdigest()[:8]}",
        daemon=True,
    )
    thread.start()


def count_fund_history_rows(code: str) -> int:
    with get_conn() as conn:
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
        return "tw", "", "TWD"
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
            "quoteSupported": universe_quote_supported_symbol(sina_symbol),
        })
    return holdings


def store_fund_holdings(code: str, holdings: list[dict[str, Any]]) -> None:
    if not holdings:
        return
    report_date = str(holdings[0].get("reportDate") or "")
    if not valid_fund_holding_report_date(report_date):
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
    with get_conn() as conn:
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


def valid_fund_holding_report_date(value: str) -> bool:
    try:
        parsed = datetime.fromisoformat(value).date()
    except ValueError:
        return False
    return (parsed.month, parsed.day) in {(3, 31), (6, 30), (9, 30), (12, 31)}


def current_fund_holding_report_date(value: str, *, as_of: date | None = None) -> bool:
    if not valid_fund_holding_report_date(value):
        return False
    report_date = datetime.fromisoformat(value).date()
    current_date = as_of or datetime.now(ZoneInfo("Asia/Shanghai")).date()
    age_days = (current_date - report_date).days
    return 0 <= age_days <= FUND_HOLDINGS_MAX_AGE_DAYS


def refresh_missing_fund_holdings(
    *,
    max_requests: int = 4,
    years: int = 3,
    start_offset: int | None = None,
) -> dict[str, Any]:
    gaps = missing_holding_requests(years=years)
    if gaps:
        offset = start_offset if start_offset is not None else (int(time.time() // 3600) * max(max_requests, 1))
        offset %= len(gaps)
        gaps_to_fetch = (gaps[offset:] + gaps[:offset])[:max(max_requests, 0)]
    else:
        gaps_to_fetch = []
    attempted = 0
    stored = 0
    unavailable = 0
    errors: list[str] = []
    for gap in gaps_to_fetch:
        code = str(gap["code"])
        year = int(gap["year"])
        quarter = int(gap["quarter"])
        expected_report_date = str(gap["reportDate"])
        attempted += 1
        query = urlencode({"type": "jjcc", "code": code, "topline": 10, "year": year, "month": quarter})
        status, _, body = fetch_upstream(
            f"https://fundf10.eastmoney.com/FundArchivesDatas.aspx?{query}",
            referer=f"https://fundf10.eastmoney.com/ccmx_{quote(code)}.html",
            content_type="text/plain; charset=utf-8",
            cache_key=f"fundholdings:{code}:{year}:{quarter}",
            kind="fundholdings",
            ttl_seconds=30 * 24 * 60 * 60,
        )
        if status >= 400:
            errors.append(f"{code}:{expected_report_date}: HTTP {status}")
            continue
        rows = parse_fund_holdings(code, decode_body(body))
        if not rows or str(rows[0].get("reportDate") or "") != expected_report_date:
            unavailable += 1
            continue
        store_fund_holdings(code, rows)
        stored += 1
    return {
        "pending": len(gaps),
        "attempted": attempted,
        "stored": stored,
        "unavailable": unavailable,
        "errors": errors,
    }


def read_fund_holdings_from_db(code: str) -> list[dict[str, Any]]:
    with get_conn() as conn:
        report_dates = conn.execute(
            "SELECT DISTINCT report_date FROM fund_holdings WHERE code = ? ORDER BY report_date DESC",
            (code,),
        ).fetchall()
        latest = next((row[0] for row in report_dates if current_fund_holding_report_date(str(row[0]))), "")
        if not latest:
            return []
        rows = conn.execute(
            """
            SELECT report_date, rank, stock_code, stock_name, weight, market, sina_symbol, currency, fetched_at
            FROM fund_holdings
            WHERE code = ? AND report_date = ?
            ORDER BY rank ASC
            """,
            (code, latest),
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
            "quoteSupported": universe_quote_supported_symbol(str(sina_symbol)),
            "fetchedAt": int(fetched_at),
        }
        for report_date, rank, stock_code, stock_name, weight, market, sina_symbol, currency, fetched_at in rows
    ]


def fund_holdings_signature(rows: list[dict[str, Any]]) -> tuple[tuple[str, float], ...]:
    return tuple(
        (str(item.get("stockCode") or item.get("symbol") or ""), round(float(item.get("weight") or 0), 8))
        for item in rows
    )


def refresh_latest_fund_holdings(
    codes: list[str] | None = None,
    *,
    force_refresh: bool = False,
) -> dict[str, Any]:
    fund_codes = sorted(dict.fromkeys(codes or configured_fund_codes_from_constants()))
    if not fund_codes:
        return {"checked": 0, "stored": 0, "updated": 0, "unavailable": 0, "errors": []}

    def fetch_one(code: str) -> tuple[str, list[dict[str, Any]], str]:
        query = urlencode({"type": "jjcc", "code": code, "topline": 10, "year": "", "month": ""})
        for attempt in range(2):
            try:
                status, _, body = fetch_upstream(
                    f"https://fundf10.eastmoney.com/FundArchivesDatas.aspx?{query}",
                    referer=f"https://fundf10.eastmoney.com/ccmx_{quote(code)}.html",
                    content_type="text/plain; charset=utf-8",
                    cache_key=f"fundholdings:{code}",
                    kind="fundholdings",
                    ttl_seconds=FUND_HOLDINGS_REFRESH_TTL_SECONDS,
                    force_refresh=force_refresh,
                )
                break
            except Exception as exc:
                if attempt == 0 and "514" in str(exc):
                    time.sleep(2)
                    continue
                return code, [], str(exc)
            finally:
                time.sleep(FUND_HOLDINGS_REQUEST_DELAY_SECONDS)
        if status >= 400:
            return code, [], f"HTTP {status}"
        return code, parse_fund_holdings(code, decode_body(body)), ""

    fetched: dict[str, tuple[list[dict[str, Any]], str]] = {}
    for code in fund_codes:
        fetched_code, rows, error = fetch_one(code)
        fetched[fetched_code] = (rows, error)

    stored = 0
    updated = 0
    unavailable = 0
    errors: list[str] = []
    latest_reports: dict[str, str] = {}
    changed_codes: list[str] = []
    for code in fund_codes:
        rows, error = fetched.get(code, ([], "missing result"))
        if error:
            errors.append(f"{code}: {error}")
            continue
        report_date = str(rows[0].get("reportDate") or "") if rows else ""
        if not rows or not current_fund_holding_report_date(report_date):
            unavailable += 1
            continue
        existing = read_fund_holdings_from_db(code)
        existing_date = str(existing[0].get("reportDate") or "") if existing else ""
        if existing_date and report_date < existing_date:
            unavailable += 1
            continue
        changed = report_date != existing_date or fund_holdings_signature(rows) != fund_holdings_signature(existing)
        store_fund_holdings(code, rows)
        stored += 1
        updated += int(changed)
        if changed:
            changed_codes.append(code)
        latest_reports[code] = report_date

    return {
        "checked": len(fund_codes),
        "stored": stored,
        "updated": updated,
        "unavailable": unavailable,
        "errors": errors,
        "latestReports": latest_reports,
        "changedCodes": changed_codes,
    }


def read_fund_holding_snapshots(code: str) -> list[tuple[str, list[dict[str, Any]]]]:
    with get_conn() as conn:
        report_dates = [
            str(row[0])
            for row in conn.execute(
                "SELECT DISTINCT report_date FROM fund_holdings WHERE code = ? ORDER BY report_date ASC",
                (code,),
            ).fetchall()
            if valid_fund_holding_report_date(str(row[0]))
        ]
    snapshots: list[tuple[str, list[dict[str, Any]]]] = []
    for report_date in report_dates:
        with get_conn() as conn:
            rows = conn.execute(
                """
                SELECT rank, stock_code, stock_name, weight, market, sina_symbol, currency, fetched_at
                FROM fund_holdings WHERE code = ? AND report_date = ? ORDER BY rank ASC
                """,
                (code, report_date),
            ).fetchall()
        snapshots.append((report_date, [
            {
                "code": code,
                "reportDate": report_date,
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
            for rank, stock_code, stock_name, weight, market, sina_symbol, currency, fetched_at in rows
        ]))
    return snapshots


def store_fx_daily_history(text: str) -> int:
    fetched_at = now_ms()
    points: list[tuple[str, str, float, float, int]] = []
    for line in text.splitlines():
        match = re.match(r'^var\s+hq_str_fx_s([a-z]{3})cny="([^"]*)"', line.strip(), re.I)
        if not match:
            continue
        currency = match.group(1).upper()
        fields = match.group(2).split(",")
        date = next((field for field in reversed(fields) if re.match(r"^\d{4}-\d{2}-\d{2}$", field)), "")
        rate = safe_float(fields[1]) if len(fields) > 1 else None
        change_percent = safe_float(fields[10]) if len(fields) > 10 else None
        if date and rate and rate > 0:
            points.append((currency, date, rate, change_percent or 0.0, fetched_at))
    if not points:
        return 0
    with get_conn() as conn:
        conn.executemany(
            """
            INSERT INTO fx_daily_history(currency, date, rate, change_percent, fetched_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(currency, date) DO UPDATE SET
              rate = excluded.rate,
              change_percent = excluded.change_percent,
              fetched_at = excluded.fetched_at
            """,
            points,
        )
    return len(points)


def read_fx_changes(currencies: list[str], start_date: str, end_date: str) -> dict[str, dict[str, float]]:
    normalized = sorted(dict.fromkeys(currency for currency in currencies if currency != "CNY"))
    if not normalized:
        return {}
    placeholders = ",".join("?" for _ in normalized)
    with get_conn() as conn:
        rows = conn.execute(
            f"""
            SELECT currency, date, change_percent FROM fx_daily_history
            WHERE currency IN ({placeholders}) AND date BETWEEN ? AND ?
            """,
            (*normalized, start_date, end_date),
        ).fetchall()
    results: dict[str, dict[str, float]] = {}
    for currency, date, change_percent in rows:
        results.setdefault(str(currency), {})[str(date)] = float(change_percent)
    return results


def read_fund_valuation_basis(items: list[dict[str, Any]]) -> dict[str, Any]:
    """Read the latest persisted holding closes and FX rates on/before each NAV date."""
    results: dict[str, Any] = {}
    with get_conn() as conn:
        for item in items:
            code = str(item["code"])
            nav_date = str(item["navDate"])
            symbols = sorted(dict.fromkeys(str(value) for value in item["symbols"]))
            currencies = sorted(dict.fromkeys(
                str(value) for value in item["currencies"] if str(value) != "CNY"
            ))
            holding_prices: dict[str, Any] = {}
            fx_rates: dict[str, Any] = {}
            for symbol in symbols:
                row = conn.execute(
                    """
                    SELECT date, close FROM stock_daily_history
                    WHERE sina_symbol = ? AND date <= ?
                    ORDER BY date DESC LIMIT 1
                    """,
                    (symbol, nav_date),
                ).fetchone()
                if row:
                    holding_prices[symbol] = {"date": str(row[0]), "close": float(row[1])}
            for currency in currencies:
                row = conn.execute(
                    """
                    SELECT date, rate FROM fx_daily_history
                    WHERE currency = ? AND date <= ?
                    ORDER BY date DESC LIMIT 1
                    """,
                    (currency, nav_date),
                ).fetchone()
                if row:
                    fx_rates[currency] = {"date": str(row[0]), "rate": float(row[1])}
            results[code] = {
                "navDate": nav_date,
                "holdingPrices": holding_prices,
                "fxRates": fx_rates,
            }
    return results


def refresh_ecb_fx_history(*, start_date: str | None = None, force_refresh: bool = False) -> int:
    if not start_date:
        latest_date = latest_fx_history_date()
        if latest_date:
            start_date = (datetime.fromisoformat(latest_date).date() - timedelta(days=7)).isoformat()
        else:
            start_date = (datetime.now(ZoneInfo("Asia/Shanghai")).date() - timedelta(days=6 * 366)).isoformat()
    series = "D.CNY+USD+JPY+KRW+HKD.EUR.SP00.A"
    query = urlencode({"startPeriod": start_date, "format": "csvdata"})
    url = f"https://data-api.ecb.europa.eu/service/data/EXR/{series}?{query}"
    status, _, body = fetch_upstream(
        url,
        referer="https://data.ecb.europa.eu/",
        content_type="text/csv; charset=utf-8",
        cache_key=f"fxhistory:ecb:{start_date}",
        kind="fxhistory",
        ttl_seconds=6 * 60 * 60,
        force_refresh=force_refresh,
    )
    if status >= 400:
        return 0
    return store_ecb_reference_rates(decode_body(body), now_ms())


def parse_default_fund_holdings_from_constants(code: str) -> list[dict[str, Any]]:
    return universe_fund_holdings(code)


def read_fund_holdings_for_backtest(code: str) -> list[dict[str, Any]]:
    rows = read_fund_holdings_from_db(code)
    return rows if rows else parse_default_fund_holdings_from_constants(code)


def configured_fund_codes_from_constants() -> list[str]:
    return universe_fund_codes()


def configured_sina_symbols_from_constants() -> list[str]:
    return universe_sina_symbols()


def configured_quote_symbols() -> list[str]:
    symbols = configured_sina_symbols_from_constants()
    for code in configured_fund_codes_from_constants():
        for holding in read_fund_holdings_from_db(code):
            symbol = str(holding.get("sinaSymbol") or "")
            if universe_quote_supported_symbol(symbol, holding.get("quoteSupported")):
                symbols.append(symbol)
    return sorted(dict.fromkeys(symbols))


def configured_unsupported_quote_symbols() -> list[str]:
    symbols = universe_unsupported_quote_symbols()
    for code in configured_fund_codes_from_constants():
        for holding in read_fund_holdings_from_db(code):
            symbol = str(holding.get("sinaSymbol") or "")
            if SINA_SYMBOL_RE.fullmatch(symbol) and not universe_quote_supported_symbol(
                symbol,
                holding.get("quoteSupported"),
            ):
                symbols.append(symbol)
    return sorted(dict.fromkeys(symbols))


def quote_symbol_groups(symbols: list[str] | None = None) -> tuple[list[str], list[str]]:
    cash: list[str] = []
    continuous: list[str] = []
    for symbol in symbols or configured_quote_symbols():
        market = market_key_for_symbol(symbol)
        if market in {"us_futures", "hk_futures", "jp_futures", "crypto"}:
            continuous.append(symbol)
        else:
            cash.append(symbol)
    return sorted(dict.fromkeys(cash)), sorted(dict.fromkeys(continuous))


def quote_group_refresh_interval(symbols: list[str], now: datetime | None = None) -> int:
    current = now or datetime.now(ZoneInfo("Asia/Shanghai"))
    states = [
        (symbol, market_key_for_symbol(symbol), market_state_for_symbol(symbol, current).get("state"))
        for symbol in symbols
    ]
    continuous_markets = {"us_futures", "hk_futures", "jp_futures", "crypto"}
    if any(state == "live" and market not in continuous_markets for _symbol, market, state in states):
        return 60
    if any(
        state == "live" and market in {"us_futures", "hk_futures", "jp_futures"}
        for _symbol, market, state in states
    ):
        return 2 * 60
    if any(state == "live" and market == "crypto" for _symbol, market, state in states):
        return 5 * 60
    if any(state == "break" for _symbol, _market, state in states):
        return 5 * 60
    for _symbol, market, _state in states:
        if not market or market not in MARKET_CALENDARS:
            continue
        calendar = MARKET_CALENDARS[market]
        local = current.astimezone(ZoneInfo(str(calendar["timezone"])))
        row = market_calendar_row(market, local.strftime("%Y-%m-%d"))
        if not row or row["status"] not in {"open", "half_day"}:
            continue
        minutes = local.hour * 60 + local.minute
        for start_raw, _end_raw in row["sessions"]:
            try:
                starts_in = parse_hhmm(str(start_raw)) - minutes
            except (TypeError, ValueError):
                continue
            if 0 < starts_in <= 30:
                return 60
    return 15 * 60


def configured_market_return_items_from_constants() -> list[str]:
    return universe_market_return_items()


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


def prewarm_fund_backtest_cache(codes: list[str] | None = None, days: int = 90) -> list[str]:
    fund_codes = sorted(dict.fromkeys(codes or configured_fund_codes_from_constants()))
    errors: list[str] = []
    if not fund_codes:
        return errors

    def compute_one(code: str) -> None:
        compute_fund_backtest(code, days, refresh=False, use_persisted=False)

    max_workers = min(4, len(fund_codes))
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(compute_one, code): code for code in fund_codes}
        for future in as_completed(futures):
            code = futures[future]
            try:
                future.result()
            except Exception as exc:
                errors.append(f"backtest {code}: {exc}")

    print(
        f"Prewarmed fund backtest cache: {len(fund_codes) - len(errors)}/{len(fund_codes)}",
        flush=True,
    )
    return errors


def fund_nav_upstream_cache_key(code: str) -> str:
    return f"fundnav:{code}"


def fund_nav_api_cache_key(codes: list[str]) -> str:
    return f"api:fundnav:{','.join(sorted(codes))}"


def parse_cached_fund_nav(code: str, max_age_seconds: int) -> Any | None:
    cached = cache_get(fund_nav_upstream_cache_key(code), max_age_seconds)
    if not cached:
        return None
    status, _content_type, body = cached
    if status >= 400:
        return None
    return parse_jsonp_call(decode_body(body), "jsonpgz")


def read_cached_fund_nav_payload(codes: list[str], max_age_seconds: int) -> dict[str, Any]:
    results: dict[str, Any] = {}
    for code in codes:
        parsed = parse_cached_fund_nav(code, max_age_seconds)
        if parsed:
            results[code] = parsed
    return results


def read_fund_nav_fallback_payload(codes: list[str]) -> dict[str, Any]:
    """Represent the latest persisted official NAV in the fundnav wire format."""
    results: dict[str, Any] = {}
    for code in codes:
        summary = read_fund_overview_summary_from_db(code)
        if not summary:
            continue
        results[code] = {
            "fundcode": code,
            "name": "",
            "jzrq": str(summary["navDate"]),
            "dwjz": f'{float(summary["nav"]):.4f}',
            "gsz": "",
            "gszzl": "",
        }
    return results


def available_fund_nav_payload(codes: list[str]) -> tuple[dict[str, Any], list[str]]:
    fresh = read_cached_fund_nav_payload(codes, FUND_NAV_CACHE_TTL_SECONDS)
    stale = read_cached_fund_nav_payload(codes, 0)
    fallback = read_fund_nav_fallback_payload(codes)
    payload = {
        code: fresh.get(code) or stale.get(code) or fallback.get(code)
        for code in codes
        if fresh.get(code) or stale.get(code) or fallback.get(code)
    }
    # Successful stale values should refresh promptly. If the latest upstream
    # response was valid HTTP but contained no estimate, retry at worker cadence
    # instead of once per page request/cache expiry.
    needs_refresh = [
        code
        for code in codes
        if code not in fresh
        and (code in stale or cache_get(fund_nav_upstream_cache_key(code), 15 * 60) is None)
    ]
    return payload, needs_refresh


def fetch_fund_nav_one(code: str, *, force_refresh: bool = False) -> tuple[str, Any | None]:
    try:
        url = f"https://fundgz.1234567.com.cn/js/{quote(code)}.js"
        status, _, body = fetch_upstream(
            url,
            referer="https://fund.eastmoney.com/",
            content_type="text/plain; charset=utf-8",
            cache_key=fund_nav_upstream_cache_key(code),
            kind="fundnav",
            ttl_seconds=FUND_NAV_CACHE_TTL_SECONDS,
            force_refresh=force_refresh,
        )
        if status >= 400:
            return code, None
        return code, parse_jsonp_call(decode_body(body), "jsonpgz")
    except Exception as exc:
        # Never let a single fund's upstream failure escape — it would abort the
        # whole batch in fetch_fund_nav_payload via future.result().
        print(f"[fundnav] failed for {code}: {exc}", flush=True)
        return code, None


def fetch_fund_nav_payload(codes: list[str], *, force_refresh: bool = False) -> dict[str, Any]:
    results: dict[str, Any] = {}
    if not codes:
        return results
    max_workers = min(8, len(codes))
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(fetch_fund_nav_one, code, force_refresh=force_refresh) for code in codes]
        for future in as_completed(futures):
            try:
                code, parsed = future.result()
            except Exception as exc:
                # Defensive: fetch_fund_nav_one already swallows errors, but keep
                # the batch resilient against any unexpected worker failure.
                print(f"[fundnav] worker error: {exc}", flush=True)
                continue
            if parsed:
                results[code] = parsed
    return results


def schedule_fund_nav_refresh(codes: list[str]) -> None:
    normalized_codes = sorted(dict.fromkeys(codes))
    if not normalized_codes:
        return
    refresh_key = ",".join(normalized_codes)
    with _FUND_NAV_REFRESH_GUARD:
        if refresh_key in _FUND_NAV_REFRESHING:
            return
        _FUND_NAV_REFRESHING.add(refresh_key)

    def refresh() -> None:
        try:
            with app.app_context():
                fetched = fetch_fund_nav_payload(normalized_codes, force_refresh=True)
                fallback = read_fund_nav_fallback_payload(normalized_codes)
                payload = {
                    code: fetched.get(code) or fallback.get(code)
                    for code in normalized_codes
                    if fetched.get(code) or fallback.get(code)
                }
                if payload:
                    response_cache_set(
                        fund_nav_api_cache_key(normalized_codes),
                        json_response(payload),
                        FUND_NAV_CACHE_TTL_SECONDS,
                    )
        except Exception as exc:
            print(f"[fundnav-refresh] failed for {refresh_key}: {exc}", flush=True)
        finally:
            with _FUND_NAV_REFRESH_GUARD:
                _FUND_NAV_REFRESHING.discard(refresh_key)

    thread = threading.Thread(target=refresh, name=f"fundnav-refresh-{hashlib.sha1(refresh_key.encode()).hexdigest()[:8]}", daemon=True)
    thread.start()


def prewarm_fund_nav_cache_async() -> None:
    fund_codes = configured_fund_codes_from_constants()
    if not fund_codes:
        return
    schedule_fund_nav_refresh(fund_codes)


def fetch_and_store_purchase_status(*, force_refresh: bool = False) -> None:
    ttl_seconds = 6 * 60 * 60
    query = urlencode(
        {
            "t": "8",
            "page": "1,30000",
            "js": "reData",
            "sort": "fcode,asc",
            "_": int(time.time() * 1000),
        }
    )
    url = f"https://fund.eastmoney.com/Data/Fund_JJJZ_Data.aspx?{query}"
    status, _, body = fetch_upstream(
        url,
        referer="https://fund.eastmoney.com/Fund_sgzt.html",
        content_type="text/plain; charset=utf-8",
        cache_key="fundpurchase:all",
        kind="fundpurchase",
        ttl_seconds=ttl_seconds,
        force_refresh=force_refresh,
    )
    if status < 400:
        store_purchase_status(decode_body(body))


def schedule_purchase_status_refresh() -> None:
    global _FUND_PURCHASE_REFRESHING
    with _FUND_PURCHASE_REFRESH_GUARD:
        if _FUND_PURCHASE_REFRESHING:
            return
        _FUND_PURCHASE_REFRESHING = True

    def refresh() -> None:
        global _FUND_PURCHASE_REFRESHING
        try:
            with app.app_context():
                fetch_and_store_purchase_status(force_refresh=True)
        except Exception as exc:
            print(f"[fundpurchase-refresh] failed: {exc}", flush=True)
        finally:
            with _FUND_PURCHASE_REFRESH_GUARD:
                _FUND_PURCHASE_REFRESHING = False

    threading.Thread(target=refresh, name="fundpurchase-refresh", daemon=True).start()


def prewarm_purchase_status_cache() -> None:
    codes = configured_fund_codes_from_constants()
    if not codes or len(read_purchase_status_from_db(codes, 6 * 60 * 60)) == len(codes):
        return
    fetch_and_store_purchase_status()


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
    with get_conn() as conn:
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
    elif source == "twse-official":
        parsed = json.loads(text)
        data_rows = parsed.get("data") if isinstance(parsed, dict) else None
        if isinstance(data_rows, list):
            for row in data_rows:
                if not isinstance(row, list) or len(row) < 5:
                    continue
                rows.append({
                    "date": str(row[0]).replace("/", "-"),
                    "close": str(row[4]).replace(",", ""),
                })
    elif source == "naver-korea":
        rows = parse_naver_korea_history(text)

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
    with get_conn() as conn:
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


def parse_naver_korea_history(text: str) -> list[dict[str, Any]]:
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        try:
            parsed = ast.literal_eval(text.strip())
        except (SyntaxError, ValueError):
            return []
    if not isinstance(parsed, list):
        return []

    rows: list[dict[str, Any]] = []
    for row in parsed:
        if isinstance(row, dict):
            date = str(row.get("date") or "")
            close = row.get("close")
        elif isinstance(row, list) and len(row) >= 5:
            date = str(row[0] or "")
            close = row[4]
        else:
            continue
        if re.fullmatch(r"\d{8}", date):
            date = f"{date[:4]}-{date[4:6]}-{date[6:]}"
        try:
            close_value = float(close)
        except (TypeError, ValueError):
            continue
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", date) and close_value > 0:
            rows.append({"date": date, "close": close_value})
    return rows


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
    with get_conn() as conn:
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
    # Recompute change_percent for each newly upserted date AND for the date
    # immediately following it: backfilling a mid-history day changes the
    # following day's previous close, so its change_percent must be refreshed
    # too, otherwise it keeps a stale value.
    merged_dates = [date for date, _ in merged]
    merged_index = {date: idx for idx, date in enumerate(merged_dates)}
    recompute_dates: set[str] = set()
    for date, _ in deduped:
        recompute_dates.add(date)
        idx = merged_index.get(date)
        if idx is not None and idx + 1 < len(merged_dates):
            recompute_dates.add(merged_dates[idx + 1])

    merged_close = dict(merged)
    points: list[tuple[str, str, float, float, int]] = []
    for date in recompute_dates:
        close = merged_close[date]
        previous = previous_close_by_date.get(date)
        change_percent = ((close - previous) / previous) * 100 if previous and previous > 0 else 0.0
        points.append((sina_symbol, date, close, change_percent, fetched_at))
    # Sort for deterministic ordering.
    points.sort(key=lambda p: p[1])

    with get_conn() as conn:
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
    return len(deduped)


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


def refresh_fund_valuation_histories() -> dict[str, Any]:
    symbols: list[str] = []
    for code in configured_fund_codes_from_constants():
        holdings = read_fund_holdings_from_db(code) or parse_default_fund_holdings_from_constants(code)
        symbols.extend(
            str(item.get("sinaSymbol") or "")
            for item in holdings
            if stock_history_url(str(item.get("sinaSymbol") or "")) is not None
        )
    normalized_symbols = sorted(dict.fromkeys(symbol for symbol in symbols if symbol))
    updated = 0
    failed: list[str] = []
    errors: list[str] = []

    def refresh_one(symbol: str) -> bool:
        return fetch_and_store_stock_history(symbol, refresh=True)

    if normalized_symbols:
        with ThreadPoolExecutor(max_workers=min(8, len(normalized_symbols))) as executor:
            futures = {executor.submit(refresh_one, symbol): symbol for symbol in normalized_symbols}
            for future in as_completed(futures):
                symbol = futures[future]
                try:
                    if future.result():
                        updated += 1
                    else:
                        failed.append(symbol)
                except Exception as exc:
                    errors.append(f"{symbol}: {exc}")
    try:
        fx_rows = refresh_ecb_fx_history(force_refresh=True)
    except Exception as exc:
        fx_rows = 0
        errors.append(f"fx: {exc}")
    return {
        "checked": len(normalized_symbols),
        "updated": updated,
        "failed": len(failed),
        "sampleFailed": failed[:10],
        "fxRows": fx_rows,
        "errors": errors,
    }


def read_fund_history_from_db(code: str, page_size: int, page_index: int) -> list[dict[str, str]]:
    offset = (page_index - 1) * page_size
    with get_conn() as conn:
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


def read_fund_overview_summary_from_db(code: str) -> dict[str, Any] | None:
    rows = read_fund_history_from_db(code, 2, 1)
    if len(rows) < 2:
        return None
    try:
        nav = float(rows[0]["DWJZ"])
        previous_nav = float(rows[1]["DWJZ"])
    except (KeyError, TypeError, ValueError):
        return None
    official_change = ((nav - previous_nav) / previous_nav) * 100 if previous_nav else 0
    return {
        "code": code,
        "navDate": rows[0]["FSRQ"],
        "nav": nav,
        "officialChange": round(official_change, 2),
    }


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
    with get_conn() as conn:
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


def read_purchase_status_from_db(codes: list[str], max_age_seconds: int | None) -> dict[str, dict[str, Any]]:
    if not codes:
        return {}
    placeholders = ",".join("?" for _ in codes)
    with get_conn() as conn:
        rows = conn.execute(
            f"""
            SELECT code, name, fund_type, nav_date, purchase_status, redeem_status,
                   next_open_date, min_purchase, daily_limit, fee_rate, fetched_at
            FROM fund_purchase_status
            WHERE code IN ({placeholders})
            """,
            tuple(codes),
        ).fetchall()
    min_fetched_at = now_ms() - max_age_seconds * 1000 if max_age_seconds is not None else None
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
        if min_fetched_at is not None and int(fetched_at) < min_fetched_at:
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


def cn_etf_history_needs_adjustment(source: str, symbol: str) -> bool:
    return source == "sina-cn" and CN_ETF_HISTORY_SYMBOL_RE.fullmatch(symbol) is not None


def adjust_market_history_for_corporate_actions(rows: list[dict[str, float | str]]) -> list[dict[str, float | str]]:
    adjusted_rows: list[dict[str, float | str]] = []
    factor = 1.0
    previous_raw_close: float | None = None
    previous_adjusted_close: float | None = None
    has_adjustment = False

    for row in rows:
        raw_close = float(row["close"])
        if previous_raw_close and previous_raw_close > 0 and previous_adjusted_close and previous_adjusted_close > 0:
            ratio = raw_close / previous_raw_close
            if (
                0 < ratio < MARKET_HISTORY_CORPORATE_ACTION_LOW_RATIO
                or ratio > MARKET_HISTORY_CORPORATE_ACTION_HIGH_RATIO
            ):
                factor = previous_adjusted_close / raw_close
                has_adjustment = True

        adjusted_close = raw_close * factor
        adjusted_row: dict[str, float | str] = {
            "date": str(row["date"]),
            "close": round(adjusted_close, 6),
        }
        if has_adjustment:
            adjusted_row["rawClose"] = raw_close
            adjusted_row["adjusted"] = True
        adjusted_rows.append(adjusted_row)
        previous_raw_close = raw_close
        previous_adjusted_close = adjusted_close

    return adjusted_rows


def read_market_history_from_db(source: str, symbol: str, *, adjust_corporate_actions: bool = False) -> list[dict[str, float | str]]:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT date, close
            FROM market_history
            WHERE source = ? AND symbol = ?
            ORDER BY date ASC
            """,
            (source, symbol),
        ).fetchall()
    history_rows = [{"date": str(date), "close": float(close)} for date, close in rows]
    if adjust_corporate_actions and cn_etf_history_needs_adjustment(source, symbol):
        return adjust_market_history_for_corporate_actions(history_rows)
    return history_rows


def latest_market_history_meta(source: str, symbol: str) -> tuple[str | None, int]:
    with get_conn() as conn:
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
        status, _, body = fetch_market_history_payload(
            source,
            symbol,
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
        status, _, body = fetch_market_history_payload(
            source,
            symbol,
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
        response_cache_clear_marketreturns_item(f"{source}:{symbol}")
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
    rows = read_market_history_from_db(source, symbol, adjust_corporate_actions=True)
    raw_rows = read_market_history_from_db(source, symbol)
    points = [
        (str(row["date"]), float(row["close"]))
        for row in rows
        if float(row["close"]) > 0
    ]
    if len(points) < 2:
        return None

    previous_date, previous_close = points[-2]
    latest_date, latest_close = points[-1]
    raw_by_date = {str(row["date"]): float(row["close"]) for row in raw_rows if float(row["close"]) > 0}
    raw_previous_close = raw_by_date.get(previous_date, previous_close)
    raw_latest_close = raw_by_date.get(latest_date, latest_close)
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
            "startClose": round(raw_by_date.get(start_date, start_close), 4),
            "endClose": round(raw_latest_close, 4),
            "startAdjustedClose": round(start_close, 4),
            "endAdjustedClose": round(latest_close, 4),
        }

    if not ranges:
        return None

    latest_return_percent = ((latest_close - previous_close) / previous_close) * 100
    latest_return = {
        "key": "latest",
        "label": "最新",
        "returnPercent": round(latest_return_percent, 2),
        "startDate": previous_date,
        "endDate": latest_date,
        "startClose": round(raw_previous_close, 4),
        "endClose": round(raw_latest_close, 4),
        "startAdjustedClose": round(previous_close, 4),
        "endAdjustedClose": round(latest_close, 4),
    }
    ytd = ranges.get("ytd")
    return {
        "source": source,
        "symbol": symbol,
        "asOf": latest_date,
        "latest": latest_return,
        "ranges": ranges,
        "label": ytd["label"] if ytd else "",
        "returnPercent": ytd["returnPercent"] if ytd else 0,
        "startDate": ytd["startDate"] if ytd else "",
        "endDate": latest_date,
        "startClose": ytd["startClose"] if ytd else 0,
        "endClose": round(raw_latest_close, 4),
    }


def read_fund_nav_changes(code: str, days: int) -> list[tuple[str, float]]:
    with get_conn() as conn:
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
    with get_conn() as conn:
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
    with get_conn() as conn:
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


_BACKTEST_RESULT_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_BACKTEST_RESULT_CACHE_TTL_SECONDS = 5 * 60


def read_backtest_summary(code: str, days: int) -> dict[str, Any] | None:
    with get_conn() as conn:
        row = conn.execute(
            """
            SELECT payload FROM fund_backtest_summaries
            WHERE code = ? AND days = ? AND model_version = ?
            """,
            (code, days, BACKTEST_MODEL_VERSION),
        ).fetchone()
    if not row:
        return None
    try:
        payload = json.loads(str(row[0]))
    except (TypeError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def store_backtest_summary(code: str, days: int, payload: dict[str, Any]) -> None:
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO fund_backtest_summaries(code, days, model_version, payload, generated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(code, days, model_version) DO UPDATE SET
              payload = excluded.payload,
              generated_at = excluded.generated_at
            """,
            (code, days, BACKTEST_MODEL_VERSION, json.dumps(payload, ensure_ascii=False), now_ms()),
        )


def compute_fund_backtest(
    code: str,
    days: int,
    *,
    refresh: bool = False,
    use_persisted: bool = True,
) -> dict[str, Any] | None:
    # Backtest is expensive (it may fetch many stock histories on refresh).
    # Cache the computed summary for a short TTL; refresh=True always bypasses
    # and recomputes. (The fund_estimate_backtest table stores per-date points
    # for forensic use; this cache covers the summary that callers consume.)
    cache_key = f"{code}:{days}"
    if not refresh and use_persisted:
        cached = _BACKTEST_RESULT_CACHE.get(cache_key)
        if cached and time.monotonic() - cached[0] < _BACKTEST_RESULT_CACHE_TTL_SECONDS:
            return cached[1]
        persisted = read_backtest_summary(code, days) if use_persisted else None
        if persisted:
            _BACKTEST_RESULT_CACHE[cache_key] = (time.monotonic(), persisted)
            return persisted

    snapshots = read_fund_holding_snapshots(code)
    if not snapshots:
        fallback_holdings = [item for item in read_fund_holdings_for_backtest(code) if item.get("sinaSymbol")]
        fallback_date = str(fallback_holdings[0].get("reportDate") or "1900-01-01") if fallback_holdings else "1900-01-01"
        snapshots = [(fallback_date, fallback_holdings)] if fallback_holdings else []
    snapshots = [
        (report_date, [item for item in holdings if item.get("sinaSymbol")])
        for report_date, holdings in snapshots
    ]
    all_holdings = [item for _report_date, holdings in snapshots for item in holdings]
    nav_changes = read_fund_nav_changes(code, days)
    if not all_holdings or len(nav_changes) < 2:
        return None

    if refresh:
        for symbol in dict.fromkeys(str(item.get("sinaSymbol") or "") for item in all_holdings):
            if symbol:
                fetch_and_store_stock_history(symbol, refresh=True)

    start_date = nav_changes[0][0]
    end_date = nav_changes[-1][0]
    changes = read_stock_changes([str(item["sinaSymbol"]) for item in all_holdings], start_date, end_date)
    fx_changes = read_fx_changes([str(item.get("currency") or "CNY") for item in all_holdings], start_date, end_date)
    points: list[dict[str, float]] = []

    def holdings_for_date(date: str) -> list[dict[str, Any]]:
        # A report becomes broadly available after publication; 45 days avoids
        # applying quarter-end holdings before investors could know them.
        available = [
            holdings
            for report_date, holdings in snapshots
            if (datetime.fromisoformat(report_date).date() + timedelta(days=45)).isoformat() <= date
        ]
        return available[-1] if available else snapshots[0][1]

    for date, actual_change in nav_changes:
        holdings = holdings_for_date(date)
        total_weight = sum(float(item.get("weight") or 0) for item in holdings)
        predicted = 0.0
        covered_weight = 0.0
        for item in holdings:
            weight = float(item.get("weight") or 0)
            change = changes.get(str(item["sinaSymbol"]), {}).get(date)
            if change is None:
                continue
            currency = str(item.get("currency") or "CNY")
            fx_change = fx_changes.get(currency, {}).get(date, 0.0)
            rmb_change = ((1 + change / 100) * (1 + fx_change / 100) - 1) * 100
            predicted += weight * rmb_change
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
    latest_holdings = snapshots[-1][1]
    latest_total_weight = sum(float(item.get("weight") or 0) for item in latest_holdings)
    top_holding_weight = latest_total_weight * 100
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
    result = {
        "code": code,
        "modelVersion": BACKTEST_MODEL_VERSION,
        "sampleCount": len(points),
        "trainSampleCount": len(train_points),
        "validationSampleCount": len(validation_points),
        "startDate": points[0]["date"],
        "endDate": points[-1]["date"],
        "holdingCount": len(latest_holdings),
        "holdingSnapshotCount": len(snapshots),
        "supportedHoldingCount": len([item for item in latest_holdings if stock_history_url(str(item.get("sinaSymbol") or ""))]),
        "fxHistoryCurrencies": sorted(fx_changes),
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
            "回测会按报告期切换已保存的前十大持仓；缺少早期报告时使用最早可用持仓。",
            "历史汇率按本地已沉淀交易日数据纳入；缺失日期按汇率涨跌 0 处理。",
            "未披露持仓、现金仓位和基金费用会体现在残差中。",
        ],
    }
    store_backtest_summary(code, days, result)
    _BACKTEST_RESULT_CACHE[cache_key] = (time.monotonic(), result)
    return result


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
    if not fund_management_enabled():
        configured_codes = set(configured_fund_codes_from_constants())
        unsupported = [code for code in codes if code not in configured_codes]
        if unsupported:
            raise Forbidden("Fund management is disabled; only configured funds are available")
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
    # Only trust X-Forwarded-For when running behind the dev proxy on loopback;
    # a direct remote client could otherwise spoof it to rotate rate-limit keys.
    forwarded = request.headers.get("X-Forwarded-For", "").split(",", 1)[0].strip()
    remote = request.remote_addr or "unknown"
    if forwarded and remote in {"127.0.0.1", "::1"}:
        return forwarded
    return remote


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
    response.headers["Cache-Control"] = (
        f"public, max-age={min(ttl_seconds, 30)}, "
        "stale-while-revalidate=120, stale-if-error=86400"
    )
    return response


def response_cache_clear_prefix(prefix: str) -> None:
    with _RESPONSE_CACHE_GUARD:
        for key in list(_RESPONSE_CACHE):
            if key.startswith(prefix):
                _RESPONSE_CACHE.pop(key, None)


def response_cache_clear_marketreturns_item(item: str) -> None:
    """Invalidate only marketreturns cache entries that include the refreshed item.

    A marketreturns cache key is `api:marketreturns:<comma-joined items>`. Clearing
    the whole prefix would drop entries for every other symbol too; instead drop
    only entries whose item list contains the refreshed `source:symbol`.
    """
    with _RESPONSE_CACHE_GUARD:
        for key in list(_RESPONSE_CACHE):
            if not key.startswith("api:marketreturns:"):
                continue
            items_part = key[len("api:marketreturns:"):]
            if item in items_part.split(","):
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


def upstream_cache_stats() -> dict[str, Any]:
    with get_conn() as conn:
        rows = conn.execute("SELECT cache_key, fetched_at FROM response_cache").fetchall()
    by_kind: dict[str, int] = {}
    latest_at = 0
    for cache_key, fetched_at in rows:
        kind = str(cache_key).split(":", 1)[0] or "unknown"
        by_kind[kind] = by_kind.get(kind, 0) + 1
        latest_at = max(latest_at, int(fetched_at or 0))
    return {"total": len(rows), "byKind": by_kind, "latestAt": latest_at}


def fund_history_health() -> dict[str, Any]:
    codes = configured_fund_codes_from_constants()
    missing: list[str] = []
    stale: list[str] = []
    latest_dates: list[str] = []
    for code in codes:
        latest_date, fetched_at = latest_fund_history_meta(code)
        if not latest_date:
            missing.append(code)
            continue
        latest_dates.append(latest_date)
        if fund_history_is_stale(latest_date):
            stale.append(code)
    return {
        "total": len(codes),
        "missing": len(missing),
        "stale": len(stale),
        "sampleMissing": missing[:5],
        "sampleStale": stale[:5],
        "latestDate": max(latest_dates) if latest_dates else "",
    }


def market_history_health() -> dict[str, Any]:
    items = configured_market_return_items_from_constants()
    missing: list[str] = []
    stale: list[str] = []
    latest_dates: list[str] = []
    for item in items:
        source, symbol = item.split(":", 1)
        latest_date, fetched_at = latest_market_history_meta(source, symbol)
        if not latest_date:
            missing.append(item)
            continue
        latest_dates.append(latest_date)
        if market_history_is_stale(source, symbol, latest_date):
            stale.append(item)
    return {
        "total": len(items),
        "missing": len(missing),
        "stale": len(stale),
        "sampleMissing": missing[:5],
        "sampleStale": stale[:5],
        "latestDate": max(latest_dates) if latest_dates else "",
    }


def upstream_health_snapshot() -> dict[str, Any]:
    with _UPSTREAM_HEALTH_GUARD:
        rows = sorted(_UPSTREAM_HEALTH.values(), key=lambda item: int(item.get("lastSeenAt", 0)), reverse=True)
    stale_count = sum(1 for item in rows if item.get("source") == "stale")
    fallback_count = sum(1 for item in rows if item.get("source") == "fallback")
    error_count = sum(
        1 for item in rows
        if item.get("source") == "error" or (item.get("source") == "stale" and item.get("error"))
    )
    issue_rows = [
        item for item in rows
        if item.get("source") in {"stale", "error", "fallback"}
    ]
    return {
        "total": len(rows),
        "staleCount": stale_count,
        "fallbackCount": fallback_count,
        "errorCount": error_count,
        "issueCount": len(issue_rows),
        "issues": issue_rows[:8],
        "recent": rows[:12],
    }


def background_refresh_state_snapshot() -> dict[str, Any]:
    with _BACKGROUND_REFRESH_GUARD:
        state = dict(_BACKGROUND_REFRESH_STATE)
    try:
        with get_conn() as conn:
            row = conn.execute(
                """
                SELECT owner, lease_until, last_run_at, last_success_at,
                       last_error_at, last_error, run_count
                FROM background_jobs WHERE name = ?
                """,
                (BACKGROUND_JOB_NAME,),
            ).fetchone()
    except sqlite3.Error:
        row = None
    if row:
        state.update({
            "owner": str(row[0]),
            "leaseUntil": int(row[1]),
            "lastRunAt": int(row[2]),
            "lastSuccessAt": int(row[3]),
            "lastErrorAt": int(row[4]),
            "lastError": str(row[5]),
            "runCount": int(row[6]),
        })
    return state


def claim_background_job(
    owner: str,
    *,
    lease_seconds: int | None = None,
    current_ms: int | None = None,
) -> bool:
    current = current_ms if current_ms is not None else now_ms()
    lease_ms = max(lease_seconds or BACKGROUND_REFRESH_INTERVAL_SECONDS * 2, 120) * 1000
    with get_conn() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT owner, lease_until FROM background_jobs WHERE name = ?",
            (BACKGROUND_JOB_NAME,),
        ).fetchone()
        if row and str(row[0]) != owner and int(row[1]) > current:
            return False
        conn.execute(
            """
            INSERT INTO background_jobs(
              name, owner, lease_until, last_run_at, last_success_at,
              last_error_at, last_error, run_count
            ) VALUES (?, ?, ?, 0, 0, 0, '', 0)
            ON CONFLICT(name) DO UPDATE SET
              owner = excluded.owner,
              lease_until = excluded.lease_until
            """,
            (BACKGROUND_JOB_NAME, owner, current + lease_ms),
        )
    return True


def release_background_job(owner: str) -> bool:
    with get_conn() as conn:
        cursor = conn.execute(
            "UPDATE background_jobs SET lease_until = 0 WHERE name = ? AND owner = ?",
            (BACKGROUND_JOB_NAME, owner),
        )
    return int(cursor.rowcount) > 0


def build_data_health_payload() -> dict[str, Any]:
    upstream = upstream_health_snapshot()
    fund_history_state = fund_history_health()
    market_history_state = market_history_health()
    degraded = (
        upstream["errorCount"] > 0
        or upstream["staleCount"] > 0
        or upstream["fallbackCount"] > 0
        or fund_history_state["missing"] > 0
        or fund_history_state["stale"] > 0
        or market_history_state["missing"] > 0
        or market_history_state["stale"] > 0
    )
    return {
        "status": "degraded" if degraded else "ok",
        "updatedAt": now_ms(),
        "upstream": upstream,
        "cache": upstream_cache_stats(),
        "fundHistory": fund_history_state,
        "marketHistory": market_history_state,
        "backgroundRefresh": background_refresh_state_snapshot(),
    }


def quote_snapshot_health(now: datetime | None = None) -> dict[str, Any]:
    current = now or datetime.now(ZoneInfo("Asia/Shanghai"))
    current_ms = int(current.timestamp() * 1000)
    symbols = configured_quote_symbols()
    unsupported_symbols = configured_unsupported_quote_symbols()
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT snapshot.symbol, snapshot.captured_at, snapshot.quote_time,
                   snapshot.market_state, snapshot.source, snapshot.price,
                   snapshot.previous_close, snapshot.change_percent,
                   snapshot.validation_status, snapshot.validation_message
            FROM market_quote_snapshots AS snapshot
            JOIN (
              SELECT symbol, MAX(bucket_at) AS bucket_at
              FROM market_quote_snapshots GROUP BY symbol
            ) AS latest
              ON latest.symbol = snapshot.symbol AND latest.bucket_at = snapshot.bucket_at
            """
        ).fetchall()
    latest_by_symbol = {str(row[0]): row for row in rows}
    issues: list[dict[str, Any]] = []
    fallbacks: list[dict[str, Any]] = []
    healthy = 0
    fallback_count = 0
    for symbol in symbols:
        row = latest_by_symbol.get(symbol)
        current_state = market_state_for_symbol(symbol, current)
        if not row:
            issues.append({"symbol": symbol, "reason": "missing snapshot", "state": current_state["state"]})
            continue
        captured_at = int(row[1])
        age_seconds = max((current_ms - captured_at) // 1000, 0)
        max_age = quote_snapshot_max_age_seconds(symbol, current_state) + 60
        source = str(row[4])
        validation_status = str(row[8])
        if source in {"fallback", "normalized"}:
            fallback_count += 1
            fallbacks.append({
                "symbol": symbol,
                "source": source,
                "quoteTime": str(row[2]),
                "state": current_state["state"],
            })
        reason = ""
        if age_seconds > max_age:
            reason = f"snapshot age {age_seconds}s exceeds {max_age}s"
        elif validation_status != "ok":
            reason = str(row[9]) or validation_status
        if reason:
            issues.append({
                "symbol": symbol,
                "reason": reason,
                "state": current_state["state"],
                "ageSeconds": age_seconds,
                "quoteTime": str(row[2]),
                "source": source,
            })
        else:
            healthy += 1
    return {
        "status": "degraded" if issues else "ok",
        "updatedAt": current_ms,
        "total": len(symbols),
        "healthy": healthy,
        "fallbackCount": fallback_count,
        "fallbacks": fallbacks[:20],
        "issueCount": len(issues),
        "issues": issues[:20],
        "unsupportedCount": len(unsupported_symbols),
        "unsupported": [
            {"symbol": symbol, "reason": "quote source unavailable"}
            for symbol in unsupported_symbols
        ],
        "retentionDays": QUOTE_SNAPSHOT_RETENTION_DAYS,
    }


def mark_background_refresh(owner: str, **updates: Any) -> None:
    with _BACKGROUND_REFRESH_GUARD:
        _BACKGROUND_REFRESH_STATE.update(updates)
    column_map = {
        "lastRunAt": "last_run_at",
        "lastSuccessAt": "last_success_at",
        "lastErrorAt": "last_error_at",
        "lastError": "last_error",
        "runCount": "run_count",
    }
    assignments: list[str] = ["owner = ?"]
    values: list[Any] = [owner]
    for key, value in updates.items():
        column = column_map.get(key)
        if column:
            assignments.append(f"{column} = ?")
            values.append(value)
    values.append(BACKGROUND_JOB_NAME)
    with get_conn() as conn:
        conn.execute(
            f"UPDATE background_jobs SET {', '.join(assignments)} WHERE name = ?",
            values,
        )


def refresh_configured_fund_history() -> list[str]:
    errors: list[str] = []
    full_backfill_started = False
    for code in configured_fund_codes_from_constants():
        try:
            latest_date, _fetched_at = latest_fund_history_meta(code)
            row_count = count_fund_history_rows(code)
            if row_count <= FUND_HISTORY_AUTO_REFRESH_ROWS + 20 and not full_backfill_started:
                fetch_and_store_fund_history(code, MAX_FUND_HISTORY_REFRESH_ROWS, refresh=True)
                full_backfill_started = True
            elif latest_date:
                auto_refresh_fund_history_if_stale(code, FUND_HISTORY_AUTO_REFRESH_ROWS)
            else:
                fetch_and_store_fund_history(code, FUND_HISTORY_AUTO_REFRESH_ROWS, refresh=True)
        except Exception as exc:
            errors.append(f"fund {code}: {exc}")
    return errors


def refresh_configured_market_history() -> list[str]:
    errors: list[str] = []
    for item in configured_market_return_items_from_constants():
        try:
            source, symbol = item.split(":", 1)
            if source == "twse-official" and symbol == "TWII":
                with get_conn() as conn:
                    row_count = int(conn.execute(
                        "SELECT COUNT(*) FROM market_history WHERE source = ? AND symbol = ?",
                        (source, symbol),
                    ).fetchone()[0])
                refresh_twse_history(60 if row_count < 500 else 1, force_refresh=False)
                continue
            if market_history_should_refresh_for_returns(source, symbol):
                schedule_market_history_refresh(source, symbol)
        except Exception as exc:
            errors.append(f"market {item}: {exc}")
    return errors


def run_background_refresh_once(owner: str = "manual") -> bool:
    if not claim_background_job(owner):
        return False
    now = now_ms()
    run_count = int(background_refresh_state_snapshot().get("runCount", 0) or 0) + 1
    with _BACKGROUND_REFRESH_GUARD:
        _BACKGROUND_REFRESH_STATE["lastRunAt"] = now
        _BACKGROUND_REFRESH_STATE["runCount"] = run_count
    mark_background_refresh(owner, lastRunAt=now, runCount=run_count)

    errors: list[str] = []
    errors.extend(refresh_configured_fund_history())
    errors.extend(refresh_configured_market_history())
    try:
        prewarm_response_cache()
    except Exception as exc:
        errors.append(f"prewarm: {exc}")
    try:
        prewarm_fund_nav_cache_async()
    except Exception as exc:
        errors.append(f"fundnav: {exc}")
    try:
        holdings_result = refresh_latest_fund_holdings()
        errors.extend(f"fund-holdings: {error}" for error in holdings_result["errors"])
    except Exception as exc:
        errors.append(f"fund-holdings: {exc}")
    try:
        symbols = configured_sina_symbols_from_constants()
        if symbols:
            build_dashboard_payload(symbols, [], "")
            snapshot_health = quote_snapshot_health()
            if snapshot_health["issueCount"]:
                print(
                    f"[quote-diagnostics] {snapshot_health['issueCount']}/{snapshot_health['total']} issues",
                    flush=True,
                )
    except Exception as exc:
        errors.append(f"quotes: {exc}")
    try:
        prune_quote_snapshots()
    except Exception as exc:
        errors.append(f"snapshot-prune: {exc}")

    response_cache_clear_prefix("api:datahealth")
    if errors:
        mark_background_refresh(owner, lastErrorAt=now_ms(), lastError="; ".join(errors[:5])[:480])
    else:
        mark_background_refresh(owner, lastSuccessAt=now_ms(), lastError="")
    return True


def prune_in_memory_caches() -> None:
    """Evict idle/expired entries from the unbounded in-memory dicts.

    Long-running processes otherwise leak per-cache-key locks, rate-limit
    buckets, and response-cache entries that are never revisited.
    """
    now = time.monotonic()
    # Rate-limit buckets: drop buckets with no entries in the last 10 min.
    with _RATE_LIMIT_GUARD:
        for key in list(_RATE_LIMIT_BUCKETS):
            bucket = _RATE_LIMIT_BUCKETS[key]
            if not bucket or now - bucket[-1] > 600:
                _RATE_LIMIT_BUCKETS.pop(key, None)
    # Response cache: drop expired entries (lazy TTL check on access misses
    # unrevisited keys, so proactively drop anything past its deadline).
    with _RESPONSE_CACHE_GUARD:
        for key in list(_RESPONSE_CACHE):
            entry = _RESPONSE_CACHE.get(key)
            if entry and entry[0] <= now:
                _RESPONSE_CACHE.pop(key, None)
    # Upstream locks: this dict grows by unique cache_key, but cache keys are
    # bounded by the configured symbol set (~160 symbols + a fixed set of fund
    # codes), so it does not grow unbounded in practice. We intentionally do NOT
    # prune locks here: dropping a lock that a fetcher has already retrieved but
    # not yet acquired would let the next fetcher create a fresh lock and both
    # would proceed, defeating single-flight dedup. The bounded key space makes
    # this a non-leak.


def background_refresh_loop(owner: str | None = None) -> None:
    worker_owner = owner or f"embedded:{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:8]}"
    with app.app_context():
        while True:
            run_background_refresh_once(worker_owner)
            prune_in_memory_caches()
            time.sleep(max(BACKGROUND_REFRESH_INTERVAL_SECONDS, 60))


def start_background_refresh_scheduler() -> None:
    if os.environ.get("FUND_VALUATION_BACKGROUND_REFRESH", "0") != "1":
        return
    with _BACKGROUND_REFRESH_GUARD:
        if _BACKGROUND_REFRESH_STATE.get("started"):
            return
        _BACKGROUND_REFRESH_STATE["started"] = True
    worker = threading.Thread(target=background_refresh_loop, daemon=True, name="fund-valuation-refresh")
    worker.start()


@app.before_request
def mark_request_start() -> None:
    g.request_started_at = time.perf_counter()
    incoming_request_id = request.headers.get("X-Request-ID", "")
    g.request_id = incoming_request_id if re.fullmatch(r"[A-Za-z0-9_.:-]{1,80}", incoming_request_id) else uuid.uuid4().hex


@app.after_request
def add_response_headers(response: Response) -> Response:
    started_at = getattr(g, "request_started_at", None)
    if isinstance(started_at, float):
        elapsed_ms = (time.perf_counter() - started_at) * 1000
        response.headers["X-Elapsed-ms"] = f"{elapsed_ms:.1f}"
        route = request.url_rule.rule if request.url_rule else request.path
        cache_status = response.headers.get("X-Cache", "")
        REQUEST_METRICS.record(route, response.status_code, elapsed_ms, cache_status)
        if elapsed_ms >= SLOW_REQUEST_LOG_MS:
            log_event(
                "slow_request",
                requestId=getattr(g, "request_id", ""),
                method=request.method,
                route=route,
                status=response.status_code,
                durationMs=round(elapsed_ms, 1),
                cache=cache_status or "NONE",
            )
    response.headers["X-Request-ID"] = getattr(g, "request_id", "")
    response.headers["X-API-Schema-Version"] = str(API_SCHEMA_VERSION)
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Diagnostics-Token"
    response.headers["Access-Control-Expose-Headers"] = "X-Request-ID, X-Elapsed-ms, X-API-Schema-Version, X-Cache"
    return response


@app.errorhandler(Exception)
def handle_error(exc: Exception) -> Response:
    if isinstance(exc, HTTPException):
        return json_response({"error": exc.description}, status=exc.code or 500)
    if isinstance(exc, ValueError):
        return json_response({"error": str(exc) or "Invalid request"}, status=400)
    # Do not echo str(exc) for unexpected errors — it may leak upstream URLs/paths.
    log_event(
        "request_error",
        requestId=getattr(g, "request_id", ""),
        route=request.path,
        exception=type(exc).__name__,
        message=str(exc)[:300],
    )
    return json_response({"error": "Upstream data error"}, status=502)


@app.get("/api/health")
def health() -> Response:
    return jsonify({"ok": True})


@app.get("/api/meta")
def api_meta() -> Response:
    enforce_rate_limit("meta")
    return jsonify({
        "apiSchemaVersion": API_SCHEMA_VERSION,
        "dashboardSchemaVersion": DASHBOARD_SCHEMA_VERSION,
    })


@app.get("/api/ready")
def readiness() -> Response:
    try:
        with get_conn() as conn:
            conn.execute("SELECT 1").fetchone()
            database_version = int(conn.execute("PRAGMA user_version").fetchone()[0])
    except sqlite3.Error:
        return jsonify({"ready": False, "database": "unavailable"}), 503
    if database_version != SCHEMA_VERSION:
        return jsonify({"ready": False, "database": "migration-required", "schemaVersion": database_version}), 503
    worker = background_refresh_state_snapshot()
    return jsonify({
        "ready": True,
        "database": "ok",
        "schemaVersion": database_version,
        "workerLastSuccessAt": int(worker.get("lastSuccessAt", 0) or 0),
    })


@app.get("/api/datahealth")
def data_health() -> Response:
    enforce_rate_limit("datahealth")
    return cached_json_response("api:datahealth", 30, build_data_health_payload)


@app.get("/api/status")
def public_status() -> Response:
    enforce_rate_limit("status")

    def build() -> dict[str, Any]:
        quote_state = quote_snapshot_health()
        worker = background_refresh_state_snapshot()
        worker_last_success = int(worker.get("lastSuccessAt", 0) or 0)
        worker_fresh = worker_last_success > 0 and now_ms() - worker_last_success <= 20 * 60 * 1000
        return {
            "status": "ok" if quote_state["issueCount"] == 0 and worker_fresh else "degraded",
            "updatedAt": now_ms(),
            "quoteIssueCount": int(quote_state["issueCount"]),
            "quoteTotal": int(quote_state["total"]),
            "workerLastSuccessAt": worker_last_success,
        }

    return cached_json_response("api:status", 30, build)


@app.get("/api/diagnostics/quotes")
def quote_diagnostics() -> Response:
    enforce_rate_limit("diagnostics")
    expected_token = os.environ.get("FUND_VALUATION_DIAGNOSTICS_TOKEN", "")
    provided_token = request.headers.get("X-Diagnostics-Token", "")
    if not expected_token or not hmac.compare_digest(provided_token, expected_token):
        return json_response({"error": "Forbidden"}, status=403)
    payload = quote_snapshot_health()
    payload["backgroundRefresh"] = background_refresh_state_snapshot()
    payload["requestMetrics"] = REQUEST_METRICS.snapshot()
    payload["fxHistory"] = fx_history_summary()
    payload["historyCoverage"] = historical_data_coverage()
    return json_response(payload)


@app.get("/api/sina")
def sina() -> Response:
    enforce_rate_limit("sina")
    refresh = should_refresh()
    symbol_list = sorted(require_symbol_list(
        "list",
        pattern=SINA_SYMBOL_RE,
        max_symbols=MAX_SINA_SYMBOLS_PER_REQUEST,
    ))
    symbols = ",".join(symbol_list)
    now_arg = request.args.get("now", "")
    def build() -> tuple[str, int]:
        ensure_market_calendar_seeded()
        now = parse_market_now(now_arg)
        states = {symbol: market_state_for_symbol(symbol, now) for symbol in symbol_list}
        max_ages = {
            symbol: quote_snapshot_max_age_seconds(symbol, states[symbol])
            for symbol in symbol_list
        }
        snapshot_text, missing = read_latest_quote_snapshot_text(
            symbol_list,
            max_age_seconds=20 * 60,
            max_age_by_symbol=max_ages,
        )
        fetched_text = ""
        status = 200
        if missing and refresh:
            missing_key = ",".join(missing)
            cached_fx = cache_get(f"sina:{missing_key}", 30 * 60) if all(symbol.startswith("fx_") for symbol in missing) else None
            if cached_fx:
                fetched_text = decode_body(cached_fx[2])
            else:
                status, _, body = fetch_upstream(
                    f"https://hq.sinajs.cn/list={missing_key}",
                    referer="https://finance.sina.com.cn/",
                    content_type="text/plain; charset=utf-8",
                    cache_key=f"sina:{missing_key}",
                    kind="sina",
                    ttl_seconds=30,
                )
                if status < 400:
                    fetched_text = decode_body(body)
        combined = snapshot_text + fetched_text
        sanitized_fresh = sanitize_sina_quote_text(combined, symbol_list, now)
        resolved_symbols = set(quote_lines_by_symbol(sanitized_fresh))
        snapshot_symbols = [
            symbol for symbol in missing
            if market_key_for_symbol(symbol) and symbol in resolved_symbols
        ]
        if snapshot_symbols and fetched_text:
            store_quote_snapshots(fetched_text, sanitized_fresh, snapshot_symbols, states, now)
        unresolved = [symbol for symbol in symbol_list if symbol not in resolved_symbols]
        stale_text, _ = read_latest_quote_snapshot_text(unresolved)
        if stale_text:
            for symbol in quote_lines_by_symbol(stale_text):
                record_quote_health(symbol, "stale", "latest valid snapshot used after upstream miss")
        sanitized = sanitized_fresh + stale_text
        return sanitized, status
    return cached_text_response(f"api:sina:{int(refresh)}:{now_arg}:{symbols}", 15, build)


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


def build_dashboard_payload(
    symbols: list[str],
    currencies: list[str],
    now_arg: str,
    *,
    allow_upstream: bool = True,
) -> dict[str, Any]:
    ensure_market_calendar_seeded()
    now = parse_market_now(now_arg)
    market_states = {symbol: market_state_for_symbol(symbol, now) for symbol in symbols}
    sina_text = ""
    fetched_symbols: list[str] = []
    if symbols:
        if allow_upstream:
            missing_symbols = symbols
        else:
            max_ages = {
                symbol: quote_snapshot_max_age_seconds(symbol, market_states[symbol])
                for symbol in symbols
            }
            sina_text, missing_symbols = read_latest_quote_snapshot_text(
                symbols,
                max_age_seconds=20 * 60,
                max_age_by_symbol=max_ages,
            )
        if missing_symbols and allow_upstream:
            joined_symbols = ",".join(missing_symbols)
            status, _, body = fetch_upstream(
                f"https://hq.sinajs.cn/list={joined_symbols}",
                referer="https://finance.sina.com.cn/",
                content_type="text/plain; charset=utf-8",
                cache_key=f"sina:{joined_symbols}",
                kind="sina",
                ttl_seconds=30,
            )
            if status < 400:
                fetched_text = decode_body(body)
                sina_text += fetched_text
                fetched_symbols = missing_symbols
    raw_sina_text = sina_text if allow_upstream else "\n".join(
        line for symbol, line in quote_lines_by_symbol(sina_text).items() if symbol in fetched_symbols
    )
    fresh_sina_text = sanitize_sina_quote_text(sina_text, symbols, now)
    resolved_symbols = set(quote_lines_by_symbol(fresh_sina_text))
    stale_symbols = [symbol for symbol in symbols if symbol not in resolved_symbols]
    stale_text, _ = read_latest_quote_snapshot_text(stale_symbols)
    if stale_text:
        for symbol in quote_lines_by_symbol(stale_text):
            record_quote_health(symbol, "stale", "latest valid snapshot used after upstream miss")
    sina_text = fresh_sina_text + stale_text

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
        cached_fx = None if allow_upstream else cache_any(f"sina:{joined_fx_symbols}")
        if cached_fx:
            fx_text = decode_body(cached_fx[2])
        elif allow_upstream:
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
        if fx_text:
            store_fx_daily_history(fx_text)

    try:
        captured_symbols = [
            symbol for symbol in (symbols if allow_upstream else fetched_symbols)
            if symbol in resolved_symbols
        ]
        if captured_symbols:
            store_quote_snapshots(raw_sina_text, fresh_sina_text, captured_symbols, market_states, now)
    except Exception as exc:
        print(f"[quote-snapshot] failed: {exc}", flush=True)
    return validate_dashboard_payload({
        "schemaVersion": DASHBOARD_SCHEMA_VERSION,
        "quotesText": sina_text,
        "quotes": normalize_quote_text(sina_text, int(now.timestamp() * 1000)),
        "fxText": fx_text,
        "marketStates": market_states,
    })


DASHBOARD_SNAPSHOT_NAME = "configured"
DISPLAY_FX_CURRENCIES = ["EUR", "HKD", "JPY", "KRW", "USD"]


def store_dashboard_snapshot(payload: dict[str, Any], name: str = DASHBOARD_SNAPSHOT_NAME) -> None:
    generated_at = now_ms()
    stored = dict(payload)
    stored["generatedAt"] = generated_at
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO dashboard_snapshots(name, payload, generated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET
              payload = excluded.payload,
              generated_at = excluded.generated_at
            """,
            (name, json.dumps(stored, ensure_ascii=False), generated_at),
        )


def read_dashboard_snapshot(name: str = DASHBOARD_SNAPSHOT_NAME) -> dict[str, Any] | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT payload, generated_at FROM dashboard_snapshots WHERE name = ?",
            (name,),
        ).fetchone()
    if not row:
        return None
    try:
        payload = json.loads(str(row[0]))
    except (TypeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    payload["generatedAt"] = int(row[1])
    return payload


def filter_dashboard_snapshot(
    payload: dict[str, Any],
    symbols: list[str],
    currencies: list[str],
) -> dict[str, Any]:
    requested_symbols = set(symbols)
    quote_lines = quote_lines_by_symbol(str(payload.get("quotesText") or ""))
    quotes = payload.get("quotes") if isinstance(payload.get("quotes"), dict) else {}
    states = payload.get("marketStates") if isinstance(payload.get("marketStates"), dict) else {}
    fx_symbols = {
        "USD": "fx_susdcny",
        "EUR": "fx_seurcny",
        "JPY": "fx_sjpycny",
        "KRW": "fx_skrwcny",
        "HKD": "fx_shkdcny",
    }
    requested_fx = {fx_symbols[currency] for currency in currencies if currency in fx_symbols}
    fx_lines = quote_lines_by_symbol(str(payload.get("fxText") or ""))
    filtered_quote_text = "\n".join(
        quote_lines[symbol] for symbol in symbols if symbol in quote_lines
    )
    filtered_fx_text = "\n".join(
        fx_lines[symbol] for symbol in requested_fx if symbol in fx_lines
    )
    return validate_dashboard_payload({
        "schemaVersion": DASHBOARD_SCHEMA_VERSION,
        "generatedAt": int(payload.get("generatedAt") or 0),
        "quotesText": filtered_quote_text + ("\n" if filtered_quote_text else ""),
        "quotes": {symbol: value for symbol, value in quotes.items() if symbol in requested_symbols},
        "fxText": filtered_fx_text + ("\n" if filtered_fx_text else ""),
        "marketStates": {symbol: value for symbol, value in states.items() if symbol in requested_symbols},
    })


def publish_dashboard_snapshot() -> dict[str, Any]:
    symbols = configured_quote_symbols()
    payload = build_dashboard_payload(
        symbols,
        DISPLAY_FX_CURRENCIES,
        "",
        allow_upstream=False,
    )
    store_dashboard_snapshot(payload)
    return payload


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
        snapshot = read_dashboard_snapshot() if not now_arg else None
        if snapshot:
            return filter_dashboard_snapshot(snapshot, symbols, currencies)
        return build_dashboard_payload(symbols, currencies, now_arg, allow_upstream=False)

    return cached_json_response(cache_key, 30, build)


@app.get("/api/overview")
def overview() -> Response:
    enforce_rate_limit("overview")
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
    fund_codes = require_fund_codes("fundCodes")
    now_arg = request.args.get("now", "")
    cache_key = f"api:overview:{now_arg}:{','.join(currencies)}:{','.join(fund_codes)}:{','.join(symbols)}"

    def build() -> dict[str, Any]:
        snapshot = read_dashboard_snapshot() if not now_arg else None
        payload = filter_dashboard_snapshot(snapshot, symbols, currencies) if snapshot else build_dashboard_payload(
            symbols,
            currencies,
            now_arg,
            allow_upstream=False,
        )
        payload["fundSummaries"] = {
            code: summary
            for code in fund_codes
            if (summary := read_fund_overview_summary_from_db(code))
        }
        return payload

    return cached_json_response(cache_key, 30, build)


@app.get("/api/fundnav")
def fund_nav() -> Response:
    enforce_rate_limit("fundnav")
    codes = require_fund_codes()
    refresh = should_refresh()
    if refresh:
        payload = fetch_fund_nav_payload(codes)
        return response_cache_set(
            fund_nav_api_cache_key(codes),
            json_response(payload),
            FUND_NAV_CACHE_TTL_SECONDS,
        )
    cache_key = fund_nav_api_cache_key(codes)
    cached = response_cache_get(cache_key, FUND_NAV_CACHE_TTL_SECONDS)
    if cached is not None:
        return cached

    lock = upstream_lock(f"response:{cache_key}")
    with lock:
        cached = response_cache_get(cache_key, FUND_NAV_CACHE_TTL_SECONDS)
        if cached is not None:
            return cached

        payload, needs_refresh = available_fund_nav_payload(codes)
        if payload:
            response = response_cache_set(cache_key, json_response(payload), FUND_NAV_CACHE_TTL_SECONDS)
            response.headers["X-Cache"] = "STALE" if needs_refresh else "HIT"
            response.headers["Cache-Control"] = "public, max-age=5"
            return response

        return response_cache_set(cache_key, json_response({}), FUND_NAV_CACHE_TTL_SECONDS)


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
        if not refresh:
            if cached_rows:
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
        report_date = str(parsed_rows[0].get("reportDate") or "") if parsed_rows else ""
        if parsed_rows and current_fund_holding_report_date(report_date):
            store_fund_holdings(code, parsed_rows)
            persisted_rows = read_fund_holdings_from_db(code)
            if persisted_rows:
                results[code] = persisted_rows
        elif cached_rows:
            results[code] = cached_rows
    return json_response(results)


@app.post("/api/fundvaluationbasis")
def fund_valuation_basis() -> Response:
    enforce_rate_limit("fundvaluationbasis")
    if request.content_length is not None and request.content_length > 64 * 1024:
        return json_response({"error": "Request body too large"}, status=413)
    payload = request.get_json(silent=True)
    raw_items = payload.get("funds") if isinstance(payload, dict) else None
    if not isinstance(raw_items, list) or len(raw_items) > MAX_FUND_CODES_PER_REQUEST:
        return json_response({"error": "Invalid funds"}, status=400)

    items: list[dict[str, Any]] = []
    total_symbols = 0
    for raw in raw_items:
        if not isinstance(raw, dict):
            return json_response({"error": "Invalid fund item"}, status=400)
        code = str(raw.get("code") or "")
        nav_date = str(raw.get("navDate") or "")
        symbols = raw.get("symbols")
        currencies = raw.get("currencies")
        if not FUND_CODE_RE.fullmatch(code) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", nav_date):
            return json_response({"error": "Invalid fund code or NAV date"}, status=400)
        if not isinstance(symbols, list) or not isinstance(currencies, list):
            return json_response({"error": "Invalid valuation symbols"}, status=400)
        normalized_symbols = sorted(dict.fromkeys(str(value) for value in symbols))
        normalized_currencies = sorted(dict.fromkeys(str(value) for value in currencies))
        total_symbols += len(normalized_symbols)
        if (
            len(normalized_symbols) > 30
            or total_symbols > 1000
            or any(not SINA_SYMBOL_RE.fullmatch(symbol) for symbol in normalized_symbols)
            or any(currency not in {"CNY", "USD", "EUR", "JPY", "KRW", "HKD"} for currency in normalized_currencies)
        ):
            return json_response({"error": "Invalid valuation symbols"}, status=400)
        items.append({
            "code": code,
            "navDate": nav_date,
            "symbols": normalized_symbols,
            "currencies": normalized_currencies,
        })
    return json_response(read_fund_valuation_basis(items))


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
                results[code] = cached_rows
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
            summary = read_fund_return_summary_from_db(code)
            if summary:
                results[code] = summary
        return results

    return cached_json_response(cache_key, 5 * 60, build)


@app.get("/api/fundprofiles")
def fund_profiles() -> Response:
    enforce_rate_limit("fundprofiles")
    codes = require_fund_codes()
    refresh = should_refresh()
    if refresh:
        enforce_rate_limit("fundprofiles_refresh")
        refresh_fund_profiles(codes, force_refresh=True)
    results = read_fund_profiles_from_db(codes)
    missing = [code for code in codes if code not in results]
    if missing and not refresh:
        # A detail request for a newly added fund may be the first time its
        # profile is needed. Fetch only those missing records synchronously;
        # configured funds are normally prewarmed by the worker.
        refresh_fund_profiles(missing)
        results.update(read_fund_profiles_from_db(missing))
    stale = set(codes) - set(read_fund_profiles_from_db(codes, FUND_PROFILE_REFRESH_TTL_SECONDS))
    if stale and not refresh:
        schedule_fund_profile_refresh(sorted(stale))
    return json_response(results)


@app.get("/api/fundpurchase")
def fund_purchase() -> Response:
    enforce_rate_limit("fundpurchase")
    codes = require_fund_codes()
    ttl_seconds = 6 * 60 * 60
    refresh = should_refresh()
    if refresh:
        enforce_rate_limit("fundpurchase_refresh")

    cached_results = read_purchase_status_from_db(codes, ttl_seconds)
    if not refresh and len(cached_results) >= len(set(codes)):
        return json_response(cached_results)

    if refresh:
        fetch_and_store_purchase_status(force_refresh=True)
        return json_response(read_purchase_status_from_db(codes, ttl_seconds))

    stale_results = read_purchase_status_from_db(codes, None)
    if stale_results:
        response = json_response(stale_results)
        response.headers["X-Cache"] = "STALE"
        response.headers["Cache-Control"] = "public, max-age=60"
        return response

    return json_response({})


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
    if source == "twse-official" and symbol == "TWII":
        month = datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y%m01")
        return (
            f"https://www.twse.com.tw/rwd/en/TAIEX/MI_5MINS_HIST?date={month}&response=json",
            "https://www.twse.com.tw/en/indices/taiex/mi-5min-hist.html",
        )
    if source == "naver-korea" and symbol == "KOSPI":
        current = datetime.now(ZoneInfo("Asia/Shanghai"))
        start = f"{current.year - 10}0101"
        end = current.strftime("%Y%m%d")
        query = urlencode({
            "symbol": symbol,
            "requestType": 1,
            "startTime": start,
            "endTime": end,
            "timeframe": "day",
        })
        return (
            f"https://api.finance.naver.com/siseJson.naver?{query}",
            "https://finance.naver.com/sise/sise_index.naver?code=KOSPI",
        )
    raise ValueError("Unsupported source")


def eastmoney_kospi_history_text(ttl_seconds: int, *, force_refresh: bool) -> str | None:
    query = urlencode({
        "secid": "100.KS11",
        "fields1": "f1,f2,f3,f4,f5,f6",
        "fields2": "f51,f52,f53,f54,f55,f56",
        "klt": "101",
        "fqt": "0",
        "end": "20500101",
        "lmt": "3000",
    })
    payload = fetch_eastmoney_json(
        f"https://push2his.eastmoney.com/api/qt/stock/kline/get?{query}",
        cache_key="markethistory-fallback:eastmoney:100.KS11",
        kind="markethistory-fallback",
        ttl_seconds=0 if force_refresh else ttl_seconds,
    )
    data = payload.get("data") if isinstance(payload, dict) else None
    klines = data.get("klines") if isinstance(data, dict) else None
    if not isinstance(klines, list):
        return None
    rows: list[dict[str, Any]] = []
    for raw in klines:
        fields = str(raw).split(",")
        if len(fields) < 3 or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", fields[0]):
            continue
        try:
            close = float(fields[2])
        except (TypeError, ValueError):
            continue
        if close > 0:
            rows.append({"date": fields[0], "close": close})
    return json.dumps(rows, ensure_ascii=False) if rows else None


def fetch_market_history_payload(
    source: str,
    symbol: str,
    *,
    ttl_seconds: int,
    force_refresh: bool = False,
) -> tuple[int, str, bytes]:
    url, referer = market_history_url(source, symbol)
    try:
        status, content_type, body = fetch_upstream(
            url,
            referer=referer,
            content_type="application/json; charset=utf-8",
            cache_key=f"markethistory:{source}:{symbol}",
            kind="markethistory",
            ttl_seconds=ttl_seconds,
            force_refresh=force_refresh,
        )
    except Exception:
        if source != "naver-korea":
            raise
        status, content_type, body = 599, "application/json; charset=utf-8", b""

    if source != "naver-korea" or (status < 400 and parse_naver_korea_history(decode_body(body))):
        return status, content_type, body

    fallback = eastmoney_kospi_history_text(ttl_seconds, force_refresh=force_refresh)
    if not fallback:
        return status, content_type, body
    fallback_body = fallback.encode("utf-8")
    cache_put(
        f"markethistory:{source}:{symbol}",
        "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=100.KS11",
        200,
        "application/json; charset=utf-8",
        fallback_body,
    )
    return 200, "application/json; charset=utf-8", fallback_body


def refresh_twse_history(months: int = 1, *, force_refresh: bool = False) -> int:
    current = datetime.now(ZoneInfo("Asia/Shanghai"))
    stored = 0
    for months_back in range(max(1, months)):
        month_index = current.year * 12 + current.month - 1 - months_back
        year, zero_based_month = divmod(month_index, 12)
        month_key = f"{year:04d}{zero_based_month + 1:02d}01"
        status, _, body = fetch_upstream(
            f"https://www.twse.com.tw/rwd/en/TAIEX/MI_5MINS_HIST?date={month_key}&response=json",
            referer="https://www.twse.com.tw/en/indices/taiex/mi-5min-hist.html",
            content_type="application/json; charset=utf-8",
            cache_key=f"markethistory:twse-official:TWII:{month_key}",
            kind="markethistory",
            ttl_seconds=300,
            force_refresh=force_refresh,
        )
        if status < 400:
            stored += store_market_history("twse-official", "TWII", decode_body(body))
        if months > 1:
            time.sleep(0.1)
    return stored


@app.get("/api/markethistory")
def market_history() -> Response:
    enforce_rate_limit("markethistory")
    source = require_arg("source")
    symbol = require_arg("symbol")
    if source not in MARKET_HISTORY_SOURCES:
        raise ValueError("Unsupported source")
    if not MARKET_HISTORY_SYMBOL_RE.fullmatch(symbol):
        raise ValueError("Invalid symbol")
    refresh = should_refresh()
    if refresh:
        enforce_rate_limit("markethistory_refresh")
    cached_rows = read_market_history_from_db(source, symbol)
    if not refresh:
        if cached_rows:
            return json_response(read_market_history_from_db(
                source,
                symbol,
                adjust_corporate_actions=True,
            ) or cached_rows)
        return json_response(cached_rows)

    status, content_type, body = fetch_market_history_payload(
        source,
        symbol,
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
            return json_response(read_market_history_from_db(source, symbol, adjust_corporate_actions=True) or cached_rows)
    else:
        if stored_count == 0 and cached_rows:
            return json_response(read_market_history_from_db(source, symbol, adjust_corporate_actions=True) or cached_rows)
        if source == "naver-korea":
            return json_response(read_market_history_from_db(source, symbol))
        if cn_etf_history_needs_adjustment(source, symbol):
            return json_response(read_market_history_from_db(source, symbol, adjust_corporate_actions=True))
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
        if source not in MARKET_HISTORY_SOURCES:
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
            prewarm_fund_nav_cache_async()
    if not args.debug or os.environ.get("WERKZEUG_RUN_MAIN") == "true":
        start_background_refresh_scheduler()
    print(f"Flask backend listening on http://{args.host}:{args.port}")
    print(f"SQLite database: {DB_PATH}")
    app.run(host=args.host, port=args.port, debug=args.debug, threaded=True)


if __name__ == "__main__":
    main()
