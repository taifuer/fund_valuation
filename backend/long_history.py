"""Monthly closing-price archive and calendar-year returns, maintained off request paths."""
from __future__ import annotations

import argparse
import calendar
import csv
import io
import json
import math
import time
from datetime import date, datetime, timedelta
from typing import Any
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

from .config import load_universe
from .storage import get_conn

SNAPSHOT_PREFIX = "long-history:"
SOURCE_NAMES = {
    "tencent": "腾讯财经", "nikkei": "日经指数官方", "naver": "Naver Finance",
    "twse": "台湾证交所", "coinmetrics": "Coin Metrics", "sina": "新浪财经",
    "fred": "FRED", "yahoo": "Yahoo Finance",
}


def assets() -> list[dict[str, Any]]:
    universe = load_universe()
    result: dict[str, dict[str, Any]] = {}
    for item in [*universe["indices"], *universe["rankingIndices"], *universe["marketAssets"]]:
        key = item["symbol"]
        if key in result:
            continue
        source = item["history"]["source"]
        group = ("assets" if item in universe["marketAssets"] else
                 "china" if source == "sina-cn" else "usa" if source == "sina-us" else "asia")
        result[key] = {"id": key, "name": item["name"], "group": group,
                       "quoteSymbol": item["sinaSymbol"], "history": item["history"],
                       "basis": "futures" if group == "assets" and key != "BTC" else "price",
                       "unit": "USD" if group == "assets" else "点"}
    return list(result.values())


def valid_point(day: str, value: Any, *, source: str, url: str) -> dict[str, Any] | None:
    try:
        parsed = date.fromisoformat(day)
        close = float(str(value).replace(",", ""))
    except (TypeError, ValueError):
        return None
    # Negative oil settlements remain real prices; never silently replace them with zero.
    if parsed.year < 1900 or not math.isfinite(close):
        return None
    return {"period": day[:7], "date": day, "close": close, "source": source, "sourceUrl": url}


def month_end_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_month: dict[str, dict[str, Any]] = {}
    for row in sorted(rows, key=lambda point: point["date"]):
        by_month[row["period"]] = row
    return list(by_month.values())


def parse_tencent(text: str, symbol: str, url: str) -> list[dict[str, Any]]:
    payload = json.loads(text)
    data = payload.get("data", {}).get(symbol, {})
    rows = data.get("month")
    if payload.get("code") != 0 or not isinstance(rows, list):
        raise ValueError("Missing Tencent monthly series")
    return [point for row in rows if isinstance(row, list) and len(row) >= 3
            if (point := valid_point(str(row[0]), row[2], source="tencent", url=url))]


def parse_nikkei(body: bytes, url: str, now: datetime, *, monthly: bool = True) -> list[dict[str, Any]]:
    rows = csv.reader(io.StringIO(body.decode("cp932")))
    result = []
    for row in rows:
        if len(row) < 2:
            continue
        raw = row[0].replace("/", "-")
        point = valid_point(raw, row[1], source="nikkei", url=url)
        if point and (not monthly or point["period"] < now.astimezone(ZoneInfo("Asia/Tokyo")).strftime("%Y-%m")):
            # The CSV labels a month's close with its first day, not the actual closing date.
            if monthly:
                point["date"] = point["period"]
                point['monthComplete'] = True
            result.append(point)
    return result


def parse_twse(text: str, url: str) -> list[dict[str, Any]]:
    payload = json.loads(text)
    if payload.get("stat") != "OK" or not isinstance(payload.get("data"), list):
        raise ValueError("Missing TWSE daily series")
    return [point for row in payload["data"] if isinstance(row, list) and len(row) >= 5
            if (point := valid_point(str(row[0]).replace("/", "-"), row[4], source="twse", url=url))]


def completed_cutoff(asset: dict[str, Any], now: datetime) -> str:
    timezone = "America/New_York" if asset["group"] == "usa" or asset["basis"] == "futures" else "UTC" if asset['id'] == 'BTC' else "Asia/Shanghai"
    local = now.astimezone(ZoneInfo(timezone)).date()
    return (local.replace(day=1) - timedelta(days=1)).isoformat()


