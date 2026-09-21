import copy
import io
import json
import unittest
from unittest.mock import patch

from backend import config


class FundConfigTests(unittest.TestCase):
    def test_market_status_scope_excludes_holdings_and_archived_or_close_only_assets(self):
        payload = copy.deepcopy(config.load_universe())
        payload['indices'] = [
            {'sinaSymbol': 'int_cash', 'futures': {'sinaSymbol': 'hf_future'}},
            {'sinaSymbol': 'int_cash'},
            {'sinaSymbol': 'int_archived', 'recentEnabled': False},
            {'sinaSymbol': 'int_close', 'quoteMode': 'close'},
        ]
        payload['funds'][0]['holdings'] = [{'sinaSymbol': 'gb_holding', 'weight': 0.5}]
        with patch.object(config, '_CACHE', payload):
            markets = config.configured_market_quote_symbols()
            self.assertIn('int_cash', markets)
            self.assertIn('hf_future', markets)
            self.assertEqual(markets.count('int_cash'), 1)
            for symbol in ('int_archived', 'int_close', 'gb_holding'):
                self.assertNotIn(symbol, markets)
            self.assertIn('gb_holding', config.configured_sina_symbols())

    def test_archive_visibility_does_not_delete_historical_configuration(self):
        self.assertEqual(config.archived_market_return_items(), {'yahoo-index:RUT', 'yahoo-index:OEX'})
        for value in ('false', 0, None):
            with self.subTest(value=value):
                payload = copy.deepcopy(config.load_universe())
                payload['rankingIndices'][0]['recentEnabled'] = value
                with patch.object(config, '_CACHE', None), patch.object(
                    type(config.UNIVERSE_FILE), 'open', return_value=io.StringIO(json.dumps(payload)),
                ):
                    with self.assertRaisesRegex(RuntimeError, 'recentEnabled'):
                        config.load_universe()

    def test_default_index_funds_are_official_only_and_active_funds_keep_estimates(self):
        funds = config.load_universe()['funds']
        self.assertEqual(sum(fund['strategy'] == 'index' for fund in funds), 10)
        self.assertEqual(sum(fund['strategy'] == 'active' for fund in funds), 16)
        for fund in funds:
            self.assertEqual(config.fund_estimate_enabled(fund['code']), fund['strategy'] == 'active')
        for code in ('270042', '160213', '050025', '161125', '040046', '000834', '016532', '007721'):
            self.assertFalse(config.fund_estimate_enabled(code))
            self.assertEqual(config.default_fund_holdings(code), [])

    def test_rejects_invalid_strategy_and_missing_tracking_index(self):
        for updates in ({'strategy': 'passive'}, {'strategy': []}, {'strategy': 'index', 'trackingIndex': ''}, {'strategy': 'index', 'trackingIndex': 100}):
            with self.subTest(updates=updates):
                payload = copy.deepcopy(config.load_universe())
                payload['funds'][0].update(updates)
                with patch.object(config, '_CACHE', None), patch.object(
                    type(config.UNIVERSE_FILE), 'open', return_value=io.StringIO(json.dumps(payload)),
                ):
                    with self.assertRaises(RuntimeError):
                        config.load_universe()

    def test_official_only_holdings_do_not_add_realtime_quote_requests(self):
        payload = copy.deepcopy(config.load_universe())
        for fund in payload['funds']:
            if fund['strategy'] == 'index':
                fund['holdings'] = [{'sinaSymbol': 'gb_testpassive' + fund['code'], 'weight': 1}]
        with patch.object(config, '_CACHE', payload):
            self.assertFalse(any(symbol.startswith('gb_testpassive') for symbol in config.configured_sina_symbols()))

    def test_share_metadata_matches_selected_codes(self):
        funds = config.load_universe()['funds']
        self.assertEqual(sum(fund.get('shareClass') == 'A' for fund in funds), 22)
        self.assertEqual([fund['code'] for fund in funds if fund.get('shareClass') == 'C'], ['022184'])
        self.assertEqual({fund['code'] for fund in funds if not fund.get('shareClass')}, {'000043', '004877', '160213'})
        self.assertTrue(all(fund['navCurrency'] == 'CNY' for fund in funds))

    def test_rejects_invalid_share_metadata(self):
        for updates in ({'shareClass': []}, {'shareClass': 'a'}, {'shareClass': ''}, {'navCurrency': []}, {'navCurrency': 'RMB'}):
            with self.subTest(updates=updates):
                payload = copy.deepcopy(config.load_universe())
                payload['funds'][0].update(updates)
                with patch.object(config, '_CACHE', None), patch.object(
                    type(config.UNIVERSE_FILE), 'open', return_value=io.StringIO(json.dumps(payload)),
                ):
                    with self.assertRaises(RuntimeError):
                        config.load_universe()
