from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

from backend import storage
from backend.long_history import (
    annual_returns, assets, completed_cutoff, completed_months, daily_month_ends, fetch_rows, missing_months, parse_nikkei, parse_tencent,
    parse_twse, period_performance, range_performances, comparison_windows, monthly_drawdown,
    publish, read_points, refresh, save_points, stored_daily_points, valid_point,
)


def point(day: str, close: float = 100, source: str = "tencent") -> dict:
    return {"period": day[:7], "date": day, "close": close, "source": source, "sourceUrl": "https://example.com/history"}


class MonthlyDrawdownTests(unittest.TestCase):
    def test_tracks_a_prior_peak_not_the_endpoints_or_yearly_loss(self):
        rows = [point('2025-12', 100), point('2026-01', 120), point('2026-02', 90), point('2026-03', 150)]
        result = period_performance(rows, '2025-12', '2026-03')
        self.assertEqual(result['change'], 50)
        self.assertEqual(result['monthlyDrawdown'], -25)
        self.assertEqual(result['monthlyDrawdownReason'], '')
        # A later peak cannot be paired with an earlier trough.
        self.assertEqual(monthly_drawdown(rows[:2], '2025-12', '2026-01')['monthlyDrawdown'], 0)
        self.assertAlmostEqual(monthly_drawdown(rows, '2026-01', '2026-02')['monthlyDrawdown'], -25)
        self.assertEqual(monthly_drawdown(list(reversed(rows)), '2025-12', '2026-03')['monthlyDrawdown'], -25)

    def test_zero_drawdown_is_only_for_a_complete_flat_or_rising_series(self):
        for values in [[100, 100, 100], [100, 110, 120]]:
            rows = [point(f'2026-0{i + 1}', value) for i, value in enumerate(values)]
            self.assertEqual(monthly_drawdown(rows, '2026-01', '2026-03')['monthlyDrawdown'], 0)
        rows = [point('2026-01', 100), point('2026-02', 90), point('2026-03', 80)]
        self.assertAlmostEqual(monthly_drawdown(rows, '2026-01', '2026-03')['monthlyDrawdown'], -20)

    def test_missing_months_do_not_remove_independently_valid_endpoint_returns(self):
        result = period_performance([point('2025-12', 100), point('2026-03', 150)], '2025-12', '2026-03')
        self.assertEqual(result['change'], 50)
        self.assertIsNone(result['monthlyDrawdown'])
        self.assertIn('缺月', result['monthlyDrawdownReason'])
        for rows, start, end in [([], None, None), ([point('2026-01')], '2026-01', '2026-01'),
                                  ([point('2026-02')], '2026-01', '2026-02'),
                                  ([point('2026-01')], '2026-01', '2026-02')]:
            result = monthly_drawdown(rows, start, end)
            self.assertIsNone(result['monthlyDrawdown'])
            self.assertTrue(result['monthlyDrawdownReason'])

    def test_bad_prices_are_not_silently_skipped_or_serialized_as_nan(self):
        for value in [0, -37.63, float('nan'), float('inf'), True]:
            result = monthly_drawdown([point('2026-01'), point('2026-02', value), point('2026-03')], '2026-01', '2026-03')
            self.assertIsNone(result['monthlyDrawdown'])
            self.assertIn('异常价格', result['monthlyDrawdownReason'])
            json.dumps(result, allow_nan=False)

    def test_annual_drawdown_resets_to_previous_december_not_an_older_peak(self):
        rows = [point('2024-11', 500), point('2024-12', 100)]
        rows += [point(f'2025-{month:02}', 80 if month == 1 else 120) for month in range(1, 13)]
        annual = annual_returns(rows, 2025)[0]
        self.assertAlmostEqual(annual['monthlyDrawdown'], -20)
        self.assertAlmostEqual(annual['return'], 20)
        self.assertAlmostEqual(period_performance(rows, '2024-11', '2025-12')['monthlyDrawdown'], -84)

    def test_partial_first_year_and_current_year_only_use_the_available_completed_months(self):
        rows = [point('2026-06', 100), point('2026-07', 80), point('2026-08', 110)]
        result = annual_returns(rows, 2026)[0]
        self.assertTrue(result['partialYear'])
        self.assertTrue(result['yearToDate'])
        self.assertAlmostEqual(result['monthlyDrawdown'], -20)
        self.assertEqual(result['endDate'], '2026-08')
        partial = annual_returns([point('2025-11', 100), point('2025-12', 90)], 2025)[0]
        self.assertAlmostEqual(partial['monthlyDrawdown'], -10)

    def test_bad_annual_boundaries_and_unfinished_market_year_do_not_get_a_drawdown(self):
        rows = [point('2024-12'), point('2025-01', 90), point('2025-02', 80)]
        result = annual_returns(rows, 2026)[1]
        self.assertIsNone(result['monthlyDrawdown'])
        self.assertEqual(result['monthlyDrawdownReason'], '年末数据不完整')
        result = annual_returns(rows, 2026, unfinished_year=2025)[1]
        self.assertEqual(result['monthlyDrawdownReason'], '该市场年度尚未结束')
        result = annual_returns([point('2024-12'), point('2025-12', 90)], 2025)[0]
        self.assertIsNotNone(result['return'])
        self.assertIsNone(result['monthlyDrawdown'])
        self.assertIn('缺月', result['monthlyDrawdownReason'])

    def test_range_and_comparison_do_not_inherit_peaks_outside_the_selected_window(self):
        rows = [point('2019-12', 1000)]
        rows += [point(f'{2020 + i // 12}-{i % 12 + 1:02}', 80 if i == 30 else 100) for i in range(72)]
        result = range_performances(rows)
        self.assertAlmostEqual(result['all']['monthlyDrawdown'], -92)
        self.assertAlmostEqual(result['5']['monthlyDrawdown'], -20)
        catalog = [{'id': 'A', 'group': 'usa', 'completedThrough': '2025-12'}]
        comparison = comparison_windows(catalog, {'A': rows}, 2026)['all']
        self.assertAlmostEqual(comparison['5']['rows'][0]['monthlyDrawdown'], -20)
        self.assertAlmostEqual(comparison['all']['rows'][0]['monthlyDrawdown'], -92)


