from __future__ import annotations

import sqlite3
import tempfile
import unittest
import os
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from backend.db_admin import (
    backup_database,
    ensure_recent_backup,
    optimize_database,
    prune_raw_responses,
    restore_database,
)
from backend.storage import (
    CACHE_BODY_COMPRESSION_MAGIC,
    SCHEMA_VERSION,
    database_status,
    decode_cache_body,
    encode_cache_body,
    migrate_database,
)


class StorageMigrationTests(unittest.TestCase):
    def test_migration_creates_current_schema_and_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "test.db"
            self.assertEqual(migrate_database(path), SCHEMA_VERSION)
            self.assertEqual(migrate_database(path), SCHEMA_VERSION)
            status = database_status(path)

            self.assertEqual(status["schemaVersion"], SCHEMA_VERSION)
            self.assertEqual(status["integrity"], "ok")
            with sqlite3.connect(path) as conn:
                tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
            self.assertIn("fund_nav_history", tables)
            self.assertIn("market_quote_snapshots", tables)
            self.assertIn("fund_estimate_snapshots", tables)

    def test_backup_and_confirmed_restore_preserve_data(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / "database.db"
            backup = root / "backup.db"
            migrate_database(database)
            with sqlite3.connect(database) as conn:
                conn.execute(
                    "INSERT INTO fund_nav_history VALUES (?, ?, ?, ?, ?)",
                    ("000001", "2026-07-01", 1.25, 0.5, 1),
                )
            backup_database(database, backup)
            with sqlite3.connect(database) as conn:
                conn.execute("DELETE FROM fund_nav_history")

            with self.assertRaisesRegex(RuntimeError, "--confirm RESTORE"):
                restore_database(backup, database, confirmed=False)
            safety_backup = restore_database(backup, database, confirmed=True)

            self.assertIsNotNone(safety_backup)
            with sqlite3.connect(database) as conn:
                count = conn.execute("SELECT COUNT(*) FROM fund_nav_history").fetchone()[0]
            self.assertEqual(count, 1)

    def test_newer_database_schema_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "future.db"
            with sqlite3.connect(path) as conn:
                conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION + 1}")
            with self.assertRaisesRegex(RuntimeError, "newer than supported"):
                migrate_database(path)

    def test_schema_six_estimate_table_gains_raw_change_column(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "schema-six.db"
            with sqlite3.connect(path) as conn:
                conn.executescript(
                    """
                    CREATE TABLE fund_estimate_snapshots (
                      code TEXT, target_date TEXT, estimate_kind TEXT, model_version TEXT,
                      base_nav_date TEXT, base_nav REAL, estimated_nav REAL,
                      estimated_change REAL, cumulative_change REAL, coverage REAL,
                      benchmark_source TEXT, benchmark_symbol TEXT, phase TEXT,
                      complete INTEGER, as_of INTEGER, actual_nav REAL,
                      actual_change REAL, error REAL
                    );
                    PRAGMA user_version = 6;
                    """
                )

            self.assertEqual(migrate_database(path), SCHEMA_VERSION)
            with sqlite3.connect(path) as conn:
                columns = {row[1] for row in conn.execute("PRAGMA table_info(fund_estimate_snapshots)")}
            self.assertIn("raw_change", columns)

    def test_schema_eight_removes_unused_history_fetched_indexes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "schema-seven.db"
            migrate_database(path)
            with sqlite3.connect(path) as conn:
                conn.executescript(
                    """
                    CREATE INDEX IF NOT EXISTS idx_fund_nav_history_fetched
                      ON fund_nav_history(fetched_at);
                    CREATE INDEX IF NOT EXISTS idx_market_history_fetched
                      ON market_history(fetched_at);
                    CREATE INDEX IF NOT EXISTS idx_stock_daily_history_fetched
                      ON stock_daily_history(fetched_at);
                    CREATE INDEX IF NOT EXISTS idx_fx_daily_history_fetched
                      ON fx_daily_history(fetched_at);
                    PRAGMA user_version = 7;
                    """
                )

            self.assertEqual(migrate_database(path), SCHEMA_VERSION)
            with sqlite3.connect(path) as conn:
                indexes = {
                    row[0]
                    for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'index'")
                }
            self.assertNotIn("idx_fund_nav_history_fetched", indexes)
            self.assertNotIn("idx_market_history_fetched", indexes)
            self.assertNotIn("idx_stock_daily_history_fetched", indexes)
            self.assertNotIn("idx_fx_daily_history_fetched", indexes)

    def test_response_cache_body_compression_is_transparent(self) -> None:
        small = b"small response"
        large = (b'{"prices":[123.45,678.90]}' * 2000)

        self.assertEqual(encode_cache_body(small), small)
        encoded = encode_cache_body(large)
        self.assertTrue(encoded.startswith(CACHE_BODY_COMPRESSION_MAGIC))
        self.assertLess(len(encoded), len(large))
        self.assertEqual(decode_cache_body(encoded), large)
        self.assertEqual(decode_cache_body(large), large)

    def test_scheduled_backup_respects_interval_and_prunes_expired_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / "database.db"
            backups = root / "backups"
            old_backup = backups / "database-20260601-000000.db"
            migrate_database(database)
            backup_database(database, old_backup)
            current = datetime(2026, 7, 3, 9, 0, tzinfo=ZoneInfo("Asia/Shanghai"))
            old_timestamp = (current - timedelta(days=10)).timestamp()
            os.utime(old_backup, (old_timestamp, old_timestamp))

            created = ensure_recent_backup(database, backup_dir=backups, now=current)
            repeated = ensure_recent_backup(database, backup_dir=backups, now=current + timedelta(hours=1))

            self.assertIsNotNone(created)
            assert created is not None
            self.assertTrue(created.exists())
            self.assertFalse(old_backup.exists())
            self.assertIsNone(repeated)

    def test_scheduled_backup_keeps_only_newest_max_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / "database.db"
            backups = root / "backups"
            migrate_database(database)
            current = datetime(2026, 7, 17, 9, 0, tzinfo=ZoneInfo("Asia/Shanghai"))
            for age_days in range(1, 5):
                path = backups / f"database-202607{17 - age_days:02d}-090000.db"
                backup_database(database, path)
                timestamp = (current - timedelta(days=age_days)).timestamp()
                os.utime(path, (timestamp, timestamp))

            created = ensure_recent_backup(
                database,
                backup_dir=backups,
                retention_days=30,
                max_files=3,
                now=current,
            )

            self.assertIsNotNone(created)
            retained = sorted(backups.glob("database-*.db"), key=lambda path: path.stat().st_mtime, reverse=True)
            self.assertEqual(len(retained), 3)
            self.assertEqual(retained[0], created)

    def test_optimize_prunes_only_expired_regenerable_cache(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / "database.db"
            raw = root / "raw"
            migrate_database(database)
            current = datetime(2026, 7, 17, 9, 0, tzinfo=ZoneInfo("Asia/Shanghai"))
            old_ms = int((current - timedelta(days=20)).timestamp() * 1000)
            fresh_ms = int((current - timedelta(days=2)).timestamp() * 1000)
            with sqlite3.connect(database) as conn:
                conn.executemany(
                    "INSERT INTO response_cache VALUES (?, ?, ?, ?, ?, ?)",
                    [
                        ("old", "https://example.com/old", 200, "text/plain", b"old", old_ms),
                        ("fresh", "https://example.com/fresh", 200, "text/plain", b"fresh", fresh_ms),
                    ],
                )
                conn.execute(
                    "INSERT INTO fund_nav_history VALUES (?, ?, ?, ?, ?)",
                    ("000001", "2026-07-01", 1.25, 0.5, old_ms),
                )
                conn.executemany(
                    """
                    INSERT INTO market_quote_snapshots(
                      symbol, bucket_at, captured_at, quote_time, market_state, source,
                      price, previous_close, change_percent, validation_status,
                      validation_message, raw_line, sanitized_line
                    ) VALUES (?, ?, ?, '', 'closed', 'test', 1, 1, 0, 'ok', '', '', '')
                    """,
                    [
                        ("old", old_ms, old_ms),
                        ("fresh", fresh_ms, fresh_ms),
                    ],
                )
            result = optimize_database(database, raw_dir=raw, now=current)
            with sqlite3.connect(database) as conn:
                cache_keys = [row[0] for row in conn.execute("SELECT cache_key FROM response_cache")]
                snapshot_symbols = [row[0] for row in conn.execute("SELECT symbol FROM market_quote_snapshots")]
                nav_count = conn.execute("SELECT COUNT(*) FROM fund_nav_history").fetchone()[0]
            self.assertEqual(result["deletedResponseCacheRows"], 1)
            self.assertEqual(result["deletedQuoteSnapshotRows"], 1)
            self.assertEqual(cache_keys, ["fresh"])
            self.assertEqual(snapshot_symbols, ["fresh"])
            self.assertEqual(nav_count, 1)

    def test_optimize_compresses_cache_and_deduplicates_quote_lines(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / "database.db"
            raw = root / "raw"
            migrate_database(database)
            current = datetime(2026, 7, 17, 9, 0, tzinfo=ZoneInfo("Asia/Shanghai"))
            current_ms = int(current.timestamp() * 1000)
            body = b'{"history":[1,2,3,4,5]}' * 2000
            quote_line = 'var hq_str_test="test,1,1";'
            with sqlite3.connect(database) as conn:
                conn.execute(
                    "INSERT INTO response_cache VALUES (?, ?, ?, ?, ?, ?)",
                    ("large", "https://example.com/large", 200, "application/json", body, current_ms),
                )
                conn.execute(
                    """
                    INSERT INTO market_quote_snapshots(
                      symbol, bucket_at, captured_at, quote_time, market_state, source,
                      price, previous_close, change_percent, validation_status,
                      validation_message, raw_line, sanitized_line
                    ) VALUES (?, ?, ?, '', 'closed', 'upstream', 1, 1, 0, 'ok', '', ?, ?)
                    """,
                    ("test", current_ms, current_ms, quote_line, quote_line),
                )

            result = optimize_database(database, raw_dir=raw, now=current)

            with sqlite3.connect(database) as conn:
                stored_body = bytes(
                    conn.execute("SELECT body FROM response_cache WHERE cache_key = 'large'").fetchone()[0]
                )
                stored_raw_line = conn.execute(
                    "SELECT raw_line FROM market_quote_snapshots WHERE symbol = 'test'"
                ).fetchone()[0]
            self.assertTrue(stored_body.startswith(CACHE_BODY_COMPRESSION_MAGIC))
            self.assertEqual(decode_cache_body(stored_body), body)
            self.assertEqual(stored_raw_line, "")
            self.assertEqual(result["compressedResponseCacheRows"], 1)
            self.assertGreater(result["compressedResponseCacheBytesSaved"], 0)
            self.assertEqual(result["deduplicatedQuoteSnapshotRows"], 1)
            self.assertEqual(result["deduplicatedQuoteSnapshotBytes"], len(quote_line))

    def test_raw_response_pruning_preserves_recent_and_unknown_directories(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            raw = Path(directory)
            old = raw / "20260701"
            recent = raw / "20260716"
            unknown = raw / "manual"
            for path in (old, recent, unknown):
                path.mkdir()
                (path / "response.txt").write_text("data", encoding="utf-8")
            result = prune_raw_responses(
                raw,
                retention_days=7,
                now=datetime(2026, 7, 17, 9, 0, tzinfo=ZoneInfo("Asia/Shanghai")),
            )
            self.assertEqual(result["removedDirectories"], 1)
            self.assertFalse(old.exists())
            self.assertTrue(recent.exists())
            self.assertTrue(unknown.exists())


if __name__ == "__main__":
    unittest.main()
