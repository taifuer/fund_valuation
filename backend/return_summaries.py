"""Publish historical metrics in the worker; API reads only bounded summaries."""
from __future__ import annotations

import time

from .snapshots import decode_payload, encode_payload
from .storage import get_conn

MODEL_VERSION = 1


def publish_return_summaries(*, limit: int = 100) -> dict:
    from . import server
    with get_conn() as conn:
        pending = conn.execute('''SELECT v.kind,v.item,v.revision FROM return_summary_versions v
            LEFT JOIN return_summaries s ON s.kind=v.kind AND s.item=v.item
            WHERE s.source_revision IS NULL OR s.source_revision<>v.revision OR s.model_version<>?
            ORDER BY COALESCE(s.published_at,0),v.kind,v.item LIMIT ?''', (MODEL_VERSION, limit)).fetchall()
    errors = []
    published = 0
    for kind, item, revision in pending:
        try:
            summary = (server.read_fund_return_summary_from_db(item) if kind == 'fund'
                       else server.read_market_return_summary_from_db(*item.split(':', 1)))
            body = encode_payload(summary or {}, compressed=True)
            with get_conn() as conn:
                # Never publish calculations against a revision that changed mid-read.
                conn.execute('BEGIN IMMEDIATE')
                current = conn.execute('SELECT revision FROM return_summary_versions WHERE kind=? AND item=?', (kind, item)).fetchone()
                if current is None or current[0] != revision:
                    continue
                conn.execute('''INSERT INTO return_summaries VALUES (?,?,?,?,?,?) ON CONFLICT(kind,item)
                    DO UPDATE SET source_revision=excluded.source_revision,model_version=excluded.model_version,
                      payload=excluded.payload,published_at=excluded.published_at''',
                    (kind, item, revision, MODEL_VERSION, body, int(time.time() * 1000)))
            published += 1
        except Exception as exc:
            errors.append(f'{kind}:{item}: {str(exc)[:160]}')
    return {'published': published, 'errors': errors}


def read_return_summaries(kind: str, items: list[str]) -> dict:
    from .history_refresh import history_freshness
    if not items:
        return {}
    with get_conn() as conn:
        rows = conn.execute(f'''SELECT item,payload FROM return_summaries
            WHERE kind=? AND model_version=? AND item IN ({','.join('?' for _ in items)})''',
            (kind, MODEL_VERSION, *items)).fetchall()
    result = {}
    for item, body in rows:
        summary = decode_payload(body)
        if not summary:
            continue
        if kind == 'market':
            source, symbol = item.split(':', 1)
            summary['freshness'] = history_freshness(source, symbol, summary['endDate'])
        result[item] = summary
    return result
