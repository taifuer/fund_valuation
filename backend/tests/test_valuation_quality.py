import json
import sqlite3
import tempfile
import unittest
from datetime import date
from pathlib import Path

from backend.storage import migrate_database
from backend.estimation import eligible_daily_sample
from backend.valuation_quality import valuation_quality_report


class ValuationQualityTests(unittest.TestCase):
    def test_same_period_samples_are_deduplicated_and_bias_is_signed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'test.db'
            migrate_database(path)
            with sqlite3.connect(path) as conn:
                for day in range(1, 5):
                    conn.execute("INSERT INTO fund_nav_history VALUES ('A',?,1,1,1)", (f'2026-09-0{day}',))
                for day, kind, estimated, comparison in [('2026-09-02', 'pending', 2, '2026-09-01'),
                        ('2026-09-02', 'preview', 99, '2026-09-01'), ('2026-09-03', 'pending', -1, '2026-09-02'),
                        ('2026-09-04', 'pending', 50, '2026-09-01')]:
                    conn.execute('''INSERT INTO fund_estimate_snapshots(code,target_date,estimate_kind,model_version,
                        base_nav_date,base_nav,estimated_nav,raw_change,estimated_change,cumulative_change,coverage,
                        benchmark_source,benchmark_symbol,phase,complete,as_of,comparison_date,input_signature,actual_change,details_json)
                        VALUES ('A',?,?,'v2','2026-09-01',1,1,0,?,0,0.8,'sina','SPX','CLOSED',1,1,?,'sig',1,?)''',
                        (day, kind, estimated, comparison, json.dumps({'disclosedWeight': 0.9})))
            report = valuation_quality_report(path, as_of=date(2026, 9, 5))
            self.assertEqual(report['sampleCount'], 2)
            self.assertEqual(report['excludedCount'], 1)
            group = report['groups'][0]
            self.assertEqual(group['maePp'], 1.5)
            self.assertEqual(group['biasPp'], -0.5)
            self.assertEqual(group['p95AbsoluteErrorPp'], 2)
            self.assertEqual(group['maxAbsoluteErrorPp'], 2)
            self.assertEqual(group['averageCoveragePct'], 80)
            self.assertEqual(group['averageMissingDisclosedWeightPp'], 10)
            self.assertFalse(group['calibrationEligible'])

    def test_daily_sample_gate_rejects_bad_inputs_but_keeps_zero_and_holiday_fx(self):
        sample = {'raw_change': 0, 'actual_change': 0, 'complete': True, 'input_signature': 'sig',
                  'previous_nav_date': '2026-09-01', 'comparison_date': '2026-09-01', 'details_json': '{}'}
        self.assertTrue(eligible_daily_sample(sample))
        for details in ['not-json', '[]', '{"quality":{"reasons":null}}',
                        '{"quality":{"reasons":["stalePrice"]}}', '{"quality":{"reasons":["staleBenchmark"]}}']:
            with self.subTest(details=details):
                self.assertFalse(eligible_daily_sample({**sample, 'details_json': details}))
        self.assertTrue(eligible_daily_sample({**sample, 'details_json':
            '{"quality":{"reasons":[],"fxCarried":true}}'}))
        self.assertFalse(eligible_daily_sample({**sample, 'raw_change': float('nan')}))

    def test_missing_database_is_not_created(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'missing.db'
            with self.assertRaises(sqlite3.OperationalError):
                valuation_quality_report(path)
            self.assertFalse(path.exists())
