import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend import storage
from backend.observability import RequestMetrics, run_task, worker_task_snapshot


class ObservabilityTests(unittest.TestCase):
    def test_p95_is_bounded_and_per_route(self):
        metrics = RequestMetrics()
        for duration in range(1, 101):
            metrics.record('/api/overview', 200, duration, 'hit')
        metrics.record('/api/fundhistory', 200, 10000, '')
        self.assertEqual(metrics.snapshot()['routes'][0]['p95DurationMs'], 95)
        for _ in range(300):
            metrics.record('/api/overview', 200, 1, '')
        self.assertEqual(metrics.snapshot()['routes'][0]['sampleCount'], 256)
        self.assertEqual(metrics.snapshot()['routes'][0]['p95DurationMs'], 1)
        self.assertEqual(metrics.snapshot()['scope'], 'process')

    def test_task_failure_is_not_erased_by_other_tasks(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(storage, 'DB_PATH', Path(directory) / 'test.db'):
            storage.migrate_database(storage.DB_PATH)
            run_task('history', lambda: {'failed': 2, 'errors': ['unavailable']})
            run_task('quotes', lambda: None)
            records = {row['name']: row for row in worker_task_snapshot()}
            self.assertEqual(records['history']['lastSuccessAt'], 0)
            self.assertIn('failed=2', records['history']['error'])
            self.assertGreater(records['quotes']['lastSuccessAt'], 0)
            with self.assertRaises(ValueError):
                run_task('history', lambda: (_ for _ in ()).throw(ValueError('bad input')))
            run_task('history', lambda: None)
            records = {row['name']: row for row in worker_task_snapshot()}
            self.assertEqual(records['history']['runCount'], 3)
            self.assertEqual(records['history']['error'], '')
            self.assertGreater(records['history']['lastErrorAt'], 0)
