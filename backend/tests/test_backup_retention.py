import gc
import os
from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from datetime import datetime
from zoneinfo import ZoneInfo

from backend.db_admin import ensure_recent_backup, prune_backups
from backend.storage import migrate_database


class BackupRetentionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='fund-backup-retention-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.assertTrue(self.root.is_relative_to(Path(tempfile.gettempdir())))
        self.backups = self.root / 'backups'
        self.backups.mkdir()

    def backup(self, name):
        path = self.backups / name
        migrate_database(path)
        # Finish WAL writes before tests assign file timestamps.
        with closing(sqlite3.connect(path)) as conn:
            conn.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        return path

    def test_daily_two_and_deployment_one_leave_other_recovery_files_untouched(self):
        daily = [self.backup(f'fund-202609{day}-090000.db') for day in (20, 21, 22)]
        deployed = [self.backup(f'pre-deploy-202609{day}-100000.db') for day in (20, 21, 22)]
        manual = self.backup('fund-manual.db')
        recovery = self.backup('fund-before-restore-20260920-090000-123456.db')
        daily_shm = Path(str(daily[0]) + '-shm')
        daily_shm.write_bytes(b'old sidecar')
        outside = self.root / 'live.db'
        migrate_database(outside)
        link = self.backups / 'fund-20260923-090000.db'
        link.symlink_to(outside)
        hardlink = self.backups / 'fund-20260924-090000.db'
        os.link(outside, hardlink)

        result = prune_backups(self.backups, prefix='fund', max_files=2)
        self.assertEqual(result['retained'], [daily[2].name, daily[1].name])
        self.assertFalse(daily[0].exists())
        self.assertFalse(daily_shm.exists())
        self.assertTrue(all(path.exists() for path in deployed))
        result = prune_backups(self.backups, prefix='pre-deploy', max_files=1)
        self.assertEqual(result['retained'], [deployed[2].name])
        self.assertFalse(deployed[0].exists())
        self.assertFalse(deployed[1].exists())
        self.assertTrue(all(path.exists() for path in (manual, recovery, link, outside, hardlink)))

    def test_reduced_limit_applies_without_waiting_for_the_next_backup(self):
        database = self.root / 'fund.db'
        migrate_database(database)
        current = datetime(2026, 9, 22, 10, tzinfo=ZoneInfo('Asia/Shanghai'))
        for day in (20, 21, 22):
            path = self.backup(f'fund-202609{day}-090000.db')
            timestamp = current.timestamp() - (22 - day) * 86400 - 3600
            os.utime(path, (timestamp, timestamp))
        with patch('backend.db_admin.backup_database') as create:
            result = ensure_recent_backup(database, backup_dir=self.backups, max_files=2,
                now=current)
        self.assertIsNone(result)
        create.assert_not_called()
        self.assertEqual(len(list(self.backups.glob('fund-*.db'))), 2)

    def test_invalid_retained_backup_blocks_all_deletion(self):
        older = self.backup('pre-deploy-20260920-090000.db')
        corrupt = self.backups / 'pre-deploy-20260922-090000.db'
        corrupt.write_bytes(b'not a database')
        with self.assertRaises((RuntimeError, sqlite3.DatabaseError)):
            prune_backups(self.backups, prefix='pre-deploy', max_files=1)
        self.assertTrue(older.exists())
        self.assertTrue(corrupt.exists())

    def test_failed_new_backup_does_not_prune_existing_copies(self):
        database = self.root / 'fund.db'
        migrate_database(database)
        files = [self.backup(f'fund-202609{day}-090000.db') for day in (19, 20, 21)]
        for path in files:
            os.utime(path, (1, 1))
        gc.collect()
        with patch('backend.db_admin.backup_database', side_effect=RuntimeError('disk full')):
            with self.assertRaisesRegex(RuntimeError, 'disk full'):
                ensure_recent_backup(database, backup_dir=self.backups, max_files=2)
        self.assertTrue(all(path.exists() for path in files))

    def test_zero_limit_is_rejected_and_no_files_is_harmless(self):
        with self.assertRaises(ValueError):
            prune_backups(self.backups, prefix='fund', max_files=0)
        result = prune_backups(self.backups, prefix='fund', max_files=2)
        self.assertEqual(result, {'retained': [], 'removed': [], 'removedBytes': 0})
