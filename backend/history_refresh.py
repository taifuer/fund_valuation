"""Persist completed history checks and bounded retries, independently of HTTP reads."""
from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from .config import archived_market_return_items
from .storage import get_conn

ARCHIVE_REFRESH_SECONDS = 7 * 24 * 3600


def expected_history_date(source: str, symbol: str, current: datetime | None = None) -> str:
    from . import server
    current = current or datetime.now(ZoneInfo('Asia/Shanghai'))
    if source == 'coinmetrics-crypto' and symbol == 'BTC':
        return (current.astimezone(ZoneInfo('UTC')).date() - timedelta(days=1)).isoformat()
    quote_symbol = server.market_history_quote_symbol(source, symbol)
    return (server.latest_completed_trading_day(quote_symbol, current) if quote_symbol else None) or ''


def history_freshness(source: str, symbol: str, latest_date: str, current: datetime | None = None) -> dict:
    current = current or datetime.now(ZoneInfo('Asia/Shanghai'))
    # Public rankings allow publishers two hours after close; worker checks stay strict.
    cutoff = current.astimezone(ZoneInfo('UTC')) - timedelta(hours=2)
    expected = expected_history_date(source, symbol, cutoff)
    return {
        'latestDate': latest_date,
        'expectedDate': expected,
        'stale': bool(expected and latest_date < expected),
    }


def read_sync_states() -> dict[str, dict]:
    with get_conn() as conn:
        rows = conn.execute('''
            SELECT source,symbol,checked_at,success_at,next_check_at,failures,status,
                   latest_date,expected_date,rows_written,error FROM market_history_sync
        ''').fetchall()
    keys = ('checkedAt', 'lastSuccessAt', 'nextCheckAt', 'failures', 'status',
            'latestDate', 'expectedDate', 'rowsWritten', 'error')
    return {f'{row[0]}:{row[1]}': dict(zip(keys, row[2:])) for row in rows}


def retry_is_due(source: str, symbol: str, current_ms: int) -> bool:
    with get_conn() as conn:
        row = conn.execute(
            'SELECT next_check_at,checked_at FROM market_history_sync WHERE source=? AND symbol=?', (source, symbol),
        ).fetchone()
    if not row:
        return True
    earliest = row[1] + ARCHIVE_REFRESH_SECONDS * 1000 if f'{source}:{symbol}' in archived_market_return_items() else 0
    return current_ms >= max(row[0], earliest)


def refresh_history_item(source: str, symbol: str, *, current: datetime | None = None) -> None:
    from . import server
    expected = expected_history_date(source, symbol, current)
    rows_written = 0
    error = ''
    status = 'error'
    try:
        if source == 'twse-official' and symbol == 'TWII':
            with get_conn() as conn:
                count = conn.execute(
                    'SELECT COUNT(*) FROM market_history WHERE source=? AND symbol=?', (source, symbol),
                ).fetchone()[0]
            rows_written = server.refresh_twse_history(60 if count < 500 else 1, force_refresh=True)
        else:
            http_status, _, body = server.fetch_market_history_payload(
                source, symbol, ttl_seconds=300, force_refresh=True,
            )
            if http_status >= 400:
                raise ValueError(f'History HTTP {http_status}')
            rows_written = server.store_market_history(source, symbol, server.decode_body(body))
        if not rows_written:
            raise ValueError('No valid history rows returned')
        latest, _ = server.latest_market_history_meta(source, symbol)
        status = 'stale' if not latest or (expected and latest < expected) else 'ok'
        if status == 'stale':
            error = f'History ends at {latest or "none"}; expected {expected or "completed session"}'
    except Exception as exc:
        error = str(exc)[:240] or type(exc).__name__

    latest, _ = server.latest_market_history_meta(source, symbol)
    checked = server.now_ms()
    with get_conn() as conn:
        previous = conn.execute(
            'SELECT failures,success_at FROM market_history_sync WHERE source=? AND symbol=?', (source, symbol),
        ).fetchone()
        failures = (int(previous[0]) + 1 if previous else 1) if status == 'error' else 0
        success_at = checked if not error else (int(previous[1]) if previous else 0)
        # Retry a lagging publisher after 30 minutes; repeated failures back off to six hours.
        delay = 1800 if status != 'error' else min(1800 * 2 ** min(max(failures - 1, 0), 4), 21600)
        if f'{source}:{symbol}' in archived_market_return_items():
            delay = max(delay, ARCHIVE_REFRESH_SECONDS)
        conn.execute('''
            INSERT INTO market_history_sync
              (source,symbol,checked_at,success_at,next_check_at,failures,status,latest_date,expected_date,rows_written,error)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(source,symbol) DO UPDATE SET
              checked_at=excluded.checked_at,success_at=excluded.success_at,next_check_at=excluded.next_check_at,
              failures=excluded.failures,status=excluded.status,latest_date=excluded.latest_date,
              expected_date=excluded.expected_date,rows_written=excluded.rows_written,error=excluded.error
        ''', (source, symbol, checked, success_at, checked + delay * 1000, failures,
              status, latest or '', expected, rows_written, error))
    if rows_written:
        server.response_cache_clear_marketreturns_item(f'{source}:{symbol}')
    if error:
        raise ValueError(error)
