import unittest

from backend.fund_disclosures import assignment, disclosure_allocations, disclosure_history


class FundDisclosureTests(unittest.TestCase):
    def test_parser_does_not_execute_javascript(self):
        self.assertIsNone(assignment('var value = (() => 42)();', 'value'))
        self.assertEqual(assignment('var value = {"safe":true};', 'value'), {'safe': True})

    def test_older_zero_placeholder_is_not_an_official_return(self):
        text = 'var Data_netWorthTrend = [{"x":0,"y":2,"equityReturn":0},{"x":86400000,"y":1,"equityReturn":0}];var Data_ACWorthTrend = [[0,2],[86400000,2]];'
        rows = disclosure_history(text)
        self.assertIsNone(rows[1]['JZZZL'])
        self.assertEqual(rows[1]['LJJZ'], 2)

    def test_allocation_is_taken_from_the_dated_stock_series(self):
        text = 'var Data_assetAllocation = {"categories":["2026-06-30"],"series":[{"name":"现金占净比","data":[15]},{"name":"股票占净比","data":[80]}]};'
        self.assertEqual(disclosure_allocations(text), [('2026-06-30', 0.8)])