def completed_months(rows: list[dict[str, Any]], asset: dict[str, Any], now: datetime) -> list[dict[str, Any]]:
    cutoff = completed_cutoff(asset, now)
    result = []
    for point in month_end_rows(rows):
        if point['period'] > cutoff[:7]:
            continue
        # Tencent's pre-1993 SSE series disagrees with SSE's published yearbooks.
        if asset['id'] == 'SH000001' and point['source'] == 'tencent' and point['period'] < '1993-01':
            continue
        year, month = map(int, point['period'].split('-'))
        expected = date(year, month, calendar.monthrange(year, month)[1])
        if month == 12:
            expected = date.fromisoformat(expected_year_end(year, asset['id']))
        elif asset['id'] != 'BTC':
            while expected.weekday() >= 5:
                expected -= timedelta(days=1)
        if point.get('monthComplete') or point['date'] == point['period'] or point['date'] >= expected.isoformat():
            result.append({**point, 'monthComplete': True})
    return result


def daily_month_ends(rows: list[dict[str, Any]], asset: dict[str, Any], now: datetime) -> list[dict[str, Any]]:
    monthly = month_end_rows(rows)
    latest = monthly[-1]['period'] if monthly else ''
    confirmed = []
    for point in monthly:
        # A later month in the daily archive confirms that this is not a live
        # partial bar. Allow a short holiday closure, but not a stale mid-month tail.
        year, month = map(int, point['period'].split('-'))
        last = date(year, month, calendar.monthrange(year, month)[1])
        tail = (last - date.fromisoformat(point['date'])).days
        if asset['id'] != 'BTC' and point['period'] < latest and 0 <= tail <= 7:
            point = {**point, 'monthComplete': True}
        confirmed.append(point)
    return completed_months(confirmed, asset, now)


def missing_months(points: list[dict[str, Any]], cutoff: str) -> list[str]:
    if not points:
        return []
    existing = {row['period'] for row in points}
    year, month = map(int, min(existing).split('-'))
    result = []
    while f'{year}-{month:02d}' <= cutoff[:7]:
        period = f'{year}-{month:02d}'
        if period not in existing:
            result.append(period)
        year, month = (year + 1, 1) if month == 12 else (year, month + 1)
    return result


def save_points(asset_id: str, rows: list[dict[str, Any]], fetched_at: int) -> int:
    rows = month_end_rows(rows)
    with get_conn() as conn:
        existing = {str(row[0]): (str(row[1]), float(row[2]), str(row[3]), bool(row[4])) for row in conn.execute(
            "SELECT period,date,close,source,month_complete FROM long_market_history WHERE asset_id=?", (asset_id,))}
        # Reject a mismatched provider before writing any part of its series.
        for point in rows:
            old = existing.get(point["period"])
            if old and old[2] != point["source"] and old[0] == point["date"] and old[1] > 0:
                if abs(point["close"] / old[1] - 1) > 0.01:
                    raise ValueError(f"Conflicting closing prices for {asset_id} {point['period']}")
        values = []
        for row in rows:
            old = existing.get(row['period'])
            if old and row['date'] == row['period'] and row.get('monthComplete') and abs(row['close'] - old[1]) <= max(abs(old[1]), 1) * 1e-6:
                row = {**row, 'date': old[0], 'close': old[1]}
            if old and row['date'] < old[0]:
                continue
            complete = bool(row.get('monthComplete')) or bool(old and old[3] and row['date'] == old[0] and row['close'] == old[1])
            values.append((asset_id, row['period'], row['date'], row['close'], row['source'], row['sourceUrl'], fetched_at, int(complete)))
        conn.executemany("""INSERT INTO long_market_history
            (asset_id,period,date,close,source,source_url,fetched_at,month_complete) VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(asset_id,period) DO UPDATE SET date=excluded.date,close=excluded.close,
            source=excluded.source,source_url=excluded.source_url,fetched_at=excluded.fetched_at,month_complete=excluded.month_complete
            WHERE date != excluded.date OR close != excluded.close OR source != excluded.source
                OR source_url != excluded.source_url OR month_complete != excluded.month_complete""", values)
    return len(values)


def read_points(asset_id: str) -> list[dict[str, Any]]:
    with get_conn() as conn:
        rows = conn.execute("SELECT period,date,close,source,source_url,month_complete FROM long_market_history WHERE asset_id=? ORDER BY period", (asset_id,)).fetchall()
    return [{"period": period, "date": day, "close": close, "source": source, "sourceUrl": url, "monthComplete": bool(complete)}
            for period, day, close, source, url, complete in rows]


