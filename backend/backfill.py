from __future__ import annotations

import argparse
import re
import sqlite3
import time
from dataclasses import dataclass
from typing import TypeVar
from urllib.parse import urlencode

from .server import (
    DB_PATH,
    ROOT_DIR,
    cache_any,
    decode_body,
    ensure_storage,
    fetch_upstream,
    market_history_url,
    parse_jsonp_call,
    store_fund_history,
    store_market_history,
)


DEFAULT_PAGE_SIZE = 20
DEFAULT_MAX_PAGES = 300
T = TypeVar("T")


@dataclass(frozen=True)
class MarketTarget:
    source: str
    symbol: str


def unique(items: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        if item in seen:
            continue
        seen.add(item)
        result.append(item)
    return result


def load_targets() -> tuple[list[str], list[MarketTarget]]:
    constants_path = ROOT_DIR / "src" / "constants.ts"
    text = constants_path.read_text(encoding="utf-8")

    fund_codes = unique(re.findall(r"code:\s*'(\d+)'", text))
    market_pairs = re.findall(
        r"history:\s*\{\s*source:\s*'([^']+)'\s*,\s*symbol:\s*'([^']+)'",
        text,
    )
    markets: list[MarketTarget] = []
    seen_markets: set[tuple[str, str]] = set()
    for source, symbol in market_pairs:
        key = (source, symbol)
        if key in seen_markets:
            continue
        seen_markets.add(key)
        markets.append(MarketTarget(source=source, symbol=symbol))

    return fund_codes, markets


def count_rows(table: str, where: str, params: tuple[str, ...]) -> int:
    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute(f"SELECT COUNT(*) FROM {table} WHERE {where}", params).fetchone()
    return int(row[0] if row else 0)


def fund_existing_dates(code: str) -> set[str]:
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            "SELECT date FROM fund_nav_history WHERE code = ?",
            (code,),
        ).fetchall()
    return {str(row[0]) for row in rows}


def cached_text(cache_key: str) -> str | None:
    cached = cache_any(cache_key)
    if not cached:
        return None
    _, _, body = cached
    return decode_body(body)


def fetch_fund_page(
    code: str,
    *,
    page_index: int,
    page_size: int,
    use_cache: bool,
    cache_only: bool,
) -> tuple[list[dict[str, object]], int | None]:
    cache_key = f"fundhistory:{code}:{page_index}:{page_size}"
    if cache_only:
        text = cached_text(cache_key)
        if text is None:
            return [], None
    else:
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
            cache_key=cache_key,
            kind="fundhistory",
            ttl_seconds=0 if use_cache else 120,
            force_refresh=not use_cache,
        )
        if status >= 400:
            return [], None
        text = decode_body(body)

    parsed = parse_jsonp_call(text, "jQuery")
    data = parsed.get("Data", {}) if isinstance(parsed, dict) else {}
    rows = data.get("LSJZList") if isinstance(data, dict) else None
    try:
        raw_total = data.get("TotalCount") if isinstance(data, dict) else None
        if raw_total is None and isinstance(parsed, dict):
            raw_total = parsed.get("TotalCount")
        total_count = int(raw_total) if raw_total is not None else None
    except (TypeError, ValueError):
        total_count = None
    return (rows if isinstance(rows, list) else []), total_count


def backfill_fund(
    code: str,
    *,
    page_size: int,
    max_pages: int,
    full: bool,
    use_cache: bool,
    cache_only: bool,
) -> tuple[int, int]:
    before = count_rows("fund_nav_history", "code = ?", (code,))
    existing_dates = fund_existing_dates(code)
    fetched_rows = 0

    for page_index in range(1, max_pages + 1):
        rows, total_count = fetch_fund_page(
            code,
            page_index=page_index,
            page_size=page_size,
            use_cache=use_cache,
            cache_only=cache_only,
        )
        if not rows:
            break

        fetched_rows += len(rows)
        new_dates = {str(row.get("FSRQ") or "") for row in rows} - existing_dates
        store_fund_history(code, rows)
        existing_dates.update(str(row.get("FSRQ") or "") for row in rows)

        if full:
            if total_count is not None and fetched_rows >= total_count:
                break
            if total_count is None and len(rows) < page_size:
                break
            continue

        has_missing_history = total_count is not None and len(existing_dates) < total_count
        if not new_dates and not has_missing_history:
            break
        if total_count is not None and len(existing_dates) >= total_count:
            break
        if total_count is None and len(rows) < page_size:
            break

    after = count_rows("fund_nav_history", "code = ?", (code,))
    return after - before, fetched_rows


