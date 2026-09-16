"""Allowlisted US cash-index daily archives, independent of live quote polling."""
from __future__ import annotations

import json
import math
import time
from datetime import date, datetime, timedelta
from urllib.parse import quote, urlencode
from zoneinfo import ZoneInfo

INDEX_SYMBOLS = {'RUT': '^RUT', 'SOX': '^SOX', 'OEX': '^OEX'}
INDEX_START_DATES = {'RUT': '1987-09-10', 'SOX': '1994-05-04', 'OEX': '1982-08-02'}


def index_history_url(symbol: str, latest: str | None = None, now: datetime | None = None) -> str:
    if symbol not in INDEX_SYMBOLS:
        raise ValueError('Unsupported US index')
    now = now or datetime.now(ZoneInfo('America/New_York'))
    start = -2208988800
    if latest:
        start = int((datetime.fromisoformat(latest).replace(tzinfo=ZoneInfo('America/New_York')) - timedelta(days=10)).timestamp())
    return 'https://query1.finance.yahoo.com/v8/finance/chart/' + quote(INDEX_SYMBOLS[symbol], safe='') + '?' + urlencode({
        'interval': '1d', 'period1': start, 'period2': int(now.timestamp()),
    })


def parse_index_history(text: str, symbol: str, cutoff: str) -> list[dict]:
    if symbol not in INDEX_SYMBOLS:
        raise ValueError('Unsupported US index')
    date.fromisoformat(cutoff)
    chart = json.loads(text).get('chart', {})
    result = chart.get('result')
    if chart.get('error') or not isinstance(result, list) or len(result) != 1:
        raise ValueError('Missing cash index archive')
    data = result[0]
    meta = data.get('meta', {})
    if (meta.get('symbol') != INDEX_SYMBOLS[symbol] or meta.get('instrumentType') != 'INDEX'
            or meta.get('currency') != 'USD' or meta.get('dataGranularity') != '1d'
            or meta.get('exchangeTimezoneName') != 'America/New_York'):
        raise ValueError('Unexpected cash index identity or price basis')
    observed = meta.get('regularMarketTime')
    if isinstance(observed, bool) or not isinstance(observed, (int, float)) or not math.isfinite(observed) or observed <= 0:
        raise ValueError('Missing index observation timestamp')
    from .server import latest_completed_trading_day
    observed_cutoff = latest_completed_trading_day(
        f'gb_{symbol.lower()}', datetime.fromtimestamp(observed, ZoneInfo('America/New_York')),
    )
    if not observed_cutoff:
        raise ValueError('Missing completed session at index observation time')
    # A cached intraday bar must not become a closing price just because time passed.
    cutoff = min(cutoff, observed_cutoff)
    stamps = data.get('timestamp') or []
    quotes = data.get('indicators', {}).get('quote') or []
    closes = quotes[0].get('close', []) if len(quotes) == 1 else []
    if not stamps or len(stamps) != len(closes):
        raise ValueError('Missing or mismatched daily observations')
    rows = []
    seen = set()
    for timestamp, close in zip(stamps, closes):
        day = datetime.fromtimestamp(timestamp, ZoneInfo('America/New_York')).date().isoformat()
        if day in seen:
            raise ValueError('Duplicate index trading dates')
        seen.add(day)
        if close is None:
            continue
        if isinstance(close, bool) or not isinstance(close, (int, float)) or not math.isfinite(close) or close <= 0:
            raise ValueError('Invalid index closing price')
        # Yahoo's last daily bar is provisional during the current cash session.
        if '1900-01-01' <= day <= cutoff:
            rows.append({'date': day, 'close': float(close)})
    if not rows:
        raise ValueError('No completed index sessions')
    return sorted(rows, key=lambda row: row['date'])


def sync_indices() -> dict:
    from . import server
    from .long_history import assets, completed_cutoff, daily_month_ends, missing_months, publish, save_points, valid_point
    now = datetime.now(ZoneInfo('Asia/Shanghai'))
    universe = {asset['id']: asset for asset in assets()}
    results = []
    for symbol in INDEX_SYMBOLS:
        try:
            url = index_history_url(symbol, now=now)
            status, _, body = server.fetch_upstream(
                url, referer='https://finance.yahoo.com/', content_type='application/json',
                cache_key=f'longhistory-indices:{symbol}:{now:%Y-%m}', kind='longhistory',
                ttl_seconds=30 * 24 * 3600, use_requests=True,
            )
            if status >= 400:
                raise ValueError(f'Index archive HTTP {status}')
            cutoff = server.latest_completed_trading_day(f'gb_{symbol.lower()}', now)
            if not cutoff:
                raise ValueError('Missing completed US trading day')
            text = server.decode_body(body)
            rows = parse_index_history(text, symbol, cutoff)
            if rows[0]['date'] != INDEX_START_DATES[symbol]:
                raise ValueError('Incomplete index archive start')
            if rows[-1]['date'][:7] < completed_cutoff(universe[symbol], now)[:7]:
                raise ValueError('Stale index archive tail')
            points = [valid_point(row['date'], row['close'], source='yahoo', url=url) for row in rows]
            monthly = daily_month_ends([point for point in points if point], universe[symbol], now)
            if missing_months(monthly, completed_cutoff(universe[symbol], now)):
                raise ValueError('Missing index month-end observations')
            count = server.store_market_history('yahoo-index', symbol, text)
            save_points(symbol, monthly, int(now.timestamp() * 1000))
            results.append({'asset': symbol, 'daily': count, 'months': len(monthly),
                            'first': rows[0]['date'], 'last': rows[-1]['date']})
        except Exception as exc:
            results.append({'asset': symbol, 'error': str(exc)[:240], 'retainedExisting': True})
        time.sleep(.3)
    publish(now)
    return {'indices': results}
