import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

from backend import server, storage
from backend.history_refresh import history_freshness


class HistoryFreshnessTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        path = Path(temp.name) / 'freshness.db'
        self.assertTrue(path.is_relative_to(Path(tempfile.gettempdir())))
        patcher = patch.object(storage, 'DB_PATH', path)
        patcher.start()
        self.addCleanup(patcher.stop)
        storage.migrate_database(path)
        server.ensure_market_calendar_seeded(2026)
        server._RESPONSE_CACHE.clear()
        self.addCleanup(server._RESPONSE_CACHE.clear)

    def freshness(self, source, symbol, latest, now):
        return history_freshness(source, symbol, latest, datetime.fromisoformat(now))

    def test_us_weekend_and_before_next_open_keep_friday_close_current(self):
        for now in ['2026-09-20T12:00:00+08:00', '2026-09-21T21:00:00+08:00']:
            with self.subTest(now=now):
                result = self.freshness('yahoo-index', 'RUT', '2026-09-18', now)
                self.assertEqual(result, {'latestDate': '2026-09-18', 'expectedDate': '2026-09-18', 'stale': False})
                self.assertTrue(self.freshness('yahoo-index', 'OEX', '2026-09-15', now)['stale'])

    def test_us_market_day_and_two_hour_publication_grace(self):
        for now, expected, stale in [
            ('2026-09-19T03:59:00+08:00', '2026-09-17', False),
            ('2026-09-19T04:30:00+08:00', '2026-09-17', False),
            ('2026-09-19T05:59:00+08:00', '2026-09-17', False),
            ('2026-09-19T06:00:00+08:00', '2026-09-18', True),
        ]:
            with self.subTest(now=now):
                result = self.freshness('sina-us', '.INX', '2026-09-17', now)
                self.assertEqual((result['expectedDate'], result['stale']), (expected, stale))

    def test_holidays_half_days_and_winter_time(self):
        self.assertFalse(self.freshness('yahoo-index', 'RUT', '2026-09-04', '2026-09-08T06:00:00+08:00')['stale'])
        # Thanksgiving Friday closes at 13:00 EST, not the regular 16:00.
        for now, expected in [('2026-11-28T03:59:00+08:00', '2026-11-25'),
                              ('2026-11-28T04:00:00+08:00', '2026-11-27')]:
            self.assertEqual(self.freshness('yahoo-index', 'OEX', '2026-11-25', now)['expectedDate'], expected)

    def test_cn_lunch_break_does_not_require_todays_close(self):
        for now in ['2026-09-18T12:00:00+08:00', '2026-09-18T16:59:00+08:00']:
            self.assertFalse(self.freshness('sina-cn', 'sz159558', '2026-09-17', now)['stale'])
        self.assertTrue(self.freshness('sina-cn', 'sz159558', '2026-09-17', '2026-09-18T17:00:00+08:00')['stale'])

    def test_crypto_uses_utc_day_boundary_and_publication_grace(self):
        for now, expected in [('2026-09-20T01:00:00+08:00', '2026-09-18'),
                              ('2026-09-20T09:59:00+08:00', '2026-09-18'),
                              ('2026-09-20T10:00:00+08:00', '2026-09-19')]:
            self.assertEqual(self.freshness('coinmetrics-crypto', 'BTC', '2026-09-18', now)['expectedDate'], expected)

    def test_unknown_calendar_does_not_claim_a_missing_session(self):
        result = self.freshness('unknown', 'unknown', '2026-09-15', '2026-09-20T12:00:00+08:00')
        self.assertEqual(result['expectedDate'], '')
        self.assertFalse(result['stale'])

    def test_public_summary_preserves_values_and_recovers_after_incremental_update(self):
        with storage.get_conn() as conn:
            conn.executemany('INSERT INTO market_history VALUES (?,?,?,?,?)', [
                ('yahoo-index', 'RUT', '2026-09-14', 100, 1),
                ('yahoo-index', 'RUT', '2026-09-15', 105, 1),
            ])
        with patch('backend.history_refresh.expected_history_date', return_value='2026-09-18'), \
                patch.object(server, 'fetch_upstream', side_effect=AssertionError('No upstream on page reads')):
            response = server.app.test_client().get('/api/marketreturns?items=yahoo-index:RUT')
            self.assertEqual(response.status_code, 200)
            summary = response.get_json()['yahoo-index:RUT']
            self.assertTrue(summary['freshness']['stale'])
            self.assertEqual(summary['latest']['returnPercent'], 5)
            self.assertEqual(summary['latest']['endDate'], '2026-09-15')
            self.assertEqual(summary['latest']['endClose'], 105)
            with storage.get_conn() as conn:
                conn.execute('INSERT INTO market_history VALUES (?,?,?,?,?)', ('yahoo-index', 'RUT', '2026-09-18', 110, 2))
            server.response_cache_clear_marketreturns_item('yahoo-index:RUT')
            summary = server.app.test_client().get('/api/marketreturns?items=yahoo-index:RUT').get_json()['yahoo-index:RUT']
            self.assertFalse(summary['freshness']['stale'])
            self.assertEqual(summary['latest']['endDate'], '2026-09-18')
