from __future__ import annotations

import argparse
import math
import os
import signal
import socket
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Callable
from zoneinfo import ZoneInfo

from .db_admin import ensure_recent_backup, optimize_database, positive_int_env
from .storage import DB_PATH
from .server import (
    BACKGROUND_REFRESH_INTERVAL_SECONDS,
    FUND_HOLDINGS_REFRESH_INTERVAL_SECONDS,
    MAX_SINA_SYMBOLS_PER_REQUEST,
    app,
    background_refresh_state_snapshot,
    build_dashboard_payload,
    claim_background_job,
    ensure_storage,
    mark_background_refresh,
    now_ms,
    prewarm_fund_nav_cache_async,
    prewarm_purchase_status_cache,
    prewarm_response_cache,
    publish_dashboard_snapshot,
    prune_in_memory_caches,
    quote_group_refresh_interval,
    quote_symbol_groups,
    refresh_configured_fund_history,
    refresh_configured_fx_history,
    refresh_configured_market_history,
    refresh_fund_profiles,
    refresh_fund_estimate_snapshots,
    refresh_fund_valuation_histories,
    refresh_latest_fund_history,
    refresh_latest_fund_holdings,
    release_background_job,
)


def latest_fund_history_refresh_delay(now: datetime | None = None) -> int:
    current = (now or datetime.now(ZoneInfo("Asia/Shanghai"))).astimezone(ZoneInfo("Asia/Shanghai"))
    window_start = current.replace(hour=16, minute=0, second=0, microsecond=0)
    window_end = current.replace(hour=23, minute=30, second=0, microsecond=0)
    if current < window_start:
        return min(2 * 60 * 60, max(math.ceil((window_start - current).total_seconds()), 1))
    if current < window_end:
        return min(30 * 60, max(math.ceil((window_end - current).total_seconds()), 1))
    return 2 * 60 * 60


class CoalescingMaintenanceQueue:
    def __init__(self, handler: Callable[[set[str]], None]) -> None:
        self._handler = handler
        self._lock = threading.Lock()
        self._pending: set[str] = set()
        self._thread: threading.Thread | None = None

    def submit(self, flags: set[str]) -> None:
        if not flags:
            return
        with self._lock:
            self._pending.update(flags)
            if self._thread is not None and self._thread.is_alive():
                return
            self._thread = threading.Thread(
                target=self._drain,
                daemon=True,
                name="fund-maintenance",
            )
            self._thread.start()

    def _drain(self) -> None:
        while True:
            with self._lock:
                if not self._pending:
                    self._thread = None
                    return
                flags = set(self._pending)
                self._pending.clear()
            try:
                self._handler(flags)
            except Exception as exc:
                print(f"Maintenance queue error: {exc}", flush=True)

    def join(self) -> None:
        while True:
            with self._lock:
                thread = self._thread
            if thread is None:
                return
            thread.join()


