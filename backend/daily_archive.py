"""Bounded, resumable daily-history extension, never called from page reads."""
from __future__ import annotations

import argparse
import calendar
import csv
import hashlib
import io
import json
import math
import time
from datetime import date, datetime, timedelta
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

from .config import configured_market_return_items
from .storage import get_conn, migrate_database

SUPPORTED = {'sina-cn', 'sina-us', 'tencent-hk', 'twse-official', 'naver-korea', 'nikkei-index'}
FRED_SERIES = {('sina-us', '.IXIC'): 'NASDAQCOM', ('sina-us', '.NDX'): 'NASDAQ100',
               ('nikkei-index', 'N225'): 'NIKKEI225'}


def archive_request(source: str, symbol: str, oldest: str) -> tuple[str, str, str, str]:
    first = date.fromisoformat(oldest)
    # Two calendar years stay below Tencent's 640-row cap, with an overlap
    # against the existing daily series to verify price basis and identity.
    start = date(first.year - 1, 1, 1).isoformat()
    end = date(first.year, 12, 31).isoformat()
    if (source, symbol) in FRED_SERIES:
        params = {'id': FRED_SERIES[source, symbol], 'cosd': start, 'coed': end}
        return (f'https://fred.stlouisfed.org/graph/fredgraph.csv?{urlencode(params)}',
                'https://fred.stlouisfed.org/', start, end)
    if source in {'sina-cn', 'tencent-hk'}:
        param = f'{symbol},day,{start},{end},640'
        return (f'https://web.ifzq.gtimg.cn/appstock/app/kline/kline?{urlencode({"param": param})}',
                'https://gu.qq.com/', start, end)
    if source == 'twse-official' and symbol == 'TWII':
        previous = first.replace(day=1) - timedelta(days=1)
        start, end = previous.replace(day=1).isoformat(), previous.isoformat()
        query = urlencode({'date': previous.strftime('%Y%m01'), 'response': 'json'})
        return (f'https://www.twse.com.tw/rwd/en/TAIEX/MI_5MINS_HIST?{query}',
                'https://www.twse.com.tw/', start, end)
    if source == 'naver-korea' and symbol == 'KOSPI':
        query = urlencode({'symbol': symbol, 'requestType': 1, 'startTime': start.replace('-', ''),
                           'endTime': end.replace('-', ''), 'timeframe': 'day'})
        return f'https://api.finance.naver.com/siseJson.naver?{query}', 'https://finance.naver.com/', start, end
    raise ValueError('Unsupported daily archive')


def parse_archive(source: str, symbol: str, text: str, start: str, end: str) -> list[tuple[str, float]]:
    from .server import parse_naver_korea_history
    if (source, symbol) in FRED_SERIES:
        series = FRED_SERIES[source, symbol]
        reader = csv.DictReader(io.StringIO(text.lstrip('\ufeff')))
        if reader.fieldnames != ['observation_date', series]:
            raise ValueError('Unexpected FRED daily series columns')
        raw = [[row['observation_date'], row[series]] for row in reader if row[series] not in ('', '.')]
    elif source == 'naver-korea':
        raw = [[row['date'], row['close']] for row in parse_naver_korea_history(text)]
    else:
        payload = json.loads(text)
        if not isinstance(payload, dict):
            raise ValueError('Invalid daily archive object')
        if source == 'twse-official':
            if payload.get('stat') != 'OK':
                raise ValueError('TWSE did not confirm a historical response')
            raw = [[str(row[0]).replace('/', '-'), row[4]] for row in payload.get('data', [])]
        else:
            data = payload.get('data', {}).get(symbol)
            if payload.get('code') != 0 or not isinstance(data, dict):
                raise ValueError('Missing requested archive symbol')
            # Never use adjusted ETF quotes as raw prices; corporate actions
            # are handled by performance.py using separately verified factors.
            rows = data.get('day')
            if not isinstance(rows, list) or len(rows) >= 640:
                raise ValueError('Missing or truncated daily archive')
            raw = [[row[0], row[2]] for row in rows]
    points = {}
    for day, value in raw:
        parsed_day = date.fromisoformat(str(day)).isoformat()
        close = float(str(value).replace(',', ''))
        if not math.isfinite(close) or close <= 0 or parsed_day in points:
            raise ValueError('Invalid or duplicate daily close')
        if not start <= parsed_day <= end:
            raise ValueError('Provider ignored requested date window')
        points[parsed_day] = close
    if not points:
        raise ValueError('Empty archive is not proof of inception')
    return sorted(points.items())


def validate_overlap(rows: list[tuple[str, float]], existing: dict[str, float], *, required: bool) -> None:
    overlap = [(close, existing[day]) for day, close in rows if day in existing]
    if required and len(overlap) < 3:
        raise ValueError('Insufficient daily overlap to verify archive identity')
    if any(old <= 0 or abs(close / old - 1) > 0.001 for close, old in overlap):
        raise ValueError('Archive disagrees with stored cash close or price basis')


