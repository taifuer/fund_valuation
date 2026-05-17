from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
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

            CREATE TABLE IF NOT EXISTS market_history (
              source TEXT NOT NULL,
              symbol TEXT NOT NULL,
              date TEXT NOT NULL,
              close REAL NOT NULL,
              fetched_at INTEGER NOT NULL,
              PRIMARY KEY (source, symbol, date)
            );

            CREATE TABLE IF NOT EXISTS market_intraday (
              source TEXT NOT NULL,
              symbol TEXT NOT NULL,
              datetime TEXT NOT NULL,
              close REAL NOT NULL,
              fetched_at INTEGER NOT NULL,
              PRIMARY KEY (source, symbol, datetime)
            );
            """
        )


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


def us_intraday_to_beijing(value: str) -> str:
    match = re.match(r"^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2}(?::\d{2})?)$", value)
    if not match:
        return value
    try:
        local_dt = datetime.fromisoformat(f"{match.group(1)} {match.group(2)}")
    except ValueError:
        return value

    if local_dt.hour < 9 or local_dt.hour > 16:
        return value

    eastern_dt = local_dt.replace(tzinfo=ZoneInfo("America/New_York"))
    beijing_dt = eastern_dt.astimezone(ZoneInfo("Asia/Shanghai"))
    return beijing_dt.strftime("%Y-%m-%d %H:%M:%S")


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


def store_market_history(source: str, symbol: str, text: str) -> None:
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
        return
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


def store_market_intraday(source: str, symbol: str, text: str) -> None:
    raw_points: list[tuple[str, float]] = []
    if source == "sina-cn":
        parsed = json.loads(text)
        rows = parsed if isinstance(parsed, list) else []
        for row in rows:
            try:
                raw_points.append((str(row.get("day") or ""), float(row.get("close") or 0)))
            except (TypeError, ValueError):
                continue
    elif source == "sina-us":
        for row in parse_sina_array_jsonp(text):
            try:
                raw_points.append((us_intraday_to_beijing(str(row.get("d") or "")), float(row.get("c") or 0)))
            except (TypeError, ValueError):
                continue
    elif source == "sina-futures":
        parsed = json.loads(text)
        rows = parsed.get("minLine_1d") if isinstance(parsed, dict) else []
        if isinstance(rows, list):
            for row in rows:
                if not isinstance(row, list):
                    continue
                try:
                    is_head = len(row) >= 10
                    dt = str(row[9] if is_head else row[5])
                    close = float(row[5] if is_head else row[1])
                    raw_points.append((dt, close))
                except (IndexError, TypeError, ValueError):
                    continue

    points = []
    fetched_at = now_ms()
    for dt, close in raw_points:
        if re.match(r"^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(:\d{2})?$", dt) and close > 0:
            points.append((source, symbol, dt, close, fetched_at))
    if not points:
        return
    with sqlite3.connect(DB_PATH) as conn:
        conn.executemany(
            """
            INSERT INTO market_intraday(source, symbol, datetime, close, fetched_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(source, symbol, datetime) DO UPDATE SET
              close = excluded.close,
              fetched_at = excluded.fetched_at
            """,
            points,
        )


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


def read_market_intraday_from_db(source: str, symbol: str) -> list[dict[str, float | str]]:
    with sqlite3.connect(DB_PATH) as conn:
        latest = conn.execute(
            """
            SELECT datetime
            FROM market_intraday
            WHERE source = ? AND symbol = ?
            ORDER BY datetime DESC
            LIMIT 1
            """,
            (source, symbol),
        ).fetchone()
        if not latest:
            return []
        latest_dt = str(latest[0])
        try:
            latest_date = datetime.fromisoformat(latest_dt[:10]).date()
            today = datetime.now(ZoneInfo("Asia/Shanghai")).date()
            if abs((today - latest_date).days) > 5:
                return []
        except ValueError:
            return []
        if source == "sina-us":
            try:
                parsed_latest = datetime.fromisoformat(latest_dt)
            except ValueError:
                parsed_latest = None
            if parsed_latest and parsed_latest.hour <= 5:
                start_day = (parsed_latest.date() - timedelta(days=1)).isoformat()
                end_day = parsed_latest.date().isoformat()
                rows = conn.execute(
                    """
                    SELECT datetime, close
                    FROM market_intraday
                    WHERE source = ? AND symbol = ? AND datetime >= ? AND datetime <= ?
                    ORDER BY datetime ASC
                    """,
                    (source, symbol, f"{start_day} 20:00:00", f"{end_day} 06:00:00"),
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT datetime, close
                    FROM market_intraday
                    WHERE source = ? AND symbol = ? AND substr(datetime, 1, 10) = ?
                    ORDER BY datetime ASC
                    """,
                    (source, symbol, latest_dt[:10]),
                ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT datetime, close
                FROM market_intraday
                WHERE source = ? AND symbol = ? AND substr(datetime, 1, 10) = ?
                ORDER BY datetime ASC
                """,
                (source, symbol, latest_dt[:10]),
            ).fetchall()
    return [{"date": str(dt), "close": float(close)} for dt, close in rows]


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
    symbols = require_arg("list")
    url = f"https://hq.sinajs.cn/list={symbols}"
    status, content_type, body = fetch_upstream(
        url,
        referer="https://finance.sina.com.cn/",
        content_type="text/plain; charset=utf-8",
        cache_key=f"sina:{symbols}",
        kind="sina",
        ttl_seconds=30,
    )
    return bytes_response(body, status=status, content_type=content_type)


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


@app.get("/api/fundhistory")
def fund_history() -> Response:
    codes = require_arg("codes").split(",")
    page_size = clamp_int(request.args.get("pageSize", "2"), 2, 5000, 2)
    page_index = max(clamp_int(request.args.get("pageIndex", "1"), 1, 100000, 1), 1)
    refresh = should_refresh()
    results: dict[str, Any] = {}
    for code in codes:
        if not refresh:
            cached_rows = read_fund_history_from_db(code, page_size, page_index)
            if len(cached_rows) >= page_size or (page_size > 200 and cached_rows):
                results[code] = cached_rows
                continue

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
        )
        if status >= 400:
            continue
        parsed = parse_jsonp_call(decode_body(body), "jQuery")
        data = parsed.get("Data") if isinstance(parsed, dict) else None
        rows = data.get("LSJZList") if isinstance(data, dict) else None
        if isinstance(rows, list):
            results[code] = rows
            store_fund_history(code, rows)
    return json_response(results)


@app.get("/api/fundreturns")
def fund_returns() -> Response:
    codes = [code for code in require_arg("codes").split(",") if code]
    results: dict[str, Any] = {}
    for code in codes:
        summary = read_fund_return_summary_from_db(code)
        if summary:
            results[code] = summary
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
    if not should_refresh():
        rows = read_market_history_from_db(source, symbol)
        if rows:
            return json_response(rows)

    url, referer = market_history_url(source, symbol)
    status, content_type, body = fetch_upstream(
        url,
        referer=referer,
        content_type="application/json; charset=utf-8",
        cache_key=f"markethistory:{source}:{symbol}",
        kind="markethistory",
        ttl_seconds=300,
    )
    if status < 400:
        try:
            store_market_history(source, symbol, decode_body(body))
        except Exception:
            pass
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


def market_intraday_url(source: str, symbol: str) -> tuple[str, str]:
    if source == "sina-cn":
        return (
            f"https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketData.getKLineData?symbol={quote(symbol)}&scale=1&ma=no&datalen=300",
            "https://finance.sina.com.cn/",
        )
    if source == "sina-us":
        return (
            f"https://stock.finance.sina.com.cn/usstock/api/jsonp.php/var%20_=/US_MinKService.getMinK?symbol={quote(symbol)}&type=1",
            "https://finance.sina.com.cn/stock/usstock/",
        )
    if source == "sina-futures":
        return (
            f"https://stock2.finance.sina.com.cn/futures/api/json.php/GlobalFuturesService.getGlobalFuturesMinLine?symbol={quote(symbol)}",
            "https://finance.sina.com.cn/futures/",
        )
    raise ValueError("Unsupported source")


@app.get("/api/marketintraday")
def market_intraday() -> Response:
    source = require_arg("source")
    symbol = require_arg("symbol")
    if not should_refresh():
        rows = read_market_intraday_from_db(source, symbol)
        if rows:
            return json_response(rows)

    url, referer = market_intraday_url(source, symbol)
    status, content_type, body = fetch_upstream(
        url,
        referer=referer,
        content_type="application/json; charset=utf-8",
        cache_key=f"marketintraday:{source}:{symbol}",
        kind="marketintraday",
        ttl_seconds=30,
    )
    if status < 400:
        try:
            store_market_intraday(source, symbol, decode_body(body))
        except Exception:
            pass
        rows = read_market_intraday_from_db(source, symbol)
        if rows:
            return json_response(rows)
        if source == "sina-us":
            return json_response([])
    return bytes_response(body, status=status, content_type=content_type)


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
