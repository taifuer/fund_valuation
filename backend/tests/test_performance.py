import unittest

from backend.performance import adjusted_market_rows, fund_performance_rows, parse_sina_adjustments


class HistoricalPerformanceTests(unittest.TestCase):
    def test_fund_cash_distribution_preserves_total_return(self):
        rows = fund_performance_rows([
            ("2026-06-01", 2, None, 2), ("2026-06-02", 1.8, 0, 2),
            ("2026-06-03", 1.89, 5, 2.09),
        ])
        self.assertAlmostEqual(rows[-1]["returnValue"], 1.05)
        self.assertTrue(rows[-1]["adjusted"])

    def test_missing_official_change_stays_missing(self):
        rows = fund_performance_rows([("2026-06-01", 1, None, None), ("2026-06-02", 1.02, None, None)])
        self.assertIsNone(rows[-1]["changePercent"])
        self.assertAlmostEqual(rows[-1]["returnValue"], 1.02)

    def test_accumulated_nav_can_resolve_distribution(self):
        rows = fund_performance_rows([("2026-06-01", 2, None, 2), ("2026-06-02", 1.82, None, 2.02)])
        self.assertAlmostEqual(rows[-1]["returnValue"], 1.01)

    def test_unverified_fund_discontinuity_starts_new_segment(self):
        rows = fund_performance_rows([("2026-06-01", 2, None, None), ("2026-06-02", 1, None, None)])
        self.assertNotEqual(rows[0]["returnSegment"], rows[1]["returnSegment"])

    def test_split_preserves_actual_ex_date_move(self):
        factors = [{"date": "1900-01-01", "factor": 1, "shares": 1, "cash": 0},
                   {"date": "2026-07-09", "factor": 1, "shares": 3, "cash": 0}]
        rows = adjusted_market_rows([{"date": "2026-07-08", "close": 3}, {"date": "2026-07-09", "close": 1.01}], factors)
        self.assertAlmostEqual(rows[-1]["close"] / rows[0]["close"] - 1, .01)
        self.assertEqual(rows[-1]["returnSegment"], 0)

    def test_etf_cash_distribution_is_reinvested(self):
        factors = [{"date": "1900-01-01", "factor": 1, "shares": 1, "cash": 0},
                   {"date": "2026-07-09", "factor": 1, "shares": 1, "cash": .1}]
        rows = adjusted_market_rows([{"date": "2026-07-08", "close": 2}, {"date": "2026-07-09", "close": 1.92}], factors)
        self.assertAlmostEqual(rows[-1]["close"], 2.02)

    def test_unknown_etf_split_is_not_silently_flattened(self):
        rows = adjusted_market_rows([{"date": "2026-07-08", "close": 3}, {"date": "2026-07-09", "close": 1}])
        self.assertEqual(rows[-1]["quality"], "unverifiedCorporateAction")
        self.assertEqual(rows[-1]["rawClose"], 1)
        self.assertNotEqual(rows[0]["returnSegment"], rows[-1]["returnSegment"])

    def test_adjustment_parser_rejects_code_and_invalid_numbers(self):
        self.assertEqual(parse_sina_adjustments('var x = alert("bad")'), [])
        self.assertEqual(parse_sina_adjustments('var x = {"data":[{"d":"2026-07-09","f":"NaN"}]}'), [])
        parsed = parse_sina_adjustments('var x={"data":[{"d":"1900-01-01","f":"1","s":"1","u":"0"}]}; /* comment */')
        self.assertEqual(parsed[0]["shares"], 1)