def stored_daily_points(asset: dict[str, Any], now: datetime) -> list[dict[str, Any]]:
    from .server import read_market_history_from_db, market_history_url
    # Existing NK daily history is a futures proxy, not Nikkei cash history.
    if asset["id"] == "N225":
        return []
    history = asset["history"]
    url, _ = market_history_url(history["source"], history["symbol"])
    source = {"tencent-hk": "tencent", "twse-official": "twse", "naver-korea": "naver",
              "coinmetrics-crypto": "coinmetrics"}.get(history["source"], "sina")
    rows = [point for row in read_market_history_from_db(history["source"], history["symbol"])
            if str(row["date"]) <= now.date().isoformat()
            if (point := valid_point(str(row["date"]), row["close"], source=source, url=url))]
    return daily_month_ends(rows, asset, now)


def expected_year_end(year: int, asset_id: str = "") -> str:
    # Conservative fallback for old years outside the maintained calendar. Full
    # provider month-end labels remain valid without fabricating a trading day.
    last = date(year, 12, 30 if asset_id == "N225" else 31)
    if asset_id != "BTC":
        while last.weekday() >= 5:
            last -= timedelta(days=1)
        if asset_id == "KOSPI":
            last -= timedelta(days=1)
            while last.weekday() >= 5:
                last -= timedelta(days=1)
    return last.isoformat()


def annual_returns(points: list[dict[str, Any]], year: int, *, unfinished_year: int | None = None,
                   asset_id: str = "") -> list[dict[str, Any]]:
    months = {row["period"]: row for row in month_end_rows(points)}
    if not months:
        return []
    first_year = int(min(months)[:4])
    result = []
    for value in range(year, first_year - 1, -1):
        baseline = months.get(f"{value - 1}-12")
        in_year = [row for key, row in months.items() if key.startswith(f"{value}-")]
        end = max(in_year, key=lambda row: row["period"]) if in_year else None
        reason = ""
        if value == unfinished_year:
            reason = "该市场年度尚未结束"
        elif not baseline:
            reason = "缺少上年末基准" if value != first_year else "首年非完整年度"
        elif not baseline.get('monthComplete') and baseline["date"] != baseline["period"] and baseline["date"] < expected_year_end(value - 1, asset_id):
            reason = "上年末数据不完整"
        elif end is None or (value < year and (end["period"] != f"{value}-12"
                or (not end.get('monthComplete') and end["date"] != end["period"] and end["date"] < expected_year_end(value, asset_id)))):
            reason = "年末数据不完整"
        elif baseline["close"] <= 0 or any(row["close"] <= 0 for row in in_year):
            reason = "非正价格，不计算比例收益"
        # Interior gaps do not invalidate an independently verified pair of year-end prices.
        change = None if reason or not end else (end["close"] / baseline["close"] - 1) * 100
        if change is not None and not math.isfinite(change):
            change, reason = None, "价格异常，不计算比例收益"
        result.append({"year": value, "return": change, "startDate": baseline["date"] if baseline else None,
                       "startClose": baseline["close"] if baseline else None,
                       "endDate": end["date"] if end else None, "endClose": end["close"] if end else None,
                       "reason": reason, "yearToDate": value == year,
                       "sourceUrl": end["sourceUrl"] if end else None})
    return result


def month_number(period: str) -> int:
    year, month = map(int, period.split('-'))
    return year * 12 + month - 1


def period_performance(points: list[dict[str, Any]], start: str | None, end: str | None) -> dict[str, Any]:
    result = {'startPeriod': start, 'endPeriod': end, 'months': 0, 'change': None, 'cagr': None,
              'reason': '', 'cagrReason': ''}
    if not start or not end or start >= end:
        return {**result, 'reason': '缺少可比较的完整区间'}
    months = month_number(end) - month_number(start)
    result['months'] = months
    available = {row['period']: row for row in points if start <= row['period'] <= end}
    if start not in available or end not in available:
        return {**result, 'reason': '缺少区间起止月数据'}
    if any(not math.isfinite(row['close']) or row['close'] <= 0 for row in available.values()):
        return {**result, 'reason': '非正或异常价格，不计算比例涨跌'}
    initial, final = available[start]['close'], available[end]['close']
    change = (final / initial - 1) * 100
    if not math.isfinite(change):
        return {**result, 'reason': '价格异常，不计算比例涨跌'}
    result['change'] = change
    if months < 12:
        result['cagrReason'] = '区间不足1年，不计算年化'
    else:
        try:
            cagr = math.expm1((math.log(final) - math.log(initial)) * 12 / months) * 100
            if not math.isfinite(cagr):
                raise ValueError('Non-finite annualized change')
            result['cagr'] = cagr
        except (ValueError, OverflowError):
            result['cagrReason'] = '价格异常，不计算年化'
    return result