def backfill_market(
    target: MarketTarget,
    *,
    use_cache: bool,
    cache_only: bool,
) -> tuple[int, bool]:
    before = count_rows(
        "market_history",
        "source = ? AND symbol = ?",
        (target.source, target.symbol),
    )
    cache_key = f"markethistory:{target.source}:{target.symbol}"
    if cache_only:
        text = cached_text(cache_key)
        if text is None:
            return 0, False
    else:
        url, referer = market_history_url(target.source, target.symbol)
        status, _, body = fetch_upstream(
            url,
            referer=referer,
            content_type="application/json; charset=utf-8",
            cache_key=cache_key,
            kind="markethistory",
            ttl_seconds=0 if use_cache else 300,
            force_refresh=not use_cache,
        )
        if status >= 400:
            return 0, False
        text = decode_body(body)

    store_market_history(target.source, target.symbol, text)
    after = count_rows(
        "market_history",
        "source = ? AND symbol = ?",
        (target.source, target.symbol),
    )
    return after - before, True


def limited(items: list[T], limit: int | None) -> list[T]:
    if limit is None:
        return items
    return items[: max(limit, 0)]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Incrementally backfill historical data into SQLite")
    parser.add_argument("--skip-funds", action="store_true", help="Skip fund NAV history")
    parser.add_argument("--skip-markets", action="store_true", help="Skip index and asset daily history")
    parser.add_argument("--full", action="store_true", help="Fetch all pages up to --max-pages")
    parser.add_argument("--use-cache", action="store_true", help="Reuse cached upstream responses when available")
    parser.add_argument("--cache-only", action="store_true", help="Read only from response_cache without network requests")
    parser.add_argument("--page-size", type=int, default=DEFAULT_PAGE_SIZE, help="Fund history page size")
    parser.add_argument("--max-pages", type=int, default=DEFAULT_MAX_PAGES, help="Maximum fund pages per fund")
    parser.add_argument("--fund-limit", type=int, help="Limit fund count, useful for smoke checks")
    parser.add_argument("--market-limit", type=int, help="Limit market count, useful for smoke checks")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    ensure_storage()

    fund_codes, market_targets = load_targets()
    fund_codes = limited(fund_codes, args.fund_limit)
    market_targets = limited(market_targets, args.market_limit)

    print(f"SQLite database: {DB_PATH}", flush=True)
    print(f"Targets: {len(fund_codes)} funds, {len(market_targets)} markets", flush=True)

    total_new_fund_rows = 0
    if not args.skip_funds:
        for index, code in enumerate(fund_codes, start=1):
            new_rows, fetched_rows = backfill_fund(
                code,
                page_size=max(args.page_size, 2),
                max_pages=max(args.max_pages, 1),
                full=args.full,
                use_cache=args.use_cache,
                cache_only=args.cache_only,
            )
            total_new_fund_rows += new_rows
            print(f"[fund {index}/{len(fund_codes)}] {code}: +{new_rows} rows ({fetched_rows} fetched)", flush=True)

    total_new_market_rows = 0
    if not args.skip_markets:
        for index, target in enumerate(market_targets, start=1):
            new_rows, ok = backfill_market(target, use_cache=args.use_cache, cache_only=args.cache_only)
            total_new_market_rows += new_rows
            status = "ok" if ok else "skip"
            print(
                f"[market {index}/{len(market_targets)}] "
                f"{target.source}:{target.symbol}: +{new_rows} rows ({status})",
                flush=True,
            )

    print(f"Done. New rows: funds +{total_new_fund_rows}, markets +{total_new_market_rows}", flush=True)


if __name__ == "__main__":
    main()
