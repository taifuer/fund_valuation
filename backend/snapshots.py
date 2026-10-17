"""Compact, compressed publications; HTTP readers never rebuild estimates."""
from __future__ import annotations

import hashlib
import json
from typing import Any

from .storage import decode_cache_body, encode_cache_body, get_conn


def encode_payload(payload: dict, *, compressed: bool = False) -> str | bytes:
    text = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return encode_cache_body(text.encode()) if compressed else text


def decode_payload(value: str | bytes) -> dict:
    return json.loads(decode_cache_body(value) if isinstance(value, bytes) else value)


def read_snapshot(name: str) -> dict | None:
    with get_conn() as conn:
        row = conn.execute('SELECT payload,generated_at FROM dashboard_snapshots WHERE name=?', (name,)).fetchone()
    if not row:
        return None
    try:
        payload = decode_payload(row[0])
    except (ValueError, TypeError):
        return None
    if not isinstance(payload, dict):
        return None
    return {**payload, 'generatedAt': row[1]}


def compact_estimate(result: dict) -> dict:
    compact = {key: value for key, value in result.items()
               if key not in {'holdings', 'holdingQuotes', 'holdingMarketStates', 'generatedAt', '_holdingsRef'}}
    for kind in ('pending', 'preview'):
        if isinstance(compact.get(kind), dict):
            compact[kind] = {key: value for key, value in compact[kind].items()
                             if key not in {'holdingContributions', 'benchmarkComponents'}}
    compact['holdingSymbols'] = [holding['sinaSymbol'] for holding in result.get('holdings', [])
                                 if holding.get('sinaSymbol')]
    return compact


def content_signature(value: Any) -> str:
    def stable(item):
        if isinstance(item, dict):
            # Compute/fetch clocks are heartbeats; quote times, dates and quality
            # remain part of the identity even when the price has not changed.
            return {key: stable(value) for key, value in item.items()
                    if key not in {'asOf', 'fetchedAt', 'generatedAt', 'snapshotId'}}
        return [stable(value) for value in item] if isinstance(item, list) else item
    return hashlib.sha256(json.dumps(stable(value), sort_keys=True, separators=(',', ':')).encode()).hexdigest()[:24]


def read_fund_detail(name: str) -> dict | None:
    detail = read_snapshot(name)
    if detail is None:
        return None
    reference = detail.pop('_holdingsRef', None)
    if reference:
        static = read_snapshot(reference)
        if static is None:
            return None
        detail.update({key: value for key, value in static.items() if key != 'generatedAt'})
    return detail


def publish_fund_details(payload: dict[str, dict], now: int) -> dict[str, dict]:
    publications = []
    compact = {}
    for code, result in payload.items():
        snapshot_id = content_signature(result)
        name = f'fund-detail:{code}:{snapshot_id}'
        previous = read_fund_detail(name)
        if previous:
            result = {key: value for key, value in previous.items() if key != 'generatedAt'}
            payload[code] = result
        else:
            static = {key: result[key] for key in ('holdings', 'holdingDisclosure') if key in result}
            static_name = f'fund-static:{code}:{content_signature(static)}'
            for kind in ('pending', 'preview'):
                if isinstance(result.get(kind), dict):
                    result[kind]['snapshotId'] = snapshot_id
            detail = {key: value for key, value in result.items() if key not in static}
            detail['_holdingsRef'] = static_name
            publications.extend([(static_name, encode_payload(static, compressed=True), now),
                                 (name, encode_payload(detail, compressed=True), now)])
        compact[code] = {**compact_estimate(result), '_detailRef': name}
    # Content serialization/compression takes place outside the writer transaction.
    body = encode_payload(compact, compressed=True)
    with get_conn() as conn:
        conn.executemany('INSERT INTO dashboard_snapshots VALUES (?,?,?) ON CONFLICT(name) DO NOTHING', publications)
        for code in payload:
            conn.execute('''DELETE FROM dashboard_snapshots WHERE name LIKE ? AND name NOT IN
                (SELECT name FROM dashboard_snapshots WHERE name LIKE ? ORDER BY generated_at DESC,rowid DESC LIMIT 3)''',
                (f'fund-detail:{code}:%', f'fund-detail:{code}:%'))
            retained = conn.execute('SELECT payload FROM dashboard_snapshots WHERE name LIKE ?',
                                    (f'fund-detail:{code}:%',)).fetchall()
            references = {decode_payload(row[0]).get('_holdingsRef', '') for row in retained}
            for (name,) in conn.execute('SELECT name FROM dashboard_snapshots WHERE name LIKE ?', (f'fund-static:{code}:%',)):
                if name not in references:
                    conn.execute('DELETE FROM dashboard_snapshots WHERE name=?', (name,))
        conn.execute('''INSERT INTO dashboard_snapshots VALUES ('fund-estimates',?,?)
            ON CONFLICT(name) DO UPDATE SET payload=excluded.payload,generated_at=excluded.generated_at
            WHERE dashboard_snapshots.payload<>excluded.payload''', (body, now))
    return compact
