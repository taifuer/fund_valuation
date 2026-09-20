import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

from backend import config, server, storage
from backend.index_archives import INDEX_SYMBOLS, SOX_SINA_URL, index_history_url, parse_index_history, sync_indices
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

    def alternate(self, closes=None):
        days = ['2026-09-09', '2026-09-10', '2026-09-11', '2026-09-14', '2026-09-15', '2026-09-16']
        return {'provider': 'sina', 'symbol': 'SOX', 'sourceUrl': SOX_SINA_URL,
                'observedAt': int(datetime.fromisoformat('2026-09-16T18:00:00-04:00').timestamp() * 1000),
                'rows': [{'date': day, 'close': close} for day, close in zip(days, closes or [100, 101, 102, 103, 104, 105])]}

    def seed_sox(self):
        with storage.get_conn() as conn:
            conn.executemany('INSERT INTO market_history VALUES (?,?,?,?,?)',
                             [('yahoo-index', 'SOX', row['date'], row['close'], 1) for row in self.alternate()['rows'][:5]])

    def test_sina_sox_only_appends_after_overlap_verification_and_keeps_provenance(self):
        self.seed_sox()
        with patch.object(server, 'latest_completed_trading_day', return_value='2026-09-16'):
            count = server.store_market_history('yahoo-index', 'SOX', json.dumps(self.alternate()))
        self.assertEqual(count, 1)
        with storage.get_conn() as conn:
            self.assertEqual(conn.execute("SELECT provider,source_url FROM index_history_provenance").fetchall(), [('sina', SOX_SINA_URL)])
            self.assertEqual(conn.execute("SELECT fetched_at FROM market_history WHERE date='2026-09-15'").fetchone()[0], 1)
        self.assertEqual(server.read_market_history_from_db('yahoo-index', 'SOX')[-1]['close'], 105)

    def test_alternate_source_rejects_wrong_identity_missing_overlap_and_conflicting_closes(self):
        with self.assertRaisesRegex(ValueError, 'five overlapping'):
            server.store_market_history('yahoo-index', 'SOX', json.dumps(self.alternate()))
        self.seed_sox()
        with self.assertRaisesRegex(ValueError, 'revision requires review'):
            server.store_market_history('yahoo-index', 'SOX', json.dumps(self.alternate([100, 101, 102, 103, 120, 121])))
        for symbol in ['OEX', 'RUT']:
            with self.assertRaisesRegex(ValueError, 'identity'):
                server.store_market_history('yahoo-index', symbol, json.dumps(self.alternate()))
        with storage.get_conn() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM index_history_provenance').fetchone()[0], 0)
        self.assertEqual(len(server.read_market_history_from_db('yahoo-index', 'SOX')), 5)

    def test_sox_refresh_uses_sina_without_repeating_rate_limited_yahoo_requests(self):
        self.seed_sox()
        body = 'var _=(' + json.dumps([{'d': row['date'], 'c': str(row['close'])} for row in self.alternate()['rows']]) + ');'
        with patch.object(server, 'fetch_upstream', return_value=(200, 'text/plain', body.encode())) as fetch:
            status, _, body = server.fetch_market_history_payload('yahoo-index', 'SOX', ttl_seconds=300, force_refresh=True)
        self.assertEqual(status, 200)
        fetch.assert_called_once()
        self.assertEqual(fetch.call_args.args[0], SOX_SINA_URL)
        self.assertEqual(json.loads(body)['provider'], 'sina')

    def test_cached_alternate_intraday_bar_cannot_become_a_close(self):
        data = self.alternate()
        data['observedAt'] = int(datetime.fromisoformat('2026-09-16T10:00:00-04:00').timestamp() * 1000)
        rows = parse_index_history(json.dumps(data), 'SOX', '2026-09-18')
        self.assertEqual(rows[-1]['date'], '2026-09-15')
        for field, value in [('symbol', 'OEX'), ('sourceUrl', 'https://example.com'), ('observedAt', 0)]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                parse_index_history(json.dumps({**data, field: value}), 'SOX', '2026-09-18')

    def test_month_end_inherits_the_actual_alternate_source(self):
        with storage.get_conn() as conn:
            conn.executemany('INSERT INTO market_history VALUES (?,?,?,?,?)',
                             [('yahoo-index', 'SOX', '2026-08-31', 100, 1), ('yahoo-index', 'SOX', '2026-09-01', 101, 1)])
            conn.execute('INSERT INTO index_history_provenance VALUES (?,?,?,?)', ('SOX', '2026-08-31', 'sina', SOX_SINA_URL))
        asset = next(asset for asset in assets() if asset['id'] == 'SOX')
        rows = stored_daily_points(asset, datetime.fromisoformat('2026-09-20T12:00:00+08:00'))
        self.assertEqual(rows[0]['source'], 'sina')
        self.assertEqual(rows[0]['sourceUrl'], SOX_SINA_URL)

    def test_original_provider_is_available_when_sox_alternate_fails(self):
        self.seed_sox()
        raw = json.dumps(payload('SOX')).encode()
        with patch('backend.index_archives.fetch_sina_sox', side_effect=TimeoutError('timeout')), \
                patch.object(server, 'fetch_upstream', return_value=(200, 'application/json', raw)) as fetch:
            result = server.fetch_market_history_payload('yahoo-index', 'SOX', ttl_seconds=300, force_refresh=True)
        self.assertIn('query1.finance.yahoo.com', fetch.call_args.args[0])
        self.assertEqual(result[2], raw)
