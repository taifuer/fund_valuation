from __future__ import annotations

import sqlite3
import tempfile
import unittest
import os
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from backend.db_admin import backup_database, ensure_recent_backup, restore_database
from backend.storage import SCHEMA_VERSION, database_status, migrate_database


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


if __name__ == "__main__":
    unittest.main()
