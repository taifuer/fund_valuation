import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

from backend import config, server, storage
from backend.index_archives import INDEX_SYMBOLS, index_history_url, parse_index_history, sync_indices
from backend.long_history import assets, fetch_rows, read_points, stored_daily_points


def payload(symbol='RUT', dates=None, closes=None):
    dates = dates or ['2026-09-14', '2026-09-15', '2026-09-16']
    return {'chart': {'error': None, 'result': [{
        'meta': {'symbol': '^' + symbol, 'currency': 'USD', 'instrumentType': 'INDEX',
                 'regularMarketTime': int(datetime.fromisoformat('2026-09-16T10:00:00-04:00').timestamp()),
                 'dataGranularity': '1d', 'exchangeTimezoneName': 'America/New_York'},
        'timestamp': [int(datetime.fromisoformat(day).replace(hour=9, minute=30, tzinfo=ZoneInfo('America/New_York')).timestamp()) for day in dates],
        'indicators': {'quote': [{'close': closes if closes is not None else [100, 102, 900]}],
                       'adjclose': [{'adjclose': [999] * len(dates)}]},
    }]}}


class IndexArchiveTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        path = Path(temp.name) / 'indices-test.db'
        self.assertTrue(path.is_relative_to(Path(tempfile.gettempdir())))
        patcher = patch.object(storage, 'DB_PATH', path)
        patcher.start()
        self.addCleanup(patcher.stop)
        storage.migrate_database(path)
        patcher = patch.object(server, 'latest_completed_trading_day', return_value='2026-09-15')
        patcher.start()
        self.addCleanup(patcher.stop)
        server._RESPONSE_CACHE.clear()

    def test_cash_index_identity_and_completed_close_only(self):
        for symbol in INDEX_SYMBOLS:
            rows = parse_index_history(json.dumps(payload(symbol)), symbol, '2026-09-15')
            self.assertEqual(rows, [{'date': '2026-09-14', 'close': 100}, {'date': '2026-09-15', 'close': 102}])
        for key, value in [('symbol', '^SOX'), ('instrumentType', 'ETF'), ('currency', 'CNY'),
                           ('dataGranularity', '1mo'), ('exchangeTimezoneName', 'Asia/Shanghai')]:
            bad = payload()
            bad['chart']['result'][0]['meta'][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                parse_index_history(json.dumps(bad), 'RUT', '2026-09-15')

    def test_parser_rejects_duplicates_bad_prices_and_empty_responses(self):
        for closes in [[100, 0, 5], [100, float('nan'), 5], [100, True, 5], [100, -1, 5], [1]]:
            with self.subTest(closes=closes), self.assertRaises(ValueError):
                parse_index_history(json.dumps(payload(closes=closes)), 'RUT', '2026-09-15')
        with self.assertRaises(ValueError):
            parse_index_history(json.dumps(payload(dates=['2026-09-15'] * 3)), 'RUT', '2026-09-15')
        with self.assertRaises(ValueError):
            parse_index_history('{"chart":{"result":null}}', 'RUT', '2026-09-15')
        rows = parse_index_history(json.dumps(payload(closes=[None, 102, 900])), 'RUT', '2026-09-15')
        self.assertEqual(len(rows), 1)

    def test_cached_intraday_bar_does_not_become_a_close_after_the_clock_advances(self):
        rows = parse_index_history(json.dumps(payload()), 'RUT', '2026-09-17')
        self.assertEqual(rows[-1], {'date': '2026-09-15', 'close': 102})
        bad = payload()
        bad['chart']['result'][0]['meta'].pop('regularMarketTime')
        with self.assertRaisesRegex(ValueError, 'observation timestamp'):
            parse_index_history(json.dumps(bad), 'RUT', '2026-09-17')

    def test_observation_time_uses_half_day_calendar_not_a_fixed_1600_cutoff(self):
        raw = payload(dates=['2026-11-25', '2026-11-27'], closes=[100, 102])
        raw['chart']['result'][0]['meta']['regularMarketTime'] = int(datetime.fromisoformat('2026-11-27T13:00:00-05:00').timestamp())
        with patch.object(server, 'latest_completed_trading_day', return_value='2026-11-27') as calendar:
            rows = parse_index_history(json.dumps(raw), 'RUT', '2026-11-30')
        self.assertEqual(rows[-1]['date'], '2026-11-27')
        self.assertEqual(calendar.call_args.args[1].hour, 13)

    def test_only_allowlisted_symbols_and_incremental_ten_day_overlap(self):
        now = datetime.fromisoformat('2026-09-16T12:00:00+08:00')
        for symbol in ['AAPL', '^RUT', '../../other', 'http://example.com', '']:
            with self.assertRaises(ValueError):
                index_history_url(symbol)
        url = index_history_url('RUT', '2026-09-15', now)
        self.assertEqual(urlparse(url).hostname, 'query1.finance.yahoo.com')
        self.assertIn('%5ERUT', url)
        start = int(parse_qs(urlparse(url).query)['period1'][0])
        self.assertEqual(datetime.fromtimestamp(start, ZoneInfo('America/New_York')).date().isoformat(), '2026-09-05')
        self.assertIn('period1=-2208988800', index_history_url('RUT', now=now))

    def test_configuration_has_histories_but_no_live_polling_or_futures(self):
        symbols = config.configured_sina_symbols()
        histories = config.configured_market_return_items()
        for symbol in INDEX_SYMBOLS:
            self.assertNotIn(f'gb_{symbol.lower()}', symbols)
            self.assertIn(f'yahoo-index:{symbol}', histories)
            item = next(asset for asset in assets() if asset['id'] == symbol)
            self.assertEqual(item['group'], 'usa')
            self.assertEqual(item['basis'], 'price')
            self.assertEqual(server.market_history_quote_symbol('yahoo-index', symbol), f'gb_{symbol.lower()}')

    def test_store_is_incremental_and_does_not_overwrite_on_invalid_response(self):
        server.store_market_history('yahoo-index', 'RUT', json.dumps(payload()))
        with self.assertRaises(ValueError):
            server.store_market_history('yahoo-index', 'RUT', json.dumps(payload(closes=[100, 120, 900])))
        with self.assertRaises(ValueError):
            server.store_market_history('yahoo-index', 'RUT', json.dumps(payload('SOX')))
        server.store_market_history('yahoo-index', 'RUT', json.dumps(payload(dates=['2026-09-15'], closes=[102])))
        self.assertEqual(len(server.read_market_history_from_db('yahoo-index', 'RUT')), 2)
        summary = server.read_market_return_summary_from_db('yahoo-index', 'RUT')
        self.assertAlmostEqual(summary['latest']['returnPercent'], 2)
        self.assertEqual(summary['latest']['endDate'], '2026-09-15')

    def test_public_history_and_returns_read_sqlite_without_upstream_requests(self):
        server.store_market_history('yahoo-index', 'RUT', json.dumps(payload()))
        with patch.object(server, 'fetch_upstream', side_effect=AssertionError('Unexpected network')):
            client = server.app.test_client()
            response = client.get('/api/markethistory?source=yahoo-index&symbol=RUT')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json()[-1]['close'], 102)
            response = client.get('/api/marketreturns?items=yahoo-index:RUT')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json()['yahoo-index:RUT']['latest']['endClose'], 102)

    def test_monthly_archive_uses_daily_store_and_yahoo_provenance(self):
        raw = payload(dates=['2026-08-28', '2026-08-31', '2026-09-01'], closes=[100, 102, 103])
        server.store_market_history('yahoo-index', 'RUT', json.dumps(raw))
        asset = next(asset for asset in assets() if asset['id'] == 'RUT')
        now = datetime.fromisoformat('2026-09-16T12:00:00+08:00')
        with patch.object(server, 'fetch_upstream', side_effect=AssertionError('Unexpected network')):
            rows = fetch_rows(asset, now, twse_months=1)
        self.assertEqual(rows[0]['period'], '2026-08')
        self.assertEqual(rows[0]['close'], 102)
        self.assertEqual(rows[0]['source'], 'yahoo')

    def test_full_import_rejects_short_archive_and_preserves_existing_data(self):
        server.store_market_history('yahoo-index', 'RUT', json.dumps(payload()))
        with patch.object(server, 'fetch_upstream', return_value=(200, 'application/json', json.dumps(payload()).encode())), \
                patch('backend.index_archives.INDEX_SYMBOLS', {'RUT': '^RUT'}), patch('backend.index_archives.time.sleep'):
            result = sync_indices()
        self.assertIn('Incomplete index archive start', result['indices'][0]['error'])
        self.assertTrue(result['indices'][0]['retainedExisting'])
        self.assertEqual(len(server.read_market_history_from_db('yahoo-index', 'RUT')), 2)
        self.assertEqual(read_points('RUT'), [])
