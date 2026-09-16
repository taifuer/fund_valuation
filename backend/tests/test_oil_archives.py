import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

from backend import server, storage
from backend.long_history import read_points, save_points
from backend.oil_archives import EIA_SERIES, oil_extension, parse_eia_oil, sync_oil


def table(rows, summary=EIA_SERIES):
    return '<table summary="' + summary + '">' + ''.join('<tr>' + ''.join('<td>' + c + '</td>' for c in row) + '</tr>' for row in [
        ['Week Of', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'], *rows,
    ]) + '</table>'


class OilArchiveTests(unittest.TestCase):
    def test_official_weekly_grid_is_daily_not_weekly_averages(self):
        rows = parse_eia_oil(table([
            ['1983 Apr- 4 to Apr- 8', '29.44', '29.71', '', '30.17', '30.38'],
            ['1984 Dec-31 to Jan- 4', '1', 'NA', '2', '3', '4'],
            ['', '', '', '', '', ''],
        ]))
        self.assertEqual(rows[0]['date'], '1983-04-04')
        self.assertEqual(rows[0]['close'], 29.44)
        self.assertEqual(rows[-1]['date'], '1985-01-04')
        self.assertEqual(len(rows), 8)

    def test_negative_oil_price_is_retained_and_bad_series_is_rejected(self):
        row = ['2020 Apr-20 to Apr-24', '-37.63', '10.01', '11', '12', '13']
        self.assertEqual(parse_eia_oil(table([row]))[0]['close'], -37.63)
        for text in [table([row], summary='WTI spot'), table([row, row]),
                     table([['2020 Apr-21 to Apr-25', '1', '2', '3', '4', '5']]),
                     table([[row[0], 'NaN', '2', '3', '4', '5']]), '<html>Access denied</html>']:
            with self.assertRaises(ValueError):
                parse_eia_oil(text)

    def test_overlap_conflict_never_extends_or_overwrites_existing_archive(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        path = Path(temp.name) / 'oil-test.db'
        self.assertTrue(path.is_relative_to(Path(tempfile.gettempdir())))
        with patch.object(storage, 'DB_PATH', path):
            storage.migrate_database(path)
            old = [{'date': f'2023-{month:02d}-28', 'period': f'2023-{month:02d}', 'close': 50,
                    'source': 'sina', 'sourceUrl': 'url', 'monthComplete': True} for month in range(1, 13)]
            save_points('CL', old, 1)
            daily = [{'date': '1983-04-04'}, {'date': '2024-04-05'}]
            candidate = [{**row, 'source': 'eia'} for row in old] + [{**old[-1], 'period': '2024-03', 'date': '2024-03-28'}]
            candidate[5] = {**candidate[5], 'close': 55}
            with patch('backend.oil_archives.daily_month_ends', return_value=candidate), \
                    patch('backend.oil_archives.missing_months', return_value=[]):
                with self.assertRaisesRegex(ValueError, 'Archive price conflict'):
                    oil_extension(old, daily, datetime.now().astimezone())
            with patch.object(server, 'fetch_upstream', return_value=(200, 'text/html', b'changed format')):
                result = sync_oil()
            self.assertTrue(result['oil']['retainedExisting'])
            self.assertEqual(read_points('CL'), old)

    def test_short_or_discontinued_partial_month_cannot_masquerade_as_full_archive(self):
        with self.assertRaisesRegex(ValueError, 'boundaries'):
            oil_extension([], [{'date': '1990-01-01'}], datetime.now().astimezone())
        with patch('backend.oil_archives.daily_month_ends', return_value=[{'period': '2024-04'}]):
            with self.assertRaisesRegex(ValueError, 'month-end'):
                oil_extension([], [{'date': '1983-04-04'}, {'date': '2024-04-05'}], datetime.now().astimezone())
