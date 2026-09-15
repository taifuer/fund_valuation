import json
import unittest
from datetime import datetime
from unittest.mock import patch

from backend.long_history_sources import extend_archives, parse_fred, parse_yahoo, verified_extension


def point(period, close=100):
    return {'period': period, 'date': period, 'close': close, 'source': 'test', 'sourceUrl': 'https://example.com'}


class MonthlyArchiveTests(unittest.TestCase):
    def test_fred_monthly_labels_are_month_precision_not_first_day_trades(self):
        text = 'observation_date,NASDAQCOM\n1971-03-01,105.970\n1971-04-01,.\n1971-05-01,NaN\n'
        rows = parse_fred(text, 'NASDAQCOM', 'https://fred.stlouisfed.org/')
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['date'], '1971-03')
        self.assertTrue(rows[0]['monthComplete'])
        daily = parse_fred('observation_date,NASDAQCOM\n1971-02-26,101.34\n', 'NASDAQCOM', 'url', monthly=False)
        self.assertEqual(daily[0]['date'], '1971-02-26')
        self.assertNotIn('monthComplete', daily[0])

    def test_fred_rejects_html_and_wrong_series(self):
        for text in ['<html>Access denied</html>', 'observation_date,SP500\n2026-01-01,100\n']:
            with self.assertRaises(ValueError):
                parse_fred(text, 'NASDAQCOM', 'url')

    def test_yahoo_uses_close_not_adjusted_close_and_market_local_month(self):
        payload = {'chart': {'result': [{'meta': {'symbol': '^HSI', 'dataGranularity': '1mo', 'exchangeTimezoneName': 'Asia/Hong_Kong'},
            'timestamp': [1767196800], 'indicators': {'quote': [{'close': [100]}], 'adjclose': [{'adjclose': [120]}]}}], 'error': None}}
        rows = parse_yahoo(json.dumps(payload), '^HSI', 'url')
        self.assertEqual(rows[0]['close'], 100)
        self.assertEqual(rows[0]['period'], '2026-01')
        with self.assertRaises(ValueError):
            parse_yahoo(json.dumps(payload), '^DJI', 'url')

    def test_archive_extension_requires_overlap_and_never_replaces_existing_months(self):
        old = [point(f'2025-{month:02d}') for month in range(1, 13)]
        new = [point('2024-12'), *old]
        self.assertEqual([row['period'] for row in verified_extension(old, new)], ['2024-12'])
        with self.assertRaisesRegex(ValueError, '12 overlapping'):
            verified_extension(old, new[:5])
        bad = [*new[:-1], point('2025-12', 120)]
        with self.assertRaisesRegex(ValueError, 'conflict'):
            verified_extension(old, bad)

    def test_extension_keeps_valid_archive_when_optional_first_month_fails_and_excludes_current_month(self):
        old = [point(f'2025-{month:02d}') for month in range(1, 13)]
        csv = 'observation_date,NASDAQCOM\n2024-12-01,90\n' + ''.join(
            f"{row['period']}-01,100\n" for row in old) + '2026-09-01,200\n'
        with patch('backend.long_history_sources.FRED_SERIES', {'IXIC': 'NASDAQCOM'}), \
                patch('backend.long_history_sources.YAHOO_SERIES', {}), \
                patch('backend.long_history_sources.read_points', return_value=old), \
                patch('backend.long_history_sources.save_points') as save, \
                patch('backend.long_history_sources.publish'), \
                patch('backend.long_history_sources.time.sleep'), \
                patch('backend.server.fetch_upstream', side_effect=[(200, 'text/csv', csv.encode()), TimeoutError('timeout')]):
            result = extend_archives(datetime.fromisoformat('2026-09-15T22:00:00+08:00'))
        self.assertEqual(result['archives'][-1], {'asset': 'IXIC', 'source': 'fred', 'added': 1})
        self.assertIn('warning', result['archives'][0])
        self.assertEqual([row['period'] for row in save.call_args.args[1]], ['2024-12'])
