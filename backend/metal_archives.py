"""Explicit offline imports for USD gold/silver futures; no live or worker requests."""
from __future__ import annotations

import math
import time
from datetime import datetime, timedelta
from urllib.parse import quote, urlencode
from zoneinfo import ZoneInfo

from .long_history import (
    OFFLINE_METALS, assets, completed_cutoff, daily_month_ends,
    missing_months, publish, read_points,
)
from .long_history_sources import parse_yahoo
from .storage import get_conn


def validate_metals(asset: dict, daily: list[dict], check_daily: list[dict], now: datetime) -> list[dict]:
    if asset['id'] not in OFFLINE_METALS:
        raise ValueError('Only configured gold/silver archives can be replaced')
    days = [row['date'] for row in daily]
    if len(days) != len(set(days)):
        raise ValueError('Duplicate daily observations')
    cutoff = completed_cutoff(asset, now)
    # Both provider archives start in August 2000. A short response is not a new archive.
    rows = daily_month_ends(daily, asset, now)
    if not rows or rows[0]['period'] != '2000-08' or rows[-1]['period'] != cutoff[:7]:
        raise ValueError('Incomplete gold/silver archive boundaries')
    if missing_months(rows, cutoff):
        raise ValueError('Missing gold/silver month-end observations')
    for point in rows:
        if point['source'] != 'yahoo' or not math.isfinite(point['close']) or point['close'] <= 0:
            raise ValueError('Invalid gold/silver monthly close')
    by_month = {row['period']: row for row in rows}
    # Do not compare against monthly bars: Yahoo can use a different contract at month-end.
    # Re-fetch selected windows as daily data and require the same month-end closes.
    overlap = [row for row in daily_month_ends(check_daily, asset, now) if row['period'] in by_month]
    if len(overlap) < 12:
        raise ValueError('Require 12 segmented daily cross-checks')
    for point in overlap:
        if not math.isfinite(point['close']) or point['close'] <= 0 or abs(point['close'] / by_month[point['period']]['close'] - 1) > .001:
            raise ValueError(f"Segmented daily closing-price conflict in {point['period']}")
    return rows


def store_metal_archive(asset_id: str, rows: list[dict], now: datetime) -> int:
    if asset_id not in OFFLINE_METALS or not rows:
        raise ValueError('Invalid metal archive replacement')
    asset = next(asset for asset in assets() if asset['id'] == asset_id)
    cutoff = completed_cutoff(asset, now)
    if rows[0]['period'] != '2000-08' or rows[-1]['period'] != cutoff[:7] or missing_months(rows, cutoff):
        raise ValueError('Refuse an incomplete replacement archive')
    if len({row['period'] for row in rows}) != len(rows) or any(
        row['source'] != 'yahoo' or not row.get('monthComplete') or row['close'] <= 0
        or not math.isfinite(row['close']) for row in rows
    ):
        raise ValueError('Refuse unverified replacement prices')
    timestamp = int(now.timestamp() * 1000)
    values = [(asset_id, row['period'], row['date'], row['close'], 'yahoo', row['sourceUrl'], timestamp, 1) for row in rows]
    with get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        old = conn.execute('SELECT period,close,source FROM long_market_history WHERE asset_id=?', (asset_id,)).fetchall()
        candidate = {row['period']: row for row in rows}
        for period, close, source in old:
            if period > cutoff[:7]:
                raise ValueError('Existing archive has newer periods; do not truncate it')
            if period not in candidate:
                raise ValueError('Replacement would lose recorded history')
            if source not in {'sina', 'yahoo'}:
                raise ValueError('Unexpected existing gold/silver source; manual review required')
            if source == 'yahoo' and (close <= 0 or abs(candidate[period]['close'] / close - 1) > .001):
                raise ValueError(f'Historical revision requires review in {period}')
        # Replace every legacy month atomically, never splice Sina and Yahoo closes.
        conn.executemany('''INSERT INTO long_market_history
            (asset_id,period,date,close,source,source_url,fetched_at,month_complete) VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(asset_id,period) DO UPDATE SET date=excluded.date,close=excluded.close,
                source=excluded.source,source_url=excluded.source_url,fetched_at=excluded.fetched_at,
                month_complete=excluded.month_complete''', values)
        conn.execute('''INSERT INTO long_history_sync VALUES (?,?,?,?) ON CONFLICT(asset_id) DO UPDATE SET
            checked_at=excluded.checked_at,success_at=excluded.success_at,error='' ''', (asset_id, timestamp, timestamp, ''))
    return len(values)


def sync_metals(now: datetime | None = None) -> dict:
    from .server import decode_body, fetch_upstream
    now = now or datetime.now(ZoneInfo('Asia/Shanghai'))
    universe = {asset['id']: asset for asset in assets()}
    results = []
    for asset_id, symbol in OFFLINE_METALS.items():
        try:
            asset = universe[asset_id]
            cutoff = completed_cutoff(asset, now)
            end = int((datetime.fromisoformat(cutoff).replace(tzinfo=ZoneInfo('America/New_York')) + timedelta(days=1)).timestamp())
            series = {}
            recent_year = int(cutoff[:4]) - 1
            recent_start = int(datetime(recent_year, int(cutoff[5:7]), 1, tzinfo=ZoneInfo('America/New_York')).timestamp())
            # Check the first year, the 2020 monthly/daily discrepancy, and the latest 13 months.
            windows = [('full', 946684800, end), ('early', 946684800, 1009861200),
                       ('2020', 1588305600, 1601524800), ('recent', recent_start, end)]
            for window, start, stop in windows:
                url = f'https://query1.finance.yahoo.com/v8/finance/chart/{quote(symbol)}?' + urlencode({
                    'interval': '1d', 'period1': start, 'period2': stop})
                status, _, body = fetch_upstream(url, referer='https://finance.yahoo.com/', content_type='application/json',
                    cache_key=f'longhistory-metals:{symbol}:{cutoff[:7]}:daily:{window}', kind='longhistory',
                    ttl_seconds=30 * 24 * 3600, use_requests=True)
                if status >= 400:
                    raise ValueError(f'Yahoo {window} archive HTTP {status}')
                series[window] = parse_yahoo(decode_body(body), symbol, url, interval='1d')
                if not series[window]:
                    raise ValueError(f'Empty Yahoo {window} verification window')
                time.sleep(.25)
            checks = {point['date']: point for window in ('early', '2020', 'recent') for point in series[window]}
            rows = validate_metals(asset, series['full'], list(checks.values()), now)
            old_count = len(read_points(asset_id))
            count = store_metal_archive(asset_id, rows, now)
            results.append({'asset': asset_id, 'source': 'yahoo', 'first': rows[0]['period'], 'last': rows[-1]['period'],
                            'months': count, 'previousMonths': old_count})
        except Exception as exc:
            results.append({'asset': asset_id, 'error': str(exc)[:240], 'retainedExisting': True})
    publish(now)
    return {'metals': results}