class AnnualCalculationTests(unittest.TestCase):
    def test_annualized_change_compounds_over_elapsed_months_not_number_of_observations(self):
        rows = [point('2023-08', 100), point('2025-08', 121)]
        result = period_performance(rows, '2023-08', '2025-08')
        self.assertAlmostEqual(result['change'], 21)
        self.assertAlmostEqual(result['cagr'], 10)
        self.assertEqual(result['months'], 24)
        self.assertEqual((result['startClose'], result['endClose']), (100, 121))
        loss = period_performance([point('2023-08', 100), point('2025-08', 81)], '2023-08', '2025-08')
        self.assertAlmostEqual(loss['cagr'], -10)

    def test_annualized_change_handles_flat_partial_year_missing_boundaries_and_bad_prices(self):
        flat = period_performance([point('2024-08'), point('2025-08')], '2024-08', '2025-08')
        self.assertEqual(flat['cagr'], 0)
        short = period_performance([point('2025-12'), point('2026-08', 110)], '2025-12', '2026-08')
        self.assertAlmostEqual(short['change'], 10)
        self.assertIsNone(short['cagr'])
        self.assertIn('不足1年', short['cagrReason'])
        for rows in [[], [point('2025-01'), point('2025-12')], [point('2024-12', 0), point('2025-12')],
                     [point('2024-12'), point('2025-06', -1), point('2025-12')],
                     [point('2024-12'), point('2025-12', float('inf'))]]:
            result = period_performance(rows, '2024-12', '2025-12')
            self.assertIsNone(result['change'])
            self.assertIsNone(result['cagr'])
            self.assertTrue(result['reason'])
        self.assertIsNone(period_performance([point('2025-12')], '2025-12', '2025-12')['cagr'])

    def test_individual_summary_matches_the_actual_visible_range_and_shorter_history(self):
        rows = [point('2000-08', 50), point('2016-08', 100), point('2026-08', 200)]
        result = range_performances(rows)
        self.assertEqual(result['10']['startPeriod'], '2016-08')
        self.assertEqual(result['10']['change'], 100)
        self.assertEqual(result['all']['startPeriod'], '2000-08')
        self.assertEqual(result['all']['months'], 312)
        self.assertIsNone(range_performances([])['all']['cagr'])

    def test_comparison_uses_five_ten_and_twenty_complete_calendar_years_not_a_single_year(self):
        series = {'OLD': [point('2015-12', 50), point('2020-12', 100), point('2021-01', 110),
                          point('2022-12', 140), point('2025-12', 160), point('2026-08', 200)],
                  'NEW': [point('2022-12', 100), point('2025-12', 120)], 'EMPTY': []}
        catalog = [{'id': key, 'group': 'usa', 'completedThrough': '2026-08'}
                   for key, rows in series.items()]
        ranges = comparison_windows(catalog, series, 2026)['all']
        result = ranges['5']
        self.assertEqual((result['startPeriod'], result['endPeriod']), ('2021-01', '2025-12'))
        self.assertEqual(result['rows'][0]['startPeriod'], '2020-12')
        self.assertEqual(result['rows'][0]['months'], 60)
        self.assertEqual((result['rows'][0]['startClose'], result['rows'][0]['endClose']), (100, 160))
        self.assertAlmostEqual(result['rows'][0]['change'], 60)
        self.assertAlmostEqual(result['rows'][0]['cagr'], (1.6 ** (1 / 5) - 1) * 100)
        self.assertIsNone(result['rows'][1]['change'])
        self.assertEqual((result['rows'][1]['startClose'], result['rows'][1]['endClose']), (None, 120))
        self.assertIsNone(result['rows'][2]['change'])
        self.assertEqual((ranges['10']['startPeriod'], ranges['10']['endPeriod']), ('2016-01', '2025-12'))
        self.assertAlmostEqual(ranges['10']['rows'][0]['change'], 220)
        self.assertEqual(ranges['10']['rows'][0]['months'], 120)
        self.assertEqual(ranges['20']['startPeriod'], '2006-01')
        self.assertIsNone(ranges['20']['rows'][0]['change'])
        self.assertEqual(ranges['30']['startPeriod'], '1996-01')
        self.assertTrue(ranges['all']['independentPeriods'])
        self.assertEqual(ranges['all']['rows'][0]['months'], 128)
        self.assertAlmostEqual(ranges['all']['rows'][0]['change'], 300)
        self.assertAlmostEqual(ranges['all']['rows'][1]['change'], 20)

    def test_five_year_chart_range_still_uses_sixty_elapsed_months(self):
        rows = [point(f'{2021 + (7 + i) // 12}-{(7 + i) % 12 + 1:02}', 100 + i) for i in range(61)]
        summary = range_performances([point('2021-07', 50), *rows])['5']
        self.assertEqual((summary['startPeriod'], summary['endPeriod'], summary['months']), ('2021-08', '2026-08', 60))
        self.assertAlmostEqual(summary['change'], 60)
        self.assertAlmostEqual(summary['cagr'], (1.6 ** (1 / 5) - 1) * 100)

    def test_calendar_range_does_not_follow_stale_archives_or_include_unfinished_current_year(self):
        series = {'A': [point('2020-12'), point('2025-12', 120), point('2026-08', 160)],
                  'B': [point('2020-12'), point('2025-08', 90)]}
        catalog = [{'id': key, 'group': 'usa', 'completedThrough': '2026-08'}
                   for key, rows in series.items()]
        result = comparison_windows(catalog, series, 2026)['all']['5']
        self.assertEqual((result['startPeriod'], result['endPeriod']), ('2021-01', '2025-12'))
        self.assertAlmostEqual(result['rows'][0]['change'], 20)
        self.assertIsNone(result['rows'][1]['change'])
        self.assertEqual(result['rows'][1]['reason'], '缺少区间起止月数据')
        catalog[1]['completedThrough'] = '2025-11'
        result = comparison_windows(catalog, series, 2026)['all']['5']
        self.assertEqual((result['startPeriod'], result['endPeriod']), ('2020-01', '2024-12'))

    def test_comparison_excludes_unfinished_years_and_handles_missing_december_and_invalid_prices(self):
        self.assertEqual(comparison_windows([], {}, 2026)['all']['5']['rows'], [])
        cases = [([point('2020-12'), point('2025-11', 120)], '缺少区间起止月数据'),
                 ([point('2020-12'), point('2025-06', -1), point('2025-12', 120)], '非正或异常价格'),
                 ([point('2020-12', 0), point('2025-12', 120)], '非正或异常价格')]
        for rows, reason in cases:
            with self.subTest(reason=reason):
                catalog = [{'id': 'A', 'group': 'usa', 'completedThrough': '2025-12'}]
                result = comparison_windows(catalog, {'A': rows}, 2026)['all']['5']
                self.assertIsNone(result['rows'][0]['change'])
                self.assertIn(reason, result['rows'][0]['reason'])
                catalog[0]['completedThrough'] = '2025-11'
                self.assertEqual(comparison_windows(catalog, {'A': rows}, 2026)['all']['5']['endPeriod'], '2024-12')

    def test_all_uses_individual_first_and_last_months_without_shortening_other_histories(self):
        series = {'A': [point('2015-12'), point('2020-07'), point('2020-12'), point('2025-12', 150)],
                  'B': [point('2020-07'), point('2020-12'), point('2025-12', 90)]}
        catalog = [{'id': 'A', 'group': 'usa', 'completedThrough': '2026-08'},
                   {'id': 'B', 'group': 'asia', 'completedThrough': '2026-08'}]
        result = comparison_windows(catalog, series, 2026)
        self.assertIsNone(result['all']['all']['startPeriod'])
        self.assertEqual(result['all']['all']['rows'][0]['startPeriod'], '2015-12')
        self.assertEqual(result['all']['all']['rows'][1]['startPeriod'], '2020-07')
        self.assertEqual((result['all']['all']['rows'][0]['startClose'], result['all']['all']['rows'][0]['endClose']), (100, 150))
        self.assertEqual((result['all']['all']['rows'][1]['startClose'], result['all']['all']['rows'][1]['endClose']), (100, 90))
        series['B'] = [point('2025-12')]
        result = comparison_windows(catalog, series, 2026)['all']['all']
        self.assertIsNone(result['startPeriod'])
        self.assertEqual(result['rows'][0]['change'], 50)
        self.assertIsNone(result['rows'][1]['change'])

    def test_period_values_preserve_available_endpoints_without_inference(self):
        missing_start = period_performance([point('2021-01', 999), point('2025-12', 123.456789)], '2020-12', '2025-12')
        self.assertIsNone(missing_start['startClose'])
        self.assertEqual(missing_start['endClose'], 123.456789)
        self.assertIsNone(missing_start['change'])
        missing_end = period_performance([point('2020-12', 100), point('2025-11', 120)], '2020-12', '2025-12')
        self.assertEqual(missing_end['startClose'], 100)
        self.assertIsNone(missing_end['endClose'])
        for value in [0, -37.63]:
            result = period_performance([point('2020-12', value), point('2025-12', 100)], '2020-12', '2025-12')
            self.assertEqual(result['startClose'], value)
            self.assertEqual(result['endClose'], 100)
            self.assertIsNone(result['change'])
        invalid = period_performance([point('2020-12', float('inf')), point('2025-12', float('nan'))], '2020-12', '2025-12')
        self.assertIsNone(invalid['startClose'])
        self.assertIsNone(invalid['endClose'])
        json.dumps(invalid, allow_nan=False)

    def test_thirty_year_comparison_uses_360_months_and_not_a_shortened_lifetime(self):
        series = {'A': [point('1995-12'), point('2025-12', 200)],
                  'B': [point('2000-01'), point('2025-12', 200)]}
        catalog = [{'id': key, 'group': 'usa', 'completedThrough': '2026-08'} for key in series]
        result = comparison_windows(catalog, series, 2026)['usa']['30']
        self.assertEqual((result['startPeriod'], result['endPeriod']), ('1996-01', '2025-12'))
        self.assertEqual(result['rows'][0]['months'], 360)
        self.assertAlmostEqual(result['rows'][0]['cagr'], (2 ** (1 / 30) - 1) * 100)
        self.assertIsNone(result['rows'][1]['change'])
        self.assertEqual(range_performances(series['A'])['30']['months'], 360)

    def test_first_partial_year_uses_first_record_without_pretending_it_is_previous_december(self):
        rows = [point('2010-07-31', 10), point('2010-12-31', 15), point('2011-12-30', 18)]
        result = annual_returns(rows, 2011)
        self.assertAlmostEqual(result[-1]['return'], 50)
        self.assertEqual(result[-1]['startDate'], '2010-07-31')
        self.assertTrue(result[-1]['partialYear'])
        self.assertFalse(result[0]['partialYear'])
        self.assertAlmostEqual(result[0]['return'], 20)

    def test_first_year_needs_two_valid_boundaries_and_still_checks_complete_year_end(self):
        for rows in [[point('2010-12-31')], [point('2010-07-31', 0), point('2010-12-31')],
                     [point('2010-07-31'), point('2010-11-30')],
                     [point('2010-07-31'), point('2010-12-02')]]:
            result = annual_returns(rows, 2011)[-1]
            self.assertTrue(result['partialYear'])
            self.assertIsNone(result['return'])
            self.assertTrue(result['reason'])
        current = annual_returns([point('2026-07-31'), point('2026-08-31', 90)], 2026)[0]
        self.assertTrue(current['yearToDate'])
        self.assertTrue(current['partialYear'])
        self.assertAlmostEqual(current['return'], -10)

    def test_monthly_view_stops_at_august_even_when_september_has_live_and_daily_prices(self):
        asset = next(item for item in assets() if item['id'] == 'INX')
        now = datetime.fromisoformat('2026-09-15T22:00:00+08:00')
        points = [point('2025-12-31', 100), point('2026-08-31', 110),
                  dict(point('2026-09-15', 200), monthComplete=True)]
        closed = completed_months(points, asset, now)
        self.assertEqual([row['period'] for row in closed], ['2025-12', '2026-08'])
        result = annual_returns(closed, 2026)
        self.assertAlmostEqual(result[0]['return'], 10)
        self.assertEqual(result[0]['endDate'], '2026-08-31')

    def test_daily_price_in_middle_of_a_past_month_is_not_a_month_end(self):
        asset = next(item for item in assets() if item['id'] == 'INX')
        now = datetime.fromisoformat('2026-09-15T22:00:00+08:00')
        self.assertEqual(completed_months([point('2026-08-20')], asset, now), [])
        verified_holiday = dict(point('2026-08-28'), monthComplete=True)
        self.assertEqual(len(completed_months([verified_holiday], asset, now)), 1)

    def test_daily_archive_accepts_holiday_month_end_with_later_observations_but_not_stale_tail(self):
        asset = next(item for item in assets() if item['id'] == 'GC')
        now = datetime.fromisoformat('2026-09-15T22:00:00+08:00')
        rows = [point('2024-03-28'), point('2024-04-01'), point('2026-08-20'), point('2026-09-15')]
        result = daily_month_ends(rows, asset, now)
        self.assertEqual([row['period'] for row in result], ['2024-03'])
        self.assertTrue(result[0]['monthComplete'])
        self.assertEqual(daily_month_ends([point('2026-08-28')], asset, now), [])

    def test_crypto_requires_calendar_month_end_even_with_later_observations(self):
        asset = next(item for item in assets() if item['id'] == 'BTC')
        now = datetime.fromisoformat('2026-09-15T22:00:00+08:00')
        self.assertEqual(daily_month_ends([point('2026-08-30'), point('2026-09-01')], asset, now), [])

    def test_known_bad_early_sse_series_is_quarantined_even_with_complete_month_flag(self):
        asset = next(item for item in assets() if item['id'] == 'SH000001')
        rows = [dict(point('1991-12-31', 134.3), monthComplete=True), point('1993-01-29', 1198.48)]
        result = completed_months(rows, asset, datetime.fromisoformat('2026-09-15T22:00:00+08:00'))
        self.assertEqual([row['period'] for row in result], ['1993-01'])

    def test_monthly_coverage_reports_internal_and_trailing_gaps_without_interpolation(self):
        points = [point('2026-01-30'), point('2026-03-31')]
        self.assertEqual(missing_months(points, '2026-04-30'), ['2026-02', '2026-04'])

    def test_uses_previous_year_close_and_not_first_trading_day(self):
        rows = [point("2024-12-31", 100), point("2025-01-02", 110), point("2025-12-31", 121)]
        annual = annual_returns(rows, 2025)
        self.assertAlmostEqual(annual[0]["return"], 21)
        self.assertEqual(annual[0]["startDate"], "2024-12-31")
        self.assertIsNone(annual[1]["return"])

    def test_year_to_date_does_not_relabel_old_data_as_current_year(self):
        result = annual_returns([point("2023-12-29"), point("2024-12-31", 110)], 2026)
        self.assertIsNone(result[0]["return"])
        self.assertIsNone(result[1]["return"])
        self.assertAlmostEqual(result[2]["return"], 10)
        self.assertEqual(result[2]["year"], 2024)

    def test_missing_december_or_stale_december_is_not_a_full_year(self):
        for last in ["2025-11-28", "2025-12-02", "2025-12-26", "2025-12-30"]:
            result = annual_returns([point("2024-12-31"), point(last, 120)], 2026)
            self.assertIsNone(result[1]["return"])
        stale_anchor = annual_returns([point("2024-12-04"), point("2025-12-31")], 2025)
        self.assertIsNone(stale_anchor[0]["return"])

    def test_year_end_weekends_japan_korea_and_crypto_have_distinct_boundaries(self):
        cases = [('INX', '2022-12-30', '2023-12-29'), ('N225', '2022-12-30', '2023-12-29'),
                 ('KOSPI', '2022-12-29', '2023-12-28'), ('BTC', '2022-12-31', '2023-12-31')]
        for asset_id, start, end in cases:
            with self.subTest(asset=asset_id):
                result = annual_returns([point(start), point(end, 120)], 2024, asset_id=asset_id)
                self.assertAlmostEqual(result[1]['return'], 20)
        result = annual_returns([point('2022-12-31'), point('2023-12-29', 120)], 2024, asset_id='BTC')
        self.assertIsNone(result[1]['return'])

    def test_keeps_year_end_return_when_only_an_interior_month_is_missing(self):
        result = annual_returns([point("2024-12-31"), point("2025-12-31", 75)], 2025)
        self.assertEqual(result[0]["return"], -25)

    def test_official_month_end_remains_valid_when_new_year_holiday_starts_early(self):
        rows = [dict(point('2017-12-29'), monthComplete=True), dict(point('2018-12-28', 75), monthComplete=True)]
        result = annual_returns(rows, 2019)
        self.assertEqual(result[1]['return'], -25)

    def test_month_precision_is_not_a_fabricated_trading_date(self):
        result = annual_returns([point("2024-12"), point("2025-12", 125)], 2026)
        self.assertEqual(result[1]["return"], 25)
        self.assertEqual(result[1]["startDate"], "2024-12")

    def test_negative_prices_zero_anchors_and_empty_history_are_not_zero_returns(self):
        self.assertEqual(annual_returns([], 2026), [])
        for initial in [0, -1]:
            result = annual_returns([point("2024-12-31", initial), point("2025-12-31", 100)], 2025)
            self.assertIsNone(result[0]["return"])
        result = annual_returns([point("2024-12-31"), point("2025-05-30", -2), point("2025-12-31")], 2025)
        self.assertIsNone(result[0]["return"])

    def test_parsers_reject_html_invalid_dates_and_nonfinite_values(self):
        with self.assertRaises(ValueError):
            parse_tencent('<html>challenge</html>', 'us.INX', 'url')
        with self.assertRaises(ValueError):
            parse_tencent('{"code":0,"data":{}}', 'us.INX', 'url')
        for day, value in [('2026-02-30', 10), ('2026-01-01', 'NaN'), ('2026-01-01', 'inf')]:
            self.assertIsNone(valid_point(day, value, source='test', url='url'))
        payload = {"code": 0, "data": {"us.INX": {"month": [["1950-01-31", "16", "17.05"]]}}}
        self.assertEqual(parse_tencent(json.dumps(payload), 'us.INX', 'url')[0]['close'], 17.05)

    def test_nikkei_month_label_and_unfinished_month_are_handled_explicitly(self):
        body = 'date,close,open\n2026/08/01,64000,63000\n2026/09/01,65000,64000\n'.encode('cp932')
        rows = parse_nikkei(body, 'url', datetime(2026, 9, 15, tzinfo=ZoneInfo('Asia/Tokyo')))
        self.assertEqual([(row['date'], row['close']) for row in rows], [('2026-08', 64000)])

    def test_twse_parses_original_closing_column_and_thousand_separators(self):
        text = json.dumps({'stat': 'OK', 'data': [['1999/01/05', '6310.41', '6310.41', '6111.64', '6,152.43']]})
        self.assertEqual(parse_twse(text, 'url')[0]['close'], 6152.43)


class LongHistoryStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'test.db'
        self.assertTrue(self.path.is_relative_to(Path(tempfile.gettempdir())))
        patcher = patch.object(storage, 'DB_PATH', self.path)
        patcher.start()
        self.addCleanup(patcher.stop)
        storage.migrate_database(self.path)

    def test_storage_is_idempotent_and_preserves_longer_history_on_short_responses(self):
        rows = [point('1950-12-29', 20), point('2025-12-31', 6000)]
        save_points('INX', rows, 1)
        save_points('INX', rows[-1:], 2)
        self.assertEqual(len(read_points('INX')), 2)
        save_points('INX', [point('2025-12-01', 5000)], 3)
        self.assertEqual(read_points('INX')[-1]['close'], 6000)

    def test_verified_source_replaces_only_quarantined_early_sse_rows(self):
        save_points('SH000001', [point('1991-12-31', 134.30)], 1)
        replacement = dict(point('1991-12-31', 292.75, 'eastmoney'), monthComplete=True)
        save_points('SH000001', [replacement], 2)
        self.assertEqual(read_points('SH000001')[0]['close'], 292.75)
        with self.assertRaisesRegex(ValueError, 'Conflicting'):
            save_points('SH000001', [point('1991-12-31', 134.30)], 3)
        save_points('SH000001', [point('1993-12-31', 833.8)], 4)
        with self.assertRaisesRegex(ValueError, 'Conflicting'):
            save_points('SH000001', [point('1993-12-31', 100, 'eastmoney')], 5)

    def test_verified_month_completion_survives_daily_snapshot_republication(self):
        verified = dict(point('2018-12-28', 100), monthComplete=True)
        save_points('SH000001', [verified], 1)
        save_points('SH000001', [point('2018-12-28', 100, 'sina')], 2)
        self.assertTrue(read_points('SH000001')[0]['monthComplete'])

    def test_month_label_confirms_matching_early_holiday_close_without_losing_exact_date(self):
        save_points('KOSPI', [point('2020-04-29', 1947.56, 'naver')], 1)
        save_points('KOSPI', [dict(point('2020-04', 1947.56, 'naver'), monthComplete=True)], 2)
        result = read_points('KOSPI')[0]
        self.assertEqual(result['date'], '2020-04-29')
        self.assertTrue(result['monthComplete'])

    def test_cached_unfinished_month_is_not_confirmed_just_because_calendar_advanced(self):
        asset = next(item for item in assets() if item['id'] == 'INX')
        body = json.dumps({'code': 0, 'data': {'us.INX': {'month': [['2025-12-30', 100, 110]]}}}).encode()
        observed = datetime.fromisoformat('2025-12-31T10:00:00-05:00')
        with storage.get_conn() as conn:
            conn.execute("INSERT INTO response_cache VALUES(?,?,?,?,?,?)", ('longhistory:INX:', 'url', 200, 'text/plain', body, int(observed.timestamp() * 1000)))
        with patch('backend.server.fetch_upstream', return_value=(200, 'text/plain', body)), \
                patch('backend.long_history.completed_cutoff', return_value='2025-12-31'):
            rows = fetch_rows(asset, datetime.fromisoformat('2026-01-01T00:30:00-05:00'))
            self.assertEqual(rows, [])
            with self.assertRaisesRegex(ValueError, 'archived history retained'):
                fetch_rows(asset, datetime.fromisoformat('2026-01-02T00:30:00-05:00'))

    def test_mismatched_source_cannot_partially_overwrite_valid_series(self):
        save_points('INX', [point('2025-12-31', 100)], 1)
        with self.assertRaisesRegex(ValueError, 'Conflicting'):
            save_points('INX', [point('1950-12-29'), point('2025-12-31', 400, 'other')], 2)
        self.assertEqual(len(read_points('INX')), 1)
        self.assertEqual(read_points('INX')[0]['close'], 100)

    def test_snapshot_reads_never_fetch_missing_histories_and_use_etag(self):
        from backend import server
        client = server.app.test_client()
        with patch.object(server, 'fetch_upstream', side_effect=AssertionError('Request must be read-only')):
            response = client.get('/api/longhistory')
            self.assertEqual(response.status_code, 202)
            self.assertEqual(client.get('/api/longhistory?symbol=../../foo').status_code, 400)
            save_points('INX', [point('2024-12-31'), point('2025-12-31', 120)], 1)
            publish(datetime(2026, 1, 5, tzinfo=ZoneInfo('Asia/Shanghai')))
            catalog = client.get('/api/longhistory')
            self.assertEqual(catalog.status_code, 200)
            self.assertGreater(len(catalog.json['assets']), 15)
            detail = client.get('/api/longhistory?symbol=INX')
            self.assertAlmostEqual(detail.json['asset']['annual'][1]['return'], 20)
            self.assertIsNone(detail.json['asset']['annual'][1]['monthlyDrawdown'])
            self.assertIn('缺月', detail.json['asset']['annual'][1]['monthlyDrawdownReason'])
            self.assertIn('monthlyDrawdown', detail.json['asset']['performance']['all'])
            self.assertIn('monthlyDrawdown', catalog.json['comparisons']['all']['all']['rows'][0])
            self.assertEqual(client.get('/api/longhistory?symbol=INX', headers={'If-None-Match': detail.headers['ETag']}).status_code, 304)

    def test_no_futures_history_is_misrepresented_as_nikkei_cash(self):
        nikkei = next(asset for asset in assets() if asset['id'] == 'N225')
        with storage.get_conn() as conn:
            conn.execute("INSERT INTO market_history VALUES('sina-futures','NK','2025-12-31',40000,1)")
        self.assertEqual(stored_daily_points(nikkei, datetime.now(ZoneInfo('UTC'))), [])

    def test_refresh_is_bounded_and_failure_keeps_published_history(self):
        save_points('SH000001', [point('2025-12-31')], 1)
        now = datetime(2026, 9, 15, tzinfo=ZoneInfo('Asia/Shanghai'))
        with patch('backend.long_history.stored_daily_points', return_value=[]), \
                patch('backend.long_history.fetch_rows', side_effect=ValueError('HTTP 403')) as fetch, \
                patch('backend.long_history.time.sleep'):
            result = refresh(limit=2, now=now)
            self.assertEqual(fetch.call_count, 2)
            self.assertEqual(result['checked'], 2)
            self.assertEqual(read_points('SH000001')[0]['close'], 100)
            with storage.get_conn() as conn:
                data = json.loads(conn.execute("SELECT payload FROM dashboard_snapshots WHERE name='long-history:SH000001'").fetchone()[0])
            self.assertTrue(data['asset']['refreshFailed'])

    def test_crypto_cutoff_uses_utc_not_beijing_date(self):
        btc = next(asset for asset in assets() if asset['id'] == 'BTC')
        now = datetime.fromisoformat('2026-01-01T02:00:00+08:00')
        self.assertEqual(completed_cutoff(btc, now), '2025-11-30')

    def test_public_snapshot_catalog_series_and_annual_table_share_one_completed_month_cutoff(self):
        save_points('INX', [point('2025-12-31'), point('2026-08-31', 110), point('2026-09-15', 200)], 1)
        payload = publish(datetime.fromisoformat('2026-09-15T22:00:00+08:00'))
        item = next(asset for asset in payload['assets'] if asset['id'] == 'INX')
        self.assertEqual(item['lastDate'], '2026-08-31')
        self.assertEqual(item['completedThrough'], '2026-08')
        self.assertAlmostEqual(item['annual'][0]['return'], 10)
        with storage.get_conn() as conn:
            detail = json.loads(conn.execute("SELECT payload FROM dashboard_snapshots WHERE name='long-history:INX'").fetchone()[0])
        self.assertEqual(detail['points'][-1]['period'], '2026-08')
        self.assertEqual(len(read_points('INX')), 3)

    def test_snapshot_keeps_rolling_chart_and_calendar_comparison_on_distinct_baselines(self):
        save_points('INX', [point('2020-12-31', 50), point('2021-08-31'), point('2024-12-31', 100), point('2025-12-31', 120),
                            point('2026-08-31', 160), point('2026-09-15', 200)], 1)
        payload = publish(datetime.fromisoformat('2026-09-15T22:00:00+08:00'))
        item = next(asset for asset in payload['assets'] if asset['id'] == 'INX')
        self.assertEqual(item['performance']['5']['months'], 60)
        self.assertAlmostEqual(item['performance']['5']['change'], 60)
        comparison = payload['comparisons']['usa']['5']
        self.assertEqual((comparison['startPeriod'], comparison['endPeriod']), ('2021-01', '2025-12'))
        row = next(row for row in comparison['rows'] if row['id'] == 'INX')
        self.assertAlmostEqual(row['change'], (120 / 50 - 1) * 100)
        self.assertEqual(row['months'], 60)
        self.assertEqual((row['startClose'], row['endClose']), (50, 120))
        self.assertEqual((item['performance']['5']['startClose'], item['performance']['5']['endClose']), (100, 160))
        self.assertAlmostEqual(row['cagr'], ((120 / 50) ** (1 / 5) - 1) * 100)
        self.assertNotIn('annualComparisons', payload)
        with storage.get_conn() as conn:
            detail = json.loads(conn.execute("SELECT payload FROM dashboard_snapshots WHERE name='long-history:INX'").fetchone()[0])
        self.assertEqual(detail['asset']['performance']['5'], item['performance']['5'])

    def test_beijing_new_year_does_not_finalize_an_unfinished_us_year(self):
        save_points('INX', [point('2024-12-31'), point('2025-12-30', 120)], 1)
        payload = publish(datetime.fromisoformat('2026-01-01T02:00:00+08:00'))
        item = next(asset for asset in payload['assets'] if asset['id'] == 'INX')
        row = next(row for row in item['annual'] if row['year'] == 2025)
        self.assertIsNone(row['return'])
        self.assertEqual(row['reason'], '该市场年度尚未结束')
        self.assertEqual(payload['comparisons']['all']['5']['endPeriod'], '2024-12')


if __name__ == '__main__':
    unittest.main()
