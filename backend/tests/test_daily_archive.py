import json
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch

from backend import daily_archive, server, storage
from backend.performance import daily_range_covered, history_cutoff


def payload(rows, symbol='sh000001', key='day'):
    return json.dumps({'code': 0, 'data': {symbol: {key: [[day, close, close, close, close, '100']
                                                       for day, close in rows]}}})


class DailyArchiveTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        path = Path(temp.name) / 'archive-test.db'
        self.assertTrue(path.is_relative_to(Path(tempfile.gettempdir())))
        for module in (storage, server):
            patcher = patch.object(module, 'DB_PATH', path)
            patcher.start()
            self.addCleanup(patcher.stop)
        storage.migrate_database(path)
        self.rows = [('2022-04-13', 100), ('2022-04-14', 101), ('2022-04-15', 102)]
        with storage.get_conn() as conn:
            conn.executemany('INSERT INTO market_history VALUES (?,?,?,?,?)',
                [('sina-cn', 'sh000001', day, close, 1) for day, close in self.rows])
        for name, value in [('configured_market_return_items', ['sina-cn:sh000001'])]:
            patcher = patch.object(daily_archive, name, return_value=value)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = patch.object(daily_archive.time, 'sleep')
        patcher.start()
        self.addCleanup(patcher.stop)
        server._RESPONSE_CACHE.clear()

    def test_extension_is_bounded_insert_only_and_resumable(self):
        text = payload([('2021-01-04', 90), *self.rows])
        with patch.object(server, 'fetch_upstream', return_value=(200, '', text.encode())) as fetch:
            result = daily_archive.refresh(max_requests=1)
        self.assertEqual(result['inserted'], 1)
        self.assertEqual(fetch.call_count, 1)
        self.assertIn('2021-01-01', fetch.call_args.args[0])
        with storage.get_conn() as conn:
            self.assertEqual(conn.execute("SELECT fetched_at FROM market_history WHERE date='2022-04-13'").fetchone()[0], 1)
            state = conn.execute('SELECT oldest_date,status,source_url FROM market_history_backfill').fetchone()
        self.assertEqual(state[:2], ('2021-01-04', 'extended'))
        self.assertIn('gtimg.cn', state[2])
        with patch.object(server, 'fetch_upstream', return_value=(200, '', b'bad')) as fetch:
            daily_archive.refresh(max_requests=1)
        self.assertIn('2020-01-01', fetch.call_args.args[0])

    def test_bad_payload_and_conflicting_overlap_preserve_history_and_back_off(self):
        bads = [b'<html>error</html>', payload([('2021-01-04', 90), ('2022-04-13', 200),
                *self.rows[1:]]).encode(), payload([('2021-01-04', 90)]).encode()]
        for body in bads:
            with storage.get_conn() as conn:
                conn.execute('DELETE FROM market_history_backfill')
            with patch.object(server, 'fetch_upstream', return_value=(200, '', body)):
                result = daily_archive.refresh()
            self.assertEqual(len(result['errors']), 1)
            self.assertEqual(result['inserted'], 0)
            with patch.object(server, 'fetch_upstream', side_effect=AssertionError('backoff ignored')):
                self.assertEqual(daily_archive.refresh()['checked'], 0)
        self.assertEqual(len(server.read_market_history_from_db('sina-cn', 'sh000001')), 3)

    def test_source_boundary_is_not_reported_as_complete_or_repeated_on_each_tick(self):
        with patch.object(server, 'fetch_upstream', return_value=(200, '', payload(self.rows).encode())):
            result = daily_archive.refresh()
        self.assertEqual(result['boundaries'], ['sina-cn:sh000001'])
        with patch.object(server, 'fetch_upstream', side_effect=AssertionError('boundary retry too soon')):
            self.assertEqual(daily_archive.refresh()['checked'], 0)

    def test_failed_window_retry_does_not_reuse_the_invalid_response_cache(self):
        with patch.object(server, 'fetch_upstream', return_value=(200, '', b'<html>Error</html>')):
            daily_archive.refresh(max_requests=1)
        text = payload([('2021-01-04', 90), *self.rows]).encode()
        with patch.object(server, 'fetch_upstream', return_value=(200, '', text)) as fetch:
            result = daily_archive.refresh(max_requests=1, retry_failed=True)
        self.assertTrue(fetch.call_args.kwargs['force_refresh'])
        self.assertEqual(result['inserted'], 1)
        self.assertEqual(result['errors'], [])

    def test_fred_price_conflict_is_held_for_review_and_provider_cache_keys_are_isolated(self):
        with patch.object(daily_archive, 'configured_market_return_items', return_value=['nikkei-index:N225']):
            with storage.get_conn() as conn:
                conn.executemany('INSERT INTO market_history VALUES (?,?,?,?,?)',
                    [('nikkei-index', 'N225', day, value, 1) for day,value in self.rows])
            text = 'observation_date,NIKKEI225\n2022-04-13,200\n2022-04-14,201\n2022-04-15,202\n'
            with patch.object(server, 'fetch_upstream', return_value=(200, '', text.encode())) as fetch:
                daily_archive.refresh()
            self.assertTrue(fetch.call_args.kwargs['use_requests'])
            self.assertIn('NIKKEI225', fetch.call_args.args[0])
            key = fetch.call_args.kwargs['cache_key']
            self.assertNotEqual(key, 'daily-archive:nikkei-index:N225:2021-01-01:2022-12-31')
            with storage.get_conn() as conn:
                state = conn.execute("SELECT status,next_check_at-checked_at FROM market_history_backfill WHERE source='nikkei-index'").fetchone()
            self.assertEqual(state, ('review', 30 * 86400 * 1000))

    def test_request_budget_and_priority_prefer_targets_without_five_year_baselines(self):
        with storage.get_conn() as conn:
            for symbol, first in [('sh000300','2020-01-02'), ('sz399006','2023-01-03')]:
                conn.execute('INSERT INTO market_history VALUES (?,?,?,?,?)', ('sina-cn',symbol,first,100,1))
        with patch.object(daily_archive, 'configured_market_return_items', return_value=[
            'sina-cn:sh000300','sina-cn:sz399006','sina-cn:sh000001']), \
             patch.object(server, 'fetch_upstream', return_value=(503, '', b'')) as fetch:
            result = daily_archive.refresh(max_requests=2)
        self.assertEqual(result['checked'], 2)
        self.assertEqual(fetch.call_count, 2)
        self.assertTrue(all('sh000300' not in call.args[0] for call in fetch.call_args_list))

    def test_empty_out_of_range_duplicate_nonfinite_and_adjusted_etf_data_are_rejected(self):
        for rows in [[], [('2020-12-31', 1)], [('2021-01-04', float('nan'))],
                     [('2021-01-04', -1)], [('2021-01-04', 1)] * 2]:
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                daily_archive.parse_archive('sina-cn', 'sh000001', payload(rows), '2021-01-01', '2022-12-31')
        with self.assertRaises(ValueError):
            daily_archive.parse_archive('sina-cn', 'sh510300', payload(self.rows, 'sh510300', 'qfqday'),
                                        '2021-01-01', '2022-12-31')

    def test_official_taiwan_korea_and_fred_parsers(self):
        tw = json.dumps({'stat': 'OK', 'data': [['2021/07/30', '1', '1', '1', '17,247.41']]})
        self.assertEqual(daily_archive.parse_archive('twse-official', 'TWII', tw, '2021-07-01', '2021-07-31'),
                         [('2021-07-30', 17247.41)])
        kr = "[['\u65e5\u671f','\u5f00\u76d8','\u6700\u9ad8','\u6700\u4f4e','\u6536\u76d8','\u6210\u4ea4\u91cf'],['20150102',1900,1920,1890,1910,100]]"
        self.assertEqual(daily_archive.parse_archive('naver-korea', 'KOSPI', kr, '2015-01-01', '2016-12-31'),
                         [('2015-01-02', 1910)])
        url, _, start, end = daily_archive.archive_request('sina-us', '.IXIC', '2004-01-02')
        self.assertIn('id=NASDAQCOM', url)
        self.assertEqual((start, end), ('2003-01-01', '2004-12-31'))
        text = 'observation_date,NIKKEI225\n2023-01-02,\n2023-01-03,.\n2023-01-04,25716.86\n'
        self.assertEqual(daily_archive.parse_archive('nikkei-index', 'N225', text, '2022-01-01', '2023-12-31'),
                         [('2023-01-04', 25716.86)])
        with self.assertRaises(ValueError):
            daily_archive.parse_archive('nikkei-index', 'N225', text.replace('NIKKEI225', 'SP500'),
                                        '2022-01-01', '2023-12-31')
        with self.assertRaises(ValueError):
            daily_archive.archive_request('sina-us', 'EEM', '2010-01-04')

    def test_only_configured_targets_and_no_page_request_backfills(self):
        with patch.object(server, 'fetch_upstream', side_effect=AssertionError('unexpected request')):
            self.assertEqual(daily_archive.refresh(items=['sina-cn:sh999999'])['checked'], 0)
            self.assertEqual(daily_archive.refresh(max_requests=0)['checked'], 0)
            client = server.app.test_client()
            self.assertEqual(client.get('/api/marketreturns?items=sina-cn:sh000001').status_code, 200)
            self.assertEqual(client.get('/api/markethistory?source=sina-cn&symbol=sh000001').status_code, 200)


