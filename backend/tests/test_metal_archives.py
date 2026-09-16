import calendar
import json
import tempfile
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

from backend import storage
from backend.long_history import assets, read_points, refresh, save_points, stored_daily_points
from backend.long_history_sources import parse_yahoo
from backend.metal_archives import store_metal_archive, sync_metals, validate_metals

NOW = datetime.fromisoformat('2026-09-16T12:00:00+08:00')
GOLD = next(asset for asset in assets() if asset['id'] == 'GC')


def archive_rows():
    rows = []
    for serial in range(2000 * 12 + 7, 2026 * 12 + 8):
        year, month = serial // 12, serial % 12 + 1
        day = date(year, month, calendar.monthrange(year, month)[1])
        while day.weekday() > 4:
            day -= timedelta(days=1)
        rows.append({'period': day.isoformat()[:7], 'date': day.isoformat(), 'close': 100 + len(rows),
                     'source': 'yahoo', 'sourceUrl': 'https://query1.finance.yahoo.com/', 'monthComplete': True})
    return rows


def yahoo_payload(symbol, interval, rows):
    return json.dumps({'chart': {'error': None, 'result': [{
        'meta': {'symbol': symbol, 'instrumentType': 'FUTURE', 'currency': 'USD',
                 'dataGranularity': interval, 'exchangeTimezoneName': 'America/New_York'},
        'timestamp': [int(datetime.fromisoformat(row['date'] if interval == '1d' else row['period'] + '-01')
                          .replace(tzinfo=ZoneInfo('America/New_York')).timestamp()) for row in rows],
        'indicators': {'quote': [{'close': [row['close'] for row in rows]}],
                       'adjclose': [{'adjclose': [999 for _ in rows]}]},
    }]}}).encode()


class MetalArchiveTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        path = Path(temp.name) / 'metals-test.db'
        self.assertTrue(path.is_relative_to(Path(tempfile.gettempdir())))
        patcher = patch.object(storage, 'DB_PATH', path)
        patcher.start()
        self.addCleanup(patcher.stop)
        storage.migrate_database(path)
        self.rows = archive_rows()

    def test_daily_parser_uses_actual_close_and_checks_asset_frequency_currency_and_type(self):
        payload = yahoo_payload('GC=F', '1d', self.rows[-2:])
        parsed = parse_yahoo(payload.decode(), 'GC=F', 'url', interval='1d')
        self.assertEqual(parsed[0]['date'], self.rows[-2]['date'])
        self.assertEqual(parsed[0]['close'], self.rows[-2]['close'])
        self.assertNotIn('monthComplete', parsed[0])
        for expected in ['SI=F', '^GSPC']:
            with self.assertRaises(ValueError):
                parse_yahoo(payload.decode(), expected, 'url', interval='1d')
        with self.assertRaises(ValueError):
            parse_yahoo(payload.decode(), 'GC=F', 'url')
        for field, value in [('currency', 'CNY'), ('instrumentType', 'EQUITY')]:
            bad = json.loads(payload)
            bad['chart']['result'][0]['meta'][field] = value
            with self.assertRaisesRegex(ValueError, 'USD futures'):
                parse_yahoo(json.dumps(bad), 'GC=F', 'url', interval='1d')

    def test_daily_aggregation_fills_monthly_omissions_without_interpolation(self):
        daily = [{key: value for key, value in row.items() if key != 'monthComplete'} for row in self.rows]
        result = validate_metals(GOLD, daily, daily[-13:], NOW)
        self.assertEqual(len(result), 313)
        self.assertEqual(result[2]['period'], '2000-10')
        self.assertEqual(result[2]['close'], daily[2]['close'])

    def test_validator_rejects_missing_boundaries_gaps_duplicates_and_segment_conflicts(self):
        for bad in [self.rows[1:], self.rows[:-1], self.rows[:20] + self.rows[21:], self.rows + [self.rows[-1]]]:
            with self.subTest(length=len(bad)), self.assertRaises(ValueError):
                validate_metals(GOLD, bad, self.rows, NOW)
        with self.assertRaisesRegex(ValueError, '12 segmented daily'):
            validate_metals(GOLD, self.rows, self.rows[:11], NOW)
        with self.assertRaisesRegex(ValueError, 'conflict'):
            validate_metals(GOLD, self.rows, [*self.rows[:-1], {**self.rows[-1], 'close': 5000}], NOW)
        with self.assertRaisesRegex(ValueError, 'Invalid gold/silver'):
            validate_metals(GOLD, [*self.rows[:-1], {**self.rows[-1], 'close': 0}], self.rows, NOW)

    def test_current_month_is_excluded_even_when_it_contains_prices(self):
        current = {**self.rows[-1], 'period': '2026-09', 'date': '2026-09-16', 'close': 800}
        result = validate_metals(GOLD, [*self.rows, current], [*self.rows, current], NOW)
        self.assertEqual(result[-1]['period'], '2026-08')

    def test_atomic_replacement_removes_the_mixed_basis_without_touching_daily_quotes(self):
        save_points('GC', [{**row, 'source': 'sina', 'close': row['close'] * 1.03} for row in self.rows[-12:]], 1)
        with storage.get_conn() as conn:
            conn.execute("INSERT INTO market_history VALUES ('sina-futures','GC','2026-08-31',5000,1)")
        self.assertEqual(store_metal_archive('GC', self.rows, NOW), 313)
        self.assertEqual(store_metal_archive('GC', self.rows, NOW), 313)
        self.assertEqual({row['source'] for row in read_points('GC')}, {'yahoo'})
        self.assertEqual(read_points('GC')[-1]['close'], self.rows[-1]['close'])
        self.assertEqual(stored_daily_points(GOLD, NOW), [])
        with storage.get_conn() as conn:
            self.assertEqual(conn.execute("SELECT close FROM market_history WHERE symbol='GC'").fetchone()[0], 5000)

    def test_short_responses_or_revisions_cannot_destroy_existing_records(self):
        store_metal_archive('GC', self.rows, NOW)
        old = read_points('GC')
        for bad in [self.rows[1:], self.rows[:-1], [*self.rows[:-1], {**self.rows[-1], 'close': 1234}],
                    [{**self.rows[0], 'source': 'sina'}, *self.rows[1:]],
                    [*self.rows[:-1], {**self.rows[-1], 'close': float('nan')}]]:
            with self.subTest(length=len(bad)), self.assertRaises(ValueError):
                store_metal_archive('GC', bad, NOW)
            self.assertEqual(read_points('GC'), old)
        with self.assertRaises(ValueError):
            store_metal_archive('INX', self.rows, NOW)

    def test_import_does_not_truncate_older_unknown_or_newer_archives(self):
        for row in [{**self.rows[0], 'period': '1999-12', 'date': '1999-12-31'},
                    {**self.rows[0], 'source': 'other'},
                    {**self.rows[-1], 'period': '2026-09', 'date': '2026-09-30'}]:
            with self.subTest(row=row), storage.get_conn() as conn:
                conn.execute("DELETE FROM long_market_history WHERE asset_id='GC'")
                conn.execute('INSERT INTO long_market_history VALUES (?,?,?,?,?,?,?,?)',
                             ('GC', row['period'], row['date'], row['close'], row['source'], row['sourceUrl'], 1, 1))
            with self.assertRaises(ValueError):
                store_metal_archive('GC', self.rows, NOW)
            self.assertEqual(len(read_points('GC')), 1)

    def test_offline_sync_is_serial_caches_raws_and_keeps_other_assets_when_one_source_fails(self):
        save_points('SI', [{**self.rows[-1], 'source': 'sina'}], 1)
        replies = [(200, 'application/json', yahoo_payload('GC=F', '1d', self.rows)) for _ in range(4)]
        with patch('backend.server.fetch_upstream', side_effect=[*replies, (599, 'text/plain', b'error')]) as fetch, \
                patch('backend.metal_archives.time.sleep'), patch('backend.metal_archives.publish'):
            result = sync_metals(NOW)['metals']
        self.assertEqual(result[0]['months'], 313)
        self.assertTrue(result[1]['retainedExisting'])
        self.assertEqual(read_points('SI')[0]['source'], 'sina')
        self.assertEqual(fetch.call_count, 5)
        self.assertIn('interval=1d', fetch.call_args_list[0].args[0])
        self.assertIn('interval=1d', fetch.call_args_list[1].args[0])
        self.assertNotEqual(fetch.call_args_list[0].args[0], fetch.call_args_list[1].args[0])
        self.assertEqual(fetch.call_args_list[0].kwargs['ttl_seconds'], 30 * 24 * 3600)

    def test_regular_worker_refresh_never_downloads_or_merges_offline_metals(self):
        store_metal_archive('GC', self.rows, NOW)
        with patch('backend.long_history.assets', return_value=[GOLD]), \
                patch('backend.long_history.fetch_rows') as fetch, patch('backend.long_history.publish'):
            result = refresh(limit=100, now=NOW, force=True)
        fetch.assert_not_called()
        self.assertEqual(result['checked'], 0)
        self.assertEqual({row['source'] for row in read_points('GC')}, {'yahoo'})
