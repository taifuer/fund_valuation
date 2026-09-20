import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

from backend import server, storage
from backend.data_coverage import historical_data_coverage
from backend.history_refresh import expected_history_date, read_sync_states, refresh_history_item, retry_is_due
from backend.observability import run_task, worker_task_snapshot


class HistoryRefreshTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        path = Path(temp.name) / 'history-refresh.db'
        self.assertTrue(path.is_relative_to(Path(tempfile.gettempdir())))
        for target, name, value in [(storage, 'DB_PATH', path), (server, 'now_ms', lambda: 100_000),
                                    (server, 'latest_completed_trading_day', lambda *_: '2026-09-18')]:
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        storage.migrate_database(path)
        server._RESPONSE_CACHE.clear()

    def body(self, day='2026-09-18'):
        return 200, 'application/json', json.dumps([{'day': day, 'close': 3000}]).encode()

    def test_success_means_rows_committed_and_expected_session_present(self):
        with patch.object(server, 'fetch_market_history_payload', return_value=self.body()):
            refresh_history_item('sina-cn', 'sh000001')
        state = read_sync_states()['sina-cn:sh000001']
        self.assertEqual(state['status'], 'ok')
        self.assertEqual(state['lastSuccessAt'], 100_000)
        self.assertEqual(state['rowsWritten'], 1)
        self.assertEqual(server.latest_market_history_meta('sina-cn', 'sh000001')[0], '2026-09-18')
        self.assertFalse(retry_is_due('sina-cn', 'sh000001', 100_000))

    def test_stale_http_200_is_not_a_success_and_does_not_hide_the_date_gap(self):
        with patch.object(server, 'fetch_market_history_payload', return_value=self.body('2026-09-15')):
            with self.assertRaisesRegex(ValueError, 'expected 2026-09-18'):
                refresh_history_item('sina-cn', 'sh000001')
        state = read_sync_states()['sina-cn:sh000001']
        self.assertEqual(state['status'], 'stale')
        self.assertEqual(state['lastSuccessAt'], 0)
        self.assertEqual(state['nextCheckAt'], 100_000 + 1800_000)
        self.assertEqual(state['latestDate'], '2026-09-15')

    def test_failed_fetch_retains_history_success_time_and_backs_off(self):
        with patch.object(server, 'fetch_market_history_payload', return_value=self.body()):
            refresh_history_item('sina-cn', 'sh000001')
        with patch.object(server, 'fetch_market_history_payload', return_value=(429, 'text/plain', b'limit')):
            for attempt, delay in enumerate([1800, 3600, 7200, 14400, 21600, 21600], start=1):
                with self.assertRaisesRegex(ValueError, '429'):
                    refresh_history_item('sina-cn', 'sh000001')
                state = read_sync_states()['sina-cn:sh000001']
                self.assertEqual(state['failures'], attempt)
                self.assertEqual(state['nextCheckAt'], 100_000 + delay * 1000)
                self.assertEqual(state['lastSuccessAt'], 100_000)
        self.assertEqual(server.latest_market_history_meta('sina-cn', 'sh000001')[0], '2026-09-18')
        with patch.object(server, 'fetch_market_history_payload', return_value=self.body()):
            refresh_history_item('sina-cn', 'sh000001')
        self.assertEqual(read_sync_states()['sina-cn:sh000001']['failures'], 0)

    def test_empty_or_invalid_payload_never_advances_success(self):
        for body in [b'[]', b'not json', b'[{"day":"2026-09-18","close":0}]']:
            with self.subTest(body=body), patch.object(server, 'fetch_market_history_payload', return_value=(200, 'text/plain', body)):
                with self.assertRaises(ValueError):
                    refresh_history_item('sina-cn', 'sh000001')
            self.assertEqual(read_sync_states()['sina-cn:sh000001']['lastSuccessAt'], 0)

    def test_worker_waits_for_ingestion_continues_after_error_and_records_failure(self):
        calls = []
        def fetch(source, symbol, **kwargs):
            calls.append(symbol)
            running = next(task for task in worker_task_snapshot() if task['name'] == 'market_history')
            self.assertGreater(running['startedAt'], running['finishedAt'])
            if symbol == 'sh000001':
                raise TimeoutError('source timed out')
            return self.body()
        with patch.object(server, 'configured_market_return_items_from_constants', return_value=['sina-cn:sh000001', 'sina-cn:sh000300']), \
                patch.object(server, 'fetch_market_history_payload', side_effect=fetch):
            errors = run_task('market_history', server.refresh_configured_market_history)
        self.assertEqual(calls, ['sh000001', 'sh000300'])
        self.assertEqual(len(errors), 1)
        self.assertEqual(read_sync_states()['sina-cn:sh000300']['status'], 'ok')
        task = worker_task_snapshot()[0]
        self.assertEqual(task['lastSuccessAt'], 0)
        self.assertIn('source timed out', task['error'])
        with patch.object(server, 'fetch_market_history_payload', side_effect=AssertionError('Unexpected early retry')):
            server.ensure_market_history_for_returns('sina-cn', 'sh000001')
            with patch.object(server, 'configured_market_return_items_from_constants', return_value=['sina-cn:sh000001']):
                self.assertTrue(run_task('market_history', server.refresh_configured_market_history))
        self.assertEqual(worker_task_snapshot()[0]['lastSuccessAt'], 0)

    def test_diagnostics_separate_missing_stale_and_failed_items(self):
        with patch.object(server, 'fetch_market_history_payload', return_value=self.body('2026-09-15')):
            with self.assertRaises(ValueError):
                refresh_history_item('sina-cn', 'sh000001')
        with patch('backend.data_coverage.configured_market_return_items', return_value=['sina-cn:sh000001', 'sina-cn:sh000300']):
            coverage = historical_data_coverage()
        self.assertEqual(coverage['summary']['marketsStale'], 1)
        self.assertEqual(coverage['summary']['marketsWithoutHistory'], 1)
        self.assertEqual(coverage['markets'][0]['expectedDate'], '2026-09-18')
        self.assertIn('expected 2026-09-18', coverage['markets'][0]['refresh']['error'])

    def test_crypto_expected_day_uses_utc_not_beijing_date(self):
        current = datetime.fromisoformat('2026-09-20T01:00:00+08:00')
        self.assertEqual(expected_history_date('coinmetrics-crypto', 'BTC', current), '2026-09-18')

    def test_twse_refresh_is_tracked_after_actual_import(self):
        def store(*args, **kwargs):
            self.assertTrue(kwargs['force_refresh'])
            with storage.get_conn() as conn:
                conn.execute("INSERT INTO market_history VALUES ('twse-official','TWII','2026-09-18',30000,100000)")
            return 1
        with patch.object(server, 'refresh_twse_history', side_effect=store) as fetch:
            refresh_history_item('twse-official', 'TWII')
        fetch.assert_called_once_with(60, force_refresh=True)
        self.assertEqual(read_sync_states()['twse-official:TWII']['status'], 'ok')
