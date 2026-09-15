"""Optional, serial archive extensions. They never run in page request paths."""
from __future__ import annotations

import csv
import io
import json
import time
from datetime import datetime, timedelta
from urllib.parse import quote, urlencode
from zoneinfo import ZoneInfo

from .long_history import (
    assets, completed_cutoff, completed_months, month_end_rows, publish, read_points, save_points, valid_point,
)

FRED_SERIES = {'IXIC': 'NASDAQCOM', 'NDX': 'NASDAQ100', 'N225': 'NIKKEI225'}
YAHOO_SERIES = {'NDX': '^NDX', 'DJI': '^DJI', 'HSI': '^HSI'}


def parse_fred(text: str, series: str, url: str, *, monthly: bool = True) -> list[dict]:
    reader = csv.DictReader(io.StringIO(text.lstrip('\ufeff')))
    if not reader.fieldnames or 'observation_date' not in reader.fieldnames or series not in reader.fieldnames:
        raise ValueError('Invalid FRED CSV columns')
    result = []
    for row in reader:
        point = valid_point(row['observation_date'], row[series], source='fred', url=url)
        if point and point['close'] > 0:
            if monthly:
                point['date'] = point['period']
                point['monthComplete'] = True
            result.append(point)
    return result


def parse_yahoo(text: str, symbol: str, url: str) -> list[dict]:
    chart = json.loads(text).get('chart', {})
    result = chart.get('result')
    if chart.get('error') or not isinstance(result, list) or len(result) != 1:
        raise ValueError('Missing Yahoo monthly series')
    data = result[0]
    meta = data.get('meta', {})
    if meta.get('symbol') != symbol or meta.get('dataGranularity') != '1mo':
        raise ValueError('Unexpected Yahoo asset or frequency')
    timezone = ZoneInfo(meta['exchangeTimezoneName'])
    stamps = data.get('timestamp') or []
    quotes = data.get('indicators', {}).get('quote', [])
    closes = quotes[0].get('close', []) if quotes else []
    if len(stamps) != len(closes):
        raise ValueError('Mismatched Yahoo monthly columns')
    rows = []
    for timestamp, close in zip(stamps, closes):
        day = datetime.fromtimestamp(timestamp, timezone).strftime('%Y-%m-%d')
        point = valid_point(day, close, source='yahoo', url=url)
        if point and point['close'] > 0:
            point.update(date=point['period'], monthComplete=True)
            rows.append(point)
    return rows


def verified_extension(existing: list[dict], candidates: list[dict]) -> list[dict]:
    old = {point['period']: point for point in existing}
    rows = month_end_rows(candidates)
    overlap = [point for point in rows if point['period'] in old]
    if len(overlap) < 12:
        raise ValueError('Archive requires at least 12 overlapping months')
    for point in overlap:
        previous = old[point['period']]['close']
        if previous <= 0 or abs(point['close'] / previous - 1) > .01:
            raise ValueError(f"Archive price conflict in {point['period']}")
    # An archive supplement must never replace the established source's closes.
    return [point for point in rows if point['period'] not in old]


def extend_archives(now: datetime | None = None) -> dict:
    from .server import decode_body, fetch_upstream
    now = now or datetime.now(ZoneInfo('Asia/Shanghai'))
    universe = {asset['id']: asset for asset in assets()}
    results = []

    def download(url: str, key: str, referer: str) -> str:
        status, _, body = fetch_upstream(url, referer=referer, content_type='text/plain',
            cache_key=f'longhistory-archive:{key}', kind='longhistory', ttl_seconds=30 * 24 * 3600,
            use_requests=referer == 'https://fred.stlouisfed.org/')
        if status >= 400:
            raise ValueError(f'HTTP {status}')
        return decode_body(body)

    for provider, mapping in [('fred', FRED_SERIES), ('yahoo', YAHOO_SERIES)]:
        for asset_id, symbol in mapping.items():
            try:
                asset = universe[asset_id]
                cutoff = completed_cutoff(asset, now)
                if provider == 'fred':
                    params = {'id': symbol, 'cosd': '1900-01-01', 'coed': cutoff, 'fq': 'Monthly', 'fam': 'eop'}
                    url = f'https://fred.stlouisfed.org/graph/fredgraph.csv?{urlencode(params)}'
                    rows = parse_fred(download(url, f'{symbol}:{cutoff[:7]}', 'https://fred.stlouisfed.org/'), symbol, url)
                    # FRED's monthly aggregation may omit the first partial launch month.
                    # Obtain only that small daily window, then retain its month-end close.
                    if rows:
                        first = datetime.fromisoformat(min(point['period'] for point in rows) + '-01')
                        end = first - timedelta(days=1)
                        start = end.replace(day=1)
                        daily_url = 'https://fred.stlouisfed.org/graph/fredgraph.csv?' + urlencode({
                            'id': symbol, 'cosd': start.strftime('%Y-%m-%d'), 'coed': end.strftime('%Y-%m-%d')})
                        try:
                            daily = parse_fred(download(daily_url, f'{symbol}:first-month', 'https://fred.stlouisfed.org/'), symbol, daily_url, monthly=False)
                            rows.extend(point for point in daily if start.strftime('%Y-%m-%d') <= point['date'] <= end.strftime('%Y-%m-%d'))
                        except Exception as exc:
                            results.append({'asset': asset_id, 'source': provider, 'warning': f'First month: {str(exc)[:160]}'})
                else:
                    end = int((datetime.fromisoformat(cutoff).replace(tzinfo=ZoneInfo('America/New_York')) + timedelta(days=1)).timestamp())
                    url = f'https://query1.finance.yahoo.com/v8/finance/chart/{quote(symbol)}?' + urlencode({
                        'interval': '1mo', 'period1': -2208988800, 'period2': end})
                    rows = parse_yahoo(download(url, f'{symbol}:{cutoff[:7]}', 'https://finance.yahoo.com/'), symbol, url)
                rows = completed_months(rows, asset, now)
                additions = verified_extension(completed_months(read_points(asset_id), asset, now), rows)
                save_points(asset_id, additions, int(now.timestamp() * 1000))
                results.append({'asset': asset_id, 'source': provider, 'added': len(additions)})
                publish(now)
            except Exception as exc:
                results.append({'asset': asset_id, 'source': provider, 'error': str(exc)[:200]})
            time.sleep(.5)
    return {'archives': results}
