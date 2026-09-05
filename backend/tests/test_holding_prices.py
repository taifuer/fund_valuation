import sqlite3
import tempfile
import unittest
from pathlib import Path

from backend.holding_prices import history_basis, holding_price_return
from backend.storage import migrate_database
from backend.estimation import estimate_aligned_returns


class HoldingPriceTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / 'test.db'
        migrate_database(self.path)
        self.conn = sqlite3.connect(self.path)
        self.addCleanup(self.conn.close)

    def test_unverified_split_is_not_a_loss(self):
        self.assertIsNone(holding_price_return(self.conn, 'gb_a', '2026-09-01', '2026-09-02', 100, 50))
        self.assertAlmostEqual(holding_price_return(self.conn, 'gb_a', '2026-09-01', '2026-09-02', 100, 99), -0.01)

    def test_verified_split_and_cash_distribution(self):
        self.conn.executemany('INSERT INTO market_adjustment_factors VALUES (?,?,?,?,?,?,?)', [
            ('sh600001', '1900-01-01', 1, 1, 0, 'verified-test', 1),
            ('sh600001', '2026-09-02', 1, 2, 2, 'verified-test', 1),
        ])
        self.assertAlmostEqual(holding_price_return(self.conn, 'sh600001', '2026-09-01', '2026-09-02', 100, 49), 0)

    def test_intermediate_unverified_jump_cannot_cancel_out(self):
        self.conn.execute("INSERT INTO stock_daily_history VALUES ('gb_a','2026-09-02',50,0,1)")
        self.assertIsNone(holding_price_return(self.conn, 'gb_a', '2026-09-01', '2026-09-03', 100, 100))

    def test_mixed_basis_rejected(self):
        self.conn.execute("INSERT INTO stock_daily_history VALUES ('hk00522','2026-09-02',99,0,1)")
        self.assertEqual(history_basis('hk00522', None), 'unknown')
        self.assertIsNone(holding_price_return(self.conn, 'hk00522', '2026-09-01', '2026-09-03', 100, 100))
        self.conn.execute("INSERT INTO stock_price_basis VALUES ('hk00522','2026-09-02','qfq','tencent',1)")
        self.assertIsNone(holding_price_return(self.conn, 'hk00522', '2026-09-01', '2026-09-03', 100, 100))
        self.conn.execute("UPDATE stock_price_basis SET basis='raw'")
        self.assertAlmostEqual(holding_price_return(self.conn, 'hk00522', '2026-09-01', '2026-09-03', 100, 100), 0)

    def test_coverage_changes_cannot_manufacture_a_daily_loss(self):
        holdings = [{'sinaSymbol': symbol, 'currency': 'CNY', 'weight': 0.5} for symbol in ('A', 'B')]
        prices = {('A', 'base'): 100, ('A', 'previous'): 110, ('B', 'base'): 100, ('B', 'previous'): 100, ('B', 'target'): 100}
        current, previous = estimate_aligned_returns(holdings, base_date='base', target_date='target', previous_date='previous',
            price_lookup=lambda symbol, day: prices.get((symbol, day)), fx_lookup=lambda *_: 1)
        self.assertEqual(current['return'], 0)
        self.assertEqual(previous['return'], 0)
        self.assertEqual(current['coveredWeight'], previous['coveredWeight'])