def refresh(*, max_requests: int = 4, items: list[str] | None = None, retry_failed: bool = False) -> dict:
    from .server import decode_body, fetch_upstream, response_cache_clear_marketreturns_item
    now = int(time.time() * 1000)
    current = datetime.now(ZoneInfo('Asia/Shanghai')).date()
    five_year_start = date(current.year - 5, current.month,
                           min(current.day, calendar.monthrange(current.year - 5, current.month)[1])).isoformat()
    configured = set(configured_market_return_items())
    targets = configured if items is None else configured.intersection(items)
    with get_conn() as conn:
        coverage = {(source, symbol): oldest for source, symbol, oldest in conn.execute(
            'SELECT source,symbol,MIN(date) FROM market_history GROUP BY source,symbol')}
        states = {(source, symbol): (checked, due, url, status) for source, symbol, checked, due, url, status in conn.execute(
            'SELECT source,symbol,checked_at,next_check_at,source_url,status FROM market_history_backfill')}
    pending = []
    for item in targets:
        source, symbol = item.split(':', 1)
        oldest = coverage.get((source, symbol))
        if source not in SUPPORTED or not oldest or oldest[:4] <= '1901':
            continue
        if source in {'sina-us', 'nikkei-index'} and (source, symbol) not in FRED_SERIES:
            continue
        if source == 'twse-official' and oldest <= '1999-01-05':
            continue
        checked, due, previous_url, state = states.get((source, symbol), (0, 0, '', ''))
        url = archive_request(source, symbol, oldest)[0]
        if due > now and url == previous_url and not (retry_failed and state in {'error', 'review'}):
            continue
        pending.append((oldest <= five_year_start, checked, item, oldest))
    result = {'checked': 0, 'inserted': 0, 'errors': [], 'boundaries': []}
    for _, _, item, oldest in sorted(pending)[:max(0, min(max_requests, 100))]:
        source, symbol = item.split(':', 1)
        url, referer, start, end = archive_request(source, symbol, oldest)
        status, error, earliest = 'extended', '', oldest
        next_check = now
        try:
            fingerprint = hashlib.sha256(url.encode()).hexdigest()[:12]
            fred = (source, symbol) in FRED_SERIES
            previous_state = states.get((source, symbol), (0, 0, '', ''))[3]
            # A successful HTTP response may still contain invalid data. Retry
            # the provider after backoff, not that response's 30-day cache.
            http_status, _, body = fetch_upstream(url, referer=referer,
                content_type='text/csv' if fred else 'application/json',
                cache_key=f'daily-archive:{item}:{start}:{end}:{fingerprint}',
                kind='daily-archive', ttl_seconds=30 * 24 * 60 * 60,
                force_refresh=previous_state == 'error', use_requests=fred)
            if http_status >= 400:
                raise ValueError(f'Archive HTTP {http_status}')
            rows = parse_archive(source, symbol, decode_body(body), start, end)
            with get_conn() as conn:
                existing = dict(conn.execute('SELECT date,close FROM market_history WHERE source=? AND symbol=?',
                                            (source, symbol)))
                validate_overlap(rows, existing, required=source in {'sina-cn', 'sina-us', 'tencent-hk', 'nikkei-index'})
                # Only insert completed sessions, preserving the live provider's
                # rows even when the archive has more precision or revisions.
                additions = [(source, symbol, day, close, now) for day, close in rows
                             if day not in existing and day < current.isoformat()]
                conn.executemany('INSERT OR IGNORE INTO market_history VALUES (?,?,?,?,?)', additions)
            result['inserted'] += len(additions)
            earliest = min(oldest, rows[0][0])
            if earliest >= oldest:
                status, next_check = 'source-boundary', now + 30 * 86400 * 1000
                result['boundaries'].append(item)
            if additions:
                response_cache_clear_marketreturns_item(item)
        except Exception as exc:
            status, error, next_check = 'error', str(exc), now + 6 * 3600 * 1000
            if error.startswith('Archive disagrees'):
                status, next_check = 'review', now + 30 * 86400 * 1000
            result['errors'].append(f'{item}: {error}')
        with get_conn() as conn:
            conn.execute('''INSERT INTO market_history_backfill VALUES (?,?,?,?,?,?,?,?)
                ON CONFLICT(source,symbol) DO UPDATE SET oldest_date=excluded.oldest_date,
                status=excluded.status,source_url=excluded.source_url,checked_at=excluded.checked_at,
                next_check_at=excluded.next_check_at,error=excluded.error''',
                (source, symbol, earliest, status, url, now, next_check, error))
        result['checked'] += 1
        time.sleep(0.25)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--max-requests', type=int, default=4)
    parser.add_argument('--item', action='append', help='Configured source:symbol, repeatable')
    parser.add_argument('--retry-failed', action='store_true', help='Explicitly retry failed windows, still bounded')
    args = parser.parse_args()
    migrate_database()
    print(json.dumps(refresh(max_requests=args.max_requests, items=args.item, retry_failed=args.retry_failed), ensure_ascii=False))


if __name__ == '__main__':
    main()
