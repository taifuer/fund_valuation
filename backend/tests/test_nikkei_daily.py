import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend import config, server, storage
from backend.backfill import MarketTarget, backfill_market
from backend.nikkei_daily import DAILY_URL, HEADER, parse_daily


def csv_text(*rows):
    return ','.join(HEADER) + '\n' + '\n'.join(rows or (
        '2026/09/14,100,99,102,98', '2026/09/15,110,109,112,108', '2026/09/16,999,998,1000,997',
    ))


class NikkeiDailyTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        path = Path(temp.name) / 'nikkei-test.db'
        self.assertTrue(path.is_relative_to(Path(tempfile.gettempdir())))
        for module in [storage, server]:
            patcher = patch.object(module, 'DB_PATH', path)
            patcher.start()
            self.addCleanup(patcher.stop)
        import backend.backfill as backfill
        patcher = patch.object(backfill, 'DB_PATH', path)
        patcher.start()
        self.addCleanup(patcher.stop)
        storage.migrate_database(path)
        patcher = patch.object(server, 'latest_completed_trading_day', return_value='2026-09-15')
        patcher.start()
        self.addCleanup(patcher.stop)
        server._RESPONSE_CACHE.clear()

    def test_daily_close_column_and_completed_sessions(self):
        rows = parse_daily(csv_text(), '2026-09-15')
        self.assertEqual(rows, [{'date': '2026-09-14', 'close': 100}, {'date': '2026-09-15', 'close': 110}])
        footer = '\n"\u672c\u8cc7\u6599 copyright"\n'
        self.assertEqual(parse_daily(csv_text() + footer, '2026-09-15'), rows)
        self.assertEqual(server.market_history_quote_symbol('nikkei-index', 'N225'), 'int_nikkei')

    def test_invalid_payloads_do_not_write_or_replace_valid_history(self):
        server.store_market_history('nikkei-index', 'N225', csv_text())
        for bad in ['<html>error</html>', 'date,monthly close\n2026/09/01,100',
                    csv_text('2026/09/14,NaN,99,102,98'), csv_text('2026/02/30,100,99,102,98'),
                    csv_text('2026/09/14,0,99,102,98'), csv_text('2026/09/14,-1,99,102,98'),
                    csv_text('2026/09/14,100,99,102,98', '2026/09/14,101,99,102,98')]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                server.store_market_history('nikkei-index', 'N225', bad)
        self.assertEqual(server.read_market_history_from_db('nikkei-index', 'N225')[-1]['close'], 110)

    def test_only_fixed_official_endpoint_and_configured_cash_series(self):
        self.assertEqual(server.market_history_url('nikkei-index', 'N225'), (DAILY_URL, 'https://indexes.nikkei.co.jp/'))
        for symbol in ['NK', '../N225', 'https://example.com', 'SOX']:
            with self.assertRaises(ValueError):
                server.market_history_url('nikkei-index', symbol)
        items = config.configured_market_return_items()
        self.assertIn('nikkei-index:N225', items)
        self.assertNotIn('sina-futures:NK', items)
        self.assertIn('hf_NK', config.configured_sina_symbols())

    def test_payload_decodes_cp932_and_cache_only_backfill_uses_same_encoding(self):
        raw = csv_text().encode('cp932')
        with patch.object(server, 'fetch_upstream', return_value=(200, 'text/csv', raw)):
            status, _, body = server.fetch_market_history_payload('nikkei-index', 'N225', ttl_seconds=300)
        self.assertEqual(status, 200)
        self.assertEqual(server.store_market_history('nikkei-index', 'N225', body.decode()), 2)
        server.cache_put('markethistory:nikkei-index:N225', DAILY_URL, 200, 'text/csv', raw)
        with patch.object(server, 'fetch_upstream', side_effect=AssertionError('network forbidden')):
            self.assertEqual(backfill_market(MarketTarget('nikkei-index', 'N225'), use_cache=True, cache_only=True), (0, True))

    def test_page_reads_are_database_only_and_never_fall_back_to_futures(self):
        server.store_market_history('sina-futures', 'NK', '[{"date":"2026-09-14","close":900},{"date":"2026-09-15","close":950}]')
        client = server.app.test_client()
        url = '/api/markethistory?source=nikkei-index&symbol=N225'
        with patch.object(server, 'fetch_upstream', side_effect=AssertionError('network forbidden')):
            self.assertEqual(client.get(url).get_json(), [])
            server.store_market_history('nikkei-index', 'N225', csv_text())
            self.assertEqual(client.get(url).get_json()[-1]['close'], 110)
            summary = server.read_market_return_summary_from_db('nikkei-index', 'N225')
            self.assertEqual(summary['latest']['returnPercent'], 10)
            self.assertEqual(summary['latest']['endClose'], 110)
            self.assertEqual(server.read_market_history_from_db('sina-futures', 'NK')[-1]['close'], 950)