def range_performances(points: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    result = {}
    for span in ('5', '10', '20', 'all'):
        last = points[-1]['period'] if points else None
        cutoff = f'{int(last[:4]) - int(span)}{last[4:]}' if last and span != 'all' else ''
        selected = [row for row in points if row['period'] >= cutoff]
        result[span] = period_performance(selected, selected[0]['period'] if selected else None, last)
    return result


def comparison_windows(catalog: list[dict[str, Any]], series: dict[str, list[dict[str, Any]]],
                       current_year: int) -> dict[str, Any]:
    groups = {}
    for group in ('all', 'china', 'usa', 'asia', 'assets'):
        selected = [asset for asset in catalog if group == 'all' or asset['group'] == group]
        cutoff = min((asset['completedThrough'] for asset in selected), default=f'{current_year - 1}-12')
        last_year = min(current_year - 1, int(cutoff[:4]) - (cutoff[5:] != '12'))
        end = f'{last_year}-12'
        # Count whole calendar years. The displayed January start is measured
        # against the preceding December, never against January's closing price.
        decembers = [{point['period'] for point in series[asset['id']]
                      if point['period'].endswith('-12') and point['period'] < end}
                     for asset in selected if series[asset['id']]]
        common = sorted(set.intersection(*decembers)) if decembers else []
        ranges = {}
        for span in ('5', '10', '20', 'all'):
            baseline = (common[0] if common else None) if span == 'all' else f'{last_year - int(span)}-12'
            start = f'{int(baseline[:4]) + 1}-01' if baseline else None
            rows = [{'id': asset['id'], **period_performance(series[asset['id']], baseline, end)} for asset in selected]
            ranges[span] = {'startPeriod': start, 'endPeriod': end, 'rows': rows}
        groups[group] = ranges
    return groups


def publish(now: datetime | None = None) -> dict[str, Any]:
    from .server import store_dashboard_snapshot
    now = now or datetime.now(ZoneInfo("Asia/Shanghai"))
    catalog = []
    series = {}
    for asset in assets():
        points = completed_months(read_points(asset["id"]), asset, now)
        series[asset['id']] = points
        with get_conn() as conn:
            state = conn.execute("SELECT success_at,error FROM long_history_sync WHERE asset_id=?", (asset["id"],)).fetchone()
        note = "连续期货价格，包含换月影响，不等于持有收益。" if asset["basis"] == "futures" else "价格涨跌，不含股息再投资。"
        if asset["id"] == "INX" and points and points[0]["period"] < "1957-03":
            note += "1957 年正式发布前为回溯历史口径。"
        if asset['id'] == 'SH000001':
            note += '1993 年前的来源记录异常，暂不纳入。'
        description = {key: asset[key] for key in ("id", "name", "group", "basis", "unit")}
        timezone = "America/New_York" if asset["group"] == "usa" or asset["basis"] == "futures" else "UTC" if asset["id"] == "BTC" else "Asia/Shanghai"
        local_year = now.astimezone(ZoneInfo(timezone)).year
        description.update({"firstDate": points[0]["date"] if points else None,
                            "lastDate": points[-1]["date"] if points else None,
                            "count": len(points), "note": note, "frequency": "monthly",
                            "completedThrough": completed_cutoff(asset, now)[:7],
                            "missingMonths": missing_months(points, completed_cutoff(asset, now)),
                            "sources": [SOURCE_NAMES.get(key, key) for key in dict.fromkeys(p["source"] for p in points)],
                            "refreshFailed": bool(state and state[1]),
                            "performance": range_performances(points),
                            "annual": annual_returns(points, now.year, asset_id=asset['id'],
                                unfinished_year=local_year if local_year < now.year else None)})
        if asset["id"] == "N225" and not points:
            description["note"] = "暂缺可用现货历史，不以日经期货替代。"
        payload = {"schemaVersion": 1, "asset": description, "points": points}
        store_dashboard_snapshot(payload, f"{SNAPSHOT_PREFIX}{asset['id']}")
        catalog.append(description)
    payload = {"schemaVersion": 1, "assets": catalog, "year": now.year,
               "comparisons": comparison_windows(catalog, series, now.year)}
    store_dashboard_snapshot(payload, f"{SNAPSHOT_PREFIX}catalog")
    return payload


def fetch_rows(asset: dict[str, Any], now: datetime, *, twse_months: int = 1) -> list[dict[str, Any]]:
    from .server import fetch_upstream, decode_body, parse_naver_korea_history, parse_coinmetrics_bitcoin_history, market_history_url
    observed_at: dict[str, datetime] = {}

    def download(url: str, referer: str, suffix: str = "") -> bytes:
        cache_key = f"longhistory:{asset['id']}:{suffix}"
        status, _, body = fetch_upstream(url, referer=referer, content_type="text/plain",
            cache_key=cache_key, kind="longhistory", ttl_seconds=24 * 3600)
        if status >= 400:
            raise ValueError(f"HTTP {status}")
        with get_conn() as conn:
            cached = conn.execute('SELECT fetched_at FROM response_cache WHERE cache_key=?', (cache_key,)).fetchone()
        observed_at[url] = datetime.fromtimestamp(cached[0] / 1000, ZoneInfo('UTC')) if cached else now
        if now.timestamp() - observed_at[url].timestamp() > 24 * 3600:
            raise ValueError('Upstream refresh failed; archived history retained')
        return body

    history = asset["history"]
    key = asset["id"]
    cutoff = completed_cutoff(asset, now)
    timezone = "America/New_York" if asset["group"] == "usa" else "Asia/Shanghai"
    if history["source"] in {"sina-cn", "sina-us", "tencent-hk"}:
        symbol = f"us.{history['symbol'].lstrip('.')}" if history["source"] == "sina-us" else history["symbol"]
        endpoint = "usfqkline/get" if history["source"] == "sina-us" else "kline/kline"
        param = f"{symbol},month,,,1000" + (",qfq" if history["source"] == "sina-us" else "")
        url = f"https://web.ifzq.gtimg.cn/appstock/app/{endpoint}?{urlencode({'param': param})}"
        rows = parse_tencent(decode_body(download(url, "https://gu.qq.com/")), symbol, url)
        for row in rows:
            row['monthComplete'] = row['period'] < observed_at[url].astimezone(ZoneInfo(timezone)).strftime('%Y-%m')
    elif key == "N225":
        url = "https://indexes.nikkei.co.jp/nkave/historical/nikkei_stock_average_monthly_jp.csv"
        body = download(url, "https://indexes.nikkei.co.jp/")
        rows = parse_nikkei(body, url, observed_at[url])
        daily_url = "https://indexes.nikkei.co.jp/nkave/historical/nikkei_stock_average_daily_jp.csv"
        daily = parse_nikkei(download(daily_url, "https://indexes.nikkei.co.jp/", "daily"), daily_url, now, monthly=False)
        rows.extend(point for point in daily if point["date"] <= cutoff)
    elif key == "KOSPI":
        query = urlencode({"symbol": "KOSPI", "requestType": 1, "startTime": "19800101",
                           "endTime": cutoff.replace('-', ''), "timeframe": "month"})
        url = f"https://api.finance.naver.com/siseJson.naver?{query}"
        rows = [point for row in parse_naver_korea_history(decode_body(download(url, "https://finance.naver.com/")))
                if (point := valid_point(row["date"], row["close"], source="naver", url=url))]
        for row in rows:
            if row["period"] < observed_at[url].astimezone(ZoneInfo('Asia/Seoul')).strftime('%Y-%m'):
                row["date"] = row["period"]
                row['monthComplete'] = True
    elif key == "TWSE":
        existing = {row["period"] for row in read_points(key) if row.get('monthComplete')}
        missing = [f"{year}-{month:02d}" for year in range(1999, now.year + 1) for month in range(1, 13)
                   if f"{year}-{month:02d}" < cutoff[:7] and f"{year}-{month:02d}" not in existing]
        missing.sort(key=lambda month: (not month.endswith('-12'), month))
        months = [cutoff[:7], *missing[:max(0, twse_months - 1)]]
        rows = []
        for month in months:
            url = f"https://www.twse.com.tw/rwd/en/TAIEX/MI_5MINS_HIST?date={month.replace('-', '')}01&response=json"
            partial = parse_twse(decode_body(download(url, "https://www.twse.com.tw/", month)), url)
            partial = [p for p in partial if p["date"] <= cutoff and p["period"] == month]
            for point in partial:
                point['monthComplete'] = month < observed_at[url].astimezone(ZoneInfo('Asia/Taipei')).strftime('%Y-%m')
            save_points(key, partial, int(now.timestamp() * 1000))
            rows.extend(partial)
            time.sleep(0.25)
    elif key == "BTC":
        url, referer = market_history_url("coinmetrics-crypto", "BTC")
        rows = [point for row in parse_coinmetrics_bitcoin_history(decode_body(download(url, referer)))
                if (point := valid_point(row["date"], row["close"], source="coinmetrics", url=url))]
    else:
        # Commodity daily maintenance already persists the complete provider response.
        rows = stored_daily_points(asset, now)
    return completed_months(rows, asset, now)


def refresh(*, limit: int = 2, twse_months: int = 2, now: datetime | None = None, force: bool = False) -> dict[str, Any]:
    now = now or datetime.now(ZoneInfo("Asia/Shanghai"))
    timestamp = int(now.timestamp() * 1000)
    all_assets = assets()
    errors = []
    for asset in all_assets:
        try:
            save_points(asset["id"], stored_daily_points(asset, now), timestamp)
        except Exception as exc:
            errors.append(f"{asset['id']}: {exc}")
    # Publish existing histories first, even while longer backfills remain in progress.
    publish(now)
    with get_conn() as conn:
        checked = {row[0]: int(row[1]) for row in conn.execute("SELECT asset_id,checked_at FROM long_history_sync")}
    pending = sorted(all_assets, key=lambda asset: checked.get(asset["id"], 0))
    pending = [asset for asset in pending if force or timestamp - checked.get(asset["id"], 0) >= 24 * 3600 * 1000][:limit]
    for asset in pending:
        error = ""
        try:
            rows = fetch_rows(asset, now, twse_months=twse_months)
            if not rows:
                raise ValueError("No valid completed historical prices")
            save_points(asset["id"], rows, timestamp)
        except Exception as exc:
            error = str(exc)[:240]
            errors.append(f"{asset['id']}: {error}")
        with get_conn() as conn:
            conn.execute("""INSERT INTO long_history_sync VALUES (?,?,?,?) ON CONFLICT(asset_id) DO UPDATE SET
                checked_at=excluded.checked_at,success_at=CASE WHEN excluded.error='' THEN excluded.success_at
                ELSE long_history_sync.success_at END,error=excluded.error""", (asset["id"], timestamp, 0 if error else timestamp, error))
        publish(now)
        time.sleep(0.25)
    publish(now)
    return {"checked": len(pending), "errors": errors}


def main() -> None:
    from .server import ensure_storage
    parser = argparse.ArgumentParser(description="Backfill monthly closes and publish annual-return snapshots")
    parser.add_argument("--publish-only", action="store_true")
    parser.add_argument("--extend", action="store_true", help="Verify and import older FRED/Yahoo monthly archives serially")
    parser.add_argument("--audit-only", action="store_true", help="Report stored monthly coverage without network requests")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--twse-months", type=int, default=12)
    parser.add_argument("--force", action="store_true", help="Recheck even when the latest check was recent")
    args = parser.parse_args()
    if not 0 <= args.limit <= 100 or not 1 <= args.twse_months <= 360:
        parser.error("limit must be 0..100; twse-months must be 1..360")
    ensure_storage()
    if args.audit_only:
        now = datetime.now(ZoneInfo('Asia/Shanghai'))
        result = []
        for asset in assets():
            points = completed_months(read_points(asset['id']), asset, now)
            result.append({'asset': asset['id'], 'first': points[0]['period'] if points else None,
                'last': points[-1]['period'] if points else None, 'months': len(points),
                'missingMonths': missing_months(points, completed_cutoff(asset, now))})
        print(json.dumps(result, ensure_ascii=False))
        return
    if args.extend:
        from .long_history_sources import extend_archives
        result = extend_archives()
    else:
        result = publish() if args.publish_only else refresh(limit=args.limit, twse_months=args.twse_months, force=args.force)
    if args.publish_only and not args.extend:
        print(json.dumps({"assets": len(result["assets"])}, ensure_ascii=False))
    else:
        print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