class FiveYearReturnsTests(unittest.TestCase):
    setUp = DailyArchiveTests.setUp

    def daily_rows(self):
        day = date(2021, 9, 17)
        rows = []
        while day <= date(2026, 9, 18):
            if day.weekday() < 5:
                rows.append((day.isoformat(), 100 + len(rows) * .01))
            day += timedelta(days=1)
        return rows

    def test_five_year_market_and_fund_returns_use_same_calendar_window(self):
        rows = self.daily_rows()
        with storage.get_conn() as conn:
            conn.execute('DELETE FROM market_history')
            conn.executemany('INSERT INTO market_history VALUES (?,?,?,?,?)',
                            [('sina-cn', 'sh000001', day, value, 1) for day, value in rows])
            conn.executemany('INSERT INTO fund_nav_history VALUES (?,?,?,?,?)',
                            [('017436', day, value, None, 1) for day, value in rows])
        market = server.read_market_return_summary_from_db('sina-cn', 'sh000001')['ranges']['5y']
        fund = server.read_fund_return_summary_from_db('017436')['ranges']['5y']
        self.assertEqual(market['startDate'], '2021-09-17')
        self.assertEqual(market['returnPercent'], fund['returnPercent'])
        self.assertEqual(market['maxDrawdownPercent'], 0)
        self.assertEqual(history_cutoff(date(2024, 2, 29), 365 * 5), date(2019, 2, 28))

    def test_short_history_and_large_internal_gaps_do_not_masquerade_as_five_years(self):
        self.assertNotIn('5y', server.read_market_return_summary_from_db('sina-cn', 'sh000001')['ranges'])
        rows = self.daily_rows()
        self.assertTrue(daily_range_covered(rows, rows[0][0], '2021-09-18'))
        broken = [point for point in rows if not point[0].startswith('2023-05')]
        self.assertFalse(daily_range_covered(broken, rows[0][0], '2021-09-18'))
        with storage.get_conn() as conn:
            conn.execute('DELETE FROM market_history')
            conn.executemany('INSERT INTO market_history VALUES (?,?,?,?,?)',
                            [('sina-cn', 'sh000001', day, value, 1) for day, value in broken])
        self.assertNotIn('5y', server.read_market_return_summary_from_db('sina-cn', 'sh000001')['ranges'])