def main() -> None:
    parser = argparse.ArgumentParser(description="Fund valuation data refresh worker")
    parser.add_argument("--once", action="store_true", help="Run one refresh cycle and exit")
    parser.add_argument(
        "--interval",
        type=int,
        default=BACKGROUND_REFRESH_INTERVAL_SECONDS,
        help="Seconds between refresh attempts",
    )
    args = parser.parse_args()

    ensure_storage()
    owner = f"worker:{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:8]}"
    maintenance_interval = max(args.interval, 15 * 60)
    print(f"Refresh worker started: owner={owner}, tick=60s", flush=True)

    due = {
        "cash_quotes": 0.0,
        "continuous_quotes": 0.0,
        "fund_nav": 0.0,
        "fund_history_latest": 0.0,
        "fund_history_full": 0.0,
        "fund_holdings": 0.0,
        "fund_profiles": 0.0,
        "fund_purchase": 0.0,
        "market_history": 0.0,
        "fx_history": 0.0,
        "valuation_history": 0.0,
        "backup": 0.0,
        "cleanup": 0.0,
    }

    def refresh_quotes(symbols: list[str], currencies: list[str]) -> None:
        for offset in range(0, len(symbols), MAX_SINA_SYMBOLS_PER_REQUEST):
            chunk = symbols[offset:offset + MAX_SINA_SYMBOLS_PER_REQUEST]
            build_dashboard_payload(chunk, currencies if offset == 0 else [], "", allow_upstream=True)

    stop_event = threading.Event()

    def request_stop(_signum: int, _frame: object) -> None:
        stop_event.set()

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)

    def run_maintenance(flags: set[str]) -> None:
        tasks: list[str] = []
        errors: list[str] = []
        started = time.monotonic()
        with app.app_context():
            if "fund_history_latest" in flags:
                try:
                    result = refresh_latest_fund_history()
                    tasks.append(
                        f"fund-history-latest:{result['updated']}/{result['checked']}"
                        f" failed:{result['failed']}"
                    )
                    errors.extend(f"fund-history-latest: {error}" for error in result["errors"])
                    if result["updated"]:
                        estimate_result = refresh_fund_estimate_snapshots()
                        tasks.append(f"fund-estimates:{estimate_result['funds']}")
                except Exception as exc:
                    errors.append(f"fund-history-latest: {exc}")
            if "fund_nav" in flags:
                try:
                    prewarm_fund_nav_cache_async()
                    tasks.append("fund-nav")
                except Exception as exc:
                    errors.append(f"fund-nav: {exc}")
            if "market_history" in flags:
                try:
                    errors.extend(refresh_configured_market_history())
                    tasks.append("market-history")
                except Exception as exc:
                    errors.append(f"market-history: {exc}")
            if "fx_history" in flags:
                try:
                    rows = refresh_configured_fx_history()
                    tasks.append(f"fx-history:{rows}")
                except Exception as exc:
                    errors.append(f"fx-history: {exc}")
            if "fund_purchase" in flags:
                try:
                    prewarm_purchase_status_cache()
                    tasks.append("fund-purchase")
                except Exception as exc:
                    errors.append(f"fund-purchase: {exc}")
            if "fund_holdings" in flags:
                try:
                    result = refresh_latest_fund_holdings()
                    tasks.append(f"fund-holdings:{result['updated']}/{result['checked']}")
                    errors.extend(f"fund-holdings: {error}" for error in result["errors"])
                    if result.get("changedCodes"):
                        profile_result = refresh_fund_profiles(result["changedCodes"], force_refresh=True)
                        tasks.append(f"fund-profiles:{profile_result['updated']}/{profile_result['checked']}")
                        errors.extend(f"fund-profiles: {error}" for error in profile_result["errors"])
                except Exception as exc:
                    errors.append(f"fund-holdings: {exc}")
            if "fund_profiles" in flags:
                try:
                    result = refresh_fund_profiles()
                    tasks.append(f"fund-profiles:{result['updated']}/{result['checked']}")
                    errors.extend(f"fund-profiles: {error}" for error in result["errors"])
                except Exception as exc:
                    errors.append(f"fund-profiles: {exc}")
            if "fund_history_full" in flags:
                try:
                    errors.extend(refresh_configured_fund_history())
                    prewarm_response_cache()
                    tasks.append("fund-history-full")
                except Exception as exc:
                    errors.append(f"fund-history-full: {exc}")
            if "valuation_history" in flags:
                try:
                    result = refresh_fund_valuation_histories()
                    tasks.append(
                        f"valuation-history:{result['updated']}/{result['checked']}"
                        f" failed:{result['failed']}"
                    )
                    errors.extend(f"valuation-history: {error}" for error in result["errors"])
                except Exception as exc:
                    errors.append(f"valuation-history: {exc}")
            if "backup" in flags and os.environ.get("FUND_VALUATION_AUTO_BACKUP", "0") == "1":
                try:
                    configured_backup_dir = os.environ.get("FUND_VALUATION_BACKUP_DIR", "").strip()
                    backup = ensure_recent_backup(
                        DB_PATH,
                        backup_dir=Path(configured_backup_dir) if configured_backup_dir else None,
                        interval_hours=int(os.environ.get("FUND_VALUATION_BACKUP_INTERVAL_HOURS", "24")),
                        retention_days=int(os.environ.get("FUND_VALUATION_BACKUP_RETENTION_DAYS", "7")),
                        max_files=positive_int_env("FUND_VALUATION_BACKUP_MAX_FILES", 3),
                    )
                    if backup:
                        tasks.append("backup")
                except Exception as exc:
                    errors.append(f"backup: {exc}")
            if "cleanup" in flags:
                try:
                    optimize_database(
                        DB_PATH,
                        response_cache_retention_days=positive_int_env("FUND_VALUATION_RESPONSE_CACHE_RETENTION_DAYS", 14),
                        snapshot_retention_days=positive_int_env("FUND_VALUATION_SNAPSHOT_RETENTION_DAYS", 7),
                        raw_retention_days=positive_int_env("FUND_VALUATION_RAW_RETENTION_DAYS", 7),
                    )
                    tasks.append("cleanup")
                except Exception as exc:
                    errors.append(f"cleanup: {exc}")
            state = background_refresh_state_snapshot()
            updates = {
                "lastRunAt": now_ms(),
                "runCount": int(state.get("runCount", 0) or 0) + 1,
            }
            if errors:
                updates.update({"lastErrorAt": now_ms(), "lastError": "; ".join(errors[:5])[:480]})
            else:
                updates.update({"lastSuccessAt": now_ms(), "lastError": ""})
            mark_background_refresh(owner, **updates)
        elapsed = time.monotonic() - started
        if tasks:
            print(f"Maintenance tasks {','.join(tasks)} completed in {elapsed:.1f}s", flush=True)
        if errors:
            print(f"Maintenance errors: {'; '.join(errors[:5])}", flush=True)

    maintenance_queue = CoalescingMaintenanceQueue(run_maintenance)

    with app.app_context():
        try:
            while not stop_event.is_set():
                started = time.monotonic()
                acquired = claim_background_job(owner, lease_seconds=180)
                tasks: list[str] = []
                errors: list[str] = []
                current = time.monotonic()
                cash_symbols, continuous_symbols = quote_symbol_groups()
                cash_interval = quote_group_refresh_interval(cash_symbols)
                continuous_interval = quote_group_refresh_interval(continuous_symbols)
                quotes_refreshed = False
                if acquired and current >= due["cash_quotes"]:
                    try:
                        refresh_quotes(cash_symbols, [])
                        tasks.append("cash-quotes")
                        quotes_refreshed = True
                    except Exception as exc:
                        errors.append(f"cash-quotes: {exc}")
                    due["cash_quotes"] = current + cash_interval
                if acquired and current >= due["continuous_quotes"]:
                    try:
                        refresh_quotes(continuous_symbols, ["EUR", "HKD", "JPY", "KRW", "USD"])
                        tasks.append("continuous-quotes")
                        quotes_refreshed = True
                    except Exception as exc:
                        errors.append(f"continuous-quotes: {exc}")
                    due["continuous_quotes"] = current + continuous_interval
                if acquired and quotes_refreshed:
                    dashboard_payload = None
                    try:
                        dashboard_payload = publish_dashboard_snapshot()
                        tasks.append("dashboard-snapshot")
                    except Exception as exc:
                        errors.append(f"dashboard-snapshot: {exc}")
                    try:
                        if dashboard_payload is None:
                            raise RuntimeError("dashboard snapshot unavailable")
                        estimate_result = refresh_fund_estimate_snapshots(dashboard_payload)
                        tasks.append(f"fund-estimates:{estimate_result['funds']}")
                    except Exception as exc:
                        errors.append(f"fund-estimates: {exc}")
                maintenance_flags: set[str] = set()
                if acquired:
                    maintenance_intervals = {
                        "fund_nav": 15 * 60 if cash_interval <= 5 * 60 else 60 * 60,
                        "fund_history_full": 24 * 60 * 60,
                        "fund_holdings": FUND_HOLDINGS_REFRESH_INTERVAL_SECONDS,
                        "fund_profiles": 7 * 24 * 60 * 60,
                        "fund_purchase": 6 * 60 * 60,
                        "market_history": max(maintenance_interval, 30 * 60),
                        "fx_history": 24 * 60 * 60,
                        "valuation_history": 24 * 60 * 60,
                        "backup": 60 * 60,
                        "cleanup": 24 * 60 * 60,
                    }
                    if current >= due["fund_history_latest"]:
                        maintenance_flags.add("fund_history_latest")
                        due["fund_history_latest"] = current + latest_fund_history_refresh_delay()
                    for name, interval in maintenance_intervals.items():
                        if current >= due[name]:
                            maintenance_flags.add(name)
                            due[name] = current + interval
                    maintenance_queue.submit(maintenance_flags)
                prune_in_memory_caches()
                elapsed = time.monotonic() - started
                if acquired and tasks:
                    state = background_refresh_state_snapshot()
                    run_count = int(state.get("runCount", 0) or 0) + 1
                    updates = {"lastRunAt": now_ms(), "runCount": run_count}
                    if errors:
                        updates.update({"lastErrorAt": now_ms(), "lastError": "; ".join(errors[:5])[:480]})
                    else:
                        updates.update({"lastSuccessAt": now_ms(), "lastError": ""})
                    mark_background_refresh(owner, **updates)
                    print(f"Worker tasks {','.join(tasks)} completed in {elapsed:.1f}s", flush=True)
                    if errors:
                        print(f"Worker errors: {'; '.join(errors[:5])}", flush=True)
                else:
                    if not acquired:
                        print("Refresh tick skipped: another worker owns the lease", flush=True)
                if args.once:
                    maintenance_queue.join()
                    return
                stop_event.wait(max(60 - elapsed, 1))
        except KeyboardInterrupt:
            print("Refresh worker stopped", flush=True)
        finally:
            maintenance_queue.join()
            release_background_job(owner)


if __name__ == "__main__":
    main()
