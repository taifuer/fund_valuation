from __future__ import annotations

import sqlite3
from pathlib import Path
import os
from typing import Any


ROOT_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.environ.get("FUND_VALUATION_DATA_DIR", ROOT_DIR / "data"))
DB_PATH = DATA_DIR / "fund_valuation.db"
RAW_DIR = DATA_DIR / "raw"
SCHEMA_VERSION = 2


MIGRATIONS: dict[int, str] = {
    1: """
        CREATE TABLE IF NOT EXISTS response_cache (
          cache_key TEXT PRIMARY KEY, url TEXT NOT NULL, status INTEGER NOT NULL,
          content_type TEXT NOT NULL, body BLOB NOT NULL, fetched_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS fund_nav_history (
          code TEXT NOT NULL, date TEXT NOT NULL, nav REAL NOT NULL,
          change_percent REAL NOT NULL, fetched_at INTEGER NOT NULL,
          PRIMARY KEY (code, date)
        );
        CREATE TABLE IF NOT EXISTS fund_purchase_status (
          code TEXT PRIMARY KEY, name TEXT NOT NULL, fund_type TEXT NOT NULL,
          nav_date TEXT NOT NULL, purchase_status TEXT NOT NULL, redeem_status TEXT NOT NULL,
          next_open_date TEXT NOT NULL, min_purchase TEXT NOT NULL, daily_limit TEXT NOT NULL,
          fee_rate TEXT NOT NULL, fetched_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS fund_holdings (
          code TEXT NOT NULL, report_date TEXT NOT NULL, rank INTEGER NOT NULL,
          stock_code TEXT NOT NULL, stock_name TEXT NOT NULL, weight REAL NOT NULL,
          market TEXT NOT NULL, sina_symbol TEXT NOT NULL, currency TEXT NOT NULL,
          fetched_at INTEGER NOT NULL, PRIMARY KEY (code, report_date, rank)
        );
        CREATE TABLE IF NOT EXISTS market_history (
          source TEXT NOT NULL, symbol TEXT NOT NULL, date TEXT NOT NULL,
          close REAL NOT NULL, fetched_at INTEGER NOT NULL,
          PRIMARY KEY (source, symbol, date)
        );
        CREATE TABLE IF NOT EXISTS stock_daily_history (
          sina_symbol TEXT NOT NULL, date TEXT NOT NULL, close REAL NOT NULL,
          change_percent REAL NOT NULL, fetched_at INTEGER NOT NULL,
          PRIMARY KEY (sina_symbol, date)
        );
        CREATE TABLE IF NOT EXISTS fx_daily_history (
          currency TEXT NOT NULL, date TEXT NOT NULL, rate REAL NOT NULL,
          change_percent REAL NOT NULL, fetched_at INTEGER NOT NULL,
          PRIMARY KEY (currency, date)
        );
        CREATE TABLE IF NOT EXISTS fund_estimate_backtest (
          code TEXT NOT NULL, date TEXT NOT NULL, model_version TEXT NOT NULL,
          predicted_change REAL NOT NULL, fitted_change REAL NOT NULL,
          actual_change REAL NOT NULL, error REAL NOT NULL, fitted_error REAL NOT NULL,
          coverage REAL NOT NULL, fetched_at INTEGER NOT NULL,
          PRIMARY KEY (code, date, model_version)
        );
        CREATE TABLE IF NOT EXISTS market_calendar (
          market TEXT NOT NULL, date TEXT NOT NULL, status TEXT NOT NULL,
          sessions TEXT NOT NULL, timezone TEXT NOT NULL, source TEXT NOT NULL,
          fetched_at INTEGER NOT NULL, PRIMARY KEY (market, date)
        );
        CREATE TABLE IF NOT EXISTS background_jobs (
          name TEXT PRIMARY KEY, owner TEXT NOT NULL, lease_until INTEGER NOT NULL,
          last_run_at INTEGER NOT NULL, last_success_at INTEGER NOT NULL,
          last_error_at INTEGER NOT NULL, last_error TEXT NOT NULL, run_count INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS market_quote_snapshots (
          symbol TEXT NOT NULL, bucket_at INTEGER NOT NULL, captured_at INTEGER NOT NULL,
          quote_time TEXT NOT NULL, market_state TEXT NOT NULL, source TEXT NOT NULL,
          price REAL, previous_close REAL, change_percent REAL,
          validation_status TEXT NOT NULL, validation_message TEXT NOT NULL,
          raw_line TEXT NOT NULL, sanitized_line TEXT NOT NULL,
          PRIMARY KEY (symbol, bucket_at)
        );
        CREATE INDEX IF NOT EXISTS idx_market_quote_snapshots_captured
          ON market_quote_snapshots(captured_at);
    """,
    2: """
        CREATE INDEX IF NOT EXISTS idx_response_cache_fetched
          ON response_cache(fetched_at);
        CREATE INDEX IF NOT EXISTS idx_fund_nav_history_fetched
          ON fund_nav_history(fetched_at);
        CREATE INDEX IF NOT EXISTS idx_market_history_fetched
          ON market_history(fetched_at);
        CREATE INDEX IF NOT EXISTS idx_stock_daily_history_fetched
          ON stock_daily_history(fetched_at);
        CREATE INDEX IF NOT EXISTS idx_fx_daily_history_fetched
          ON fx_daily_history(fetched_at);
    """,
}


def get_conn(path: Path | None = None) -> sqlite3.Connection:
    conn = sqlite3.connect(path or DB_PATH, timeout=5.0)
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA synchronous = NORMAL")
    return conn


def schema_version(path: Path | None = None) -> int:
    target = path or DB_PATH
    if not target.exists():
        return 0
    with sqlite3.connect(target) as conn:
        return int(conn.execute("PRAGMA user_version").fetchone()[0])


def migrate_database(path: Path | None = None) -> int:
    target = path or DB_PATH
    target.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(target, timeout=10.0) as conn:
        conn.execute("PRAGMA busy_timeout = 10000")
        conn.execute("PRAGMA journal_mode = WAL")
        current = int(conn.execute("PRAGMA user_version").fetchone()[0])
        if current > SCHEMA_VERSION:
            raise RuntimeError(f"Database schema {current} is newer than supported version {SCHEMA_VERSION}")
        for version in range(current + 1, SCHEMA_VERSION + 1):
            script = MIGRATIONS.get(version)
            if script is None:
                raise RuntimeError(f"Missing database migration {version}")
            conn.executescript(
                "BEGIN IMMEDIATE;\n"
                + script
                + f"\nPRAGMA user_version = {version};\nCOMMIT;"
            )
    return SCHEMA_VERSION


def ensure_storage() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    migrate_database()


def database_status(path: Path | None = None) -> dict[str, Any]:
    target = path or DB_PATH
    if not target.exists():
        return {"path": str(target), "exists": False, "schemaVersion": 0, "integrity": "missing", "sizeBytes": 0}
    with sqlite3.connect(target) as conn:
        integrity = str(conn.execute("PRAGMA integrity_check").fetchone()[0])
        tables = int(conn.execute("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'").fetchone()[0])
        version = int(conn.execute("PRAGMA user_version").fetchone()[0])
    return {
        "path": str(target),
        "exists": True,
        "schemaVersion": version,
        "supportedSchemaVersion": SCHEMA_VERSION,
        "integrity": integrity,
        "tableCount": tables,
        "sizeBytes": target.stat().st_size,
    }
