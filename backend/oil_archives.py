"""EIA's discontinued NYMEX front-month archive, imported only after overlap checks."""
from __future__ import annotations

import re
from datetime import datetime, timedelta
from html.parser import HTMLParser
from zoneinfo import ZoneInfo

from .long_history import assets, daily_month_ends, missing_months, publish, read_points, save_points, valid_point
from .long_history_sources import verified_extension

EIA_URL = 'https://www.eia.gov/dnav/pet/hist/LeafHandler.ashx?n=PET&s=RCLC1&f=D'
EIA_SERIES = 'Cushing, OK Crude Oil Future Contract 1 (Dollars per Barrel)'


class _HistoryTable(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.active = False
        self.cell: list[str] | None = None
        self.row: list[str] = []
        self.rows: list[list[str]] = []
        self.matches = 0

    def handle_starttag(self, tag, attrs):
        if tag == 'table':
            summary = ' '.join(dict(attrs).get('summary', '').split())
            self.active = summary == EIA_SERIES
            self.matches += int(self.active)
        if not self.active:
            return
        if tag == 'tr':
            self.row = []
        elif tag in {'td', 'th'}:
            self.cell = []

    def handle_data(self, data):
        if self.active and self.cell is not None:
            self.cell.append(data)

    def handle_endtag(self, tag):
        if self.active and tag in {'td', 'th'} and self.cell is not None:
            self.row.append(' '.join(''.join(self.cell).split()))
            self.cell = None
        elif self.active and tag == 'tr':
            self.rows.append(self.row)
        elif tag == 'table':
            self.active = False


def parse_eia_oil(text: str) -> list[dict]:
    table = _HistoryTable()
    table.feed(text)
    if table.matches != 1 or not table.rows or table.rows[0] != ['Week Of', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri']:
        raise ValueError('Unexpected EIA futures series or weekday columns')
    result = []
    seen = set()
    for row in table.rows[1:]:
        if not any(row):
            continue
        match = re.fullmatch(r'(\d{4}) ([A-Z][a-z]{2})-\s*(\d{1,2}) to ([A-Z][a-z]{2})-\s*(\d{1,2})', row[0])
        if not match or len(row) != 6:
            raise ValueError('Invalid EIA weekly row')
        year, month, day, end_month, end_day = match.groups()
        monday = datetime.strptime(f'{year}-{month}-{day}', '%Y-%b-%d').date()
        friday = monday + timedelta(days=4)
        if monday.weekday() != 0 or friday.strftime('%b') != end_month or friday.day != int(end_day):
            raise ValueError('Invalid EIA week boundaries')
        for offset, value in enumerate(row[1:]):
            if value in {'', '-', '--', 'NA', 'W'}:
                continue
            day = (monday + timedelta(days=offset)).isoformat()
            point = valid_point(day, value, source='eia', url=EIA_URL)
            if not point or day in seen:
                raise ValueError('Invalid or duplicate EIA daily price')
            result.append(point)
            seen.add(day)
    if not result:
        raise ValueError('Empty EIA daily archive')
    return sorted(result, key=lambda row: row['date'])


def oil_extension(existing: list[dict], daily: list[dict], now: datetime) -> list[dict]:
    if not daily or daily[0]['date'] != '1983-04-04' or daily[-1]['date'] != '2024-04-05':
        raise ValueError('Incomplete EIA archive boundaries')
    asset = next(asset for asset in assets() if asset['id'] == 'CL')
    monthly = daily_month_ends(daily, asset, now)
    if not monthly or monthly[-1]['period'] != '2024-03' or missing_months(monthly, '2024-03-31'):
        raise ValueError('Incomplete EIA month-end coverage')
    if not existing:
        raise ValueError('Existing oil archive required to verify a splice')
    return verified_extension(existing, monthly)


def sync_oil() -> dict:
    from .server import decode_body, fetch_upstream
    now = datetime.now(ZoneInfo('Asia/Shanghai'))
    try:
        status, _, body = fetch_upstream(
            EIA_URL, referer='https://www.eia.gov/', content_type='text/html',
            cache_key='longhistory-archive:eia:RCLC1:daily', kind='longhistory',
            ttl_seconds=30 * 24 * 3600, use_requests=True,
        )
        if status >= 400:
            raise ValueError(f'EIA archive HTTP {status}')
        daily = parse_eia_oil(decode_body(body))
        rows = oil_extension(read_points('CL'), daily, now)
        save_points('CL', rows, int(now.timestamp() * 1000))
        result = {'asset': 'CL', 'source': 'eia', 'added': len(rows)}
    except Exception as exc:
        result = {'asset': 'CL', 'error': str(exc)[:240], 'retainedExisting': True}
    publish(now)
    return {'oil': result}
