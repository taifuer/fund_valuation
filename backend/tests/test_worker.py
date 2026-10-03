from __future__ import annotations

import threading
import sqlite3
import unittest
from datetime import datetime
from unittest.mock import patch, Mock

from backend.worker import CoalescingMaintenanceQueue, latest_fund_history_refresh_delay, coordinate_worker


class WorkerSchedulingTests(unittest.TestCase):
    def test_lease_contention_retries_then_recovers(self):
        action = Mock(side_effect=[sqlite3.OperationalError('database is locked'), True])
        with patch('backend.worker.time.sleep'):
            self.assertTrue(coordinate_worker(action))
        self.assertEqual(action.call_count, 2)

    def test_lease_contention_is_bounded_and_other_errors_remain_visible(self):
        action = Mock(side_effect=sqlite3.OperationalError('database is locked'))
        with patch('backend.worker.time.sleep'), patch('builtins.print'):
            self.assertIsNone(coordinate_worker(action))
        self.assertEqual(action.call_count, 3)
        with self.assertRaisesRegex(sqlite3.OperationalError, 'disk full'):
            coordinate_worker(Mock(side_effect=sqlite3.OperationalError('disk full')))

    def test_stop_interrupts_lease_retry(self):
        stop = threading.Event()
        stop.set()
        action = Mock(side_effect=sqlite3.OperationalError('database is locked'))
        self.assertIsNone(coordinate_worker(action, stop))
        self.assertEqual(action.call_count, 1)

    def test_latest_fund_history_uses_half_hour_evening_window(self) -> None:
        self.assertEqual(
            latest_fund_history_refresh_delay(datetime.fromisoformat("2026-08-03T16:00:00+08:00")),
            30 * 60,
        )
        self.assertEqual(
            latest_fund_history_refresh_delay(datetime.fromisoformat("2026-08-03T23:29:00+08:00")),
            60,
        )

    def test_latest_fund_history_uses_two_hours_outside_evening_window(self) -> None:
        self.assertEqual(
            latest_fund_history_refresh_delay(datetime.fromisoformat("2026-08-03T15:59:00+08:00")),
            60,
        )
        self.assertEqual(
            latest_fund_history_refresh_delay(datetime.fromisoformat("2026-08-03T23:30:00+08:00")),
            2 * 60 * 60,
        )

    def test_latest_fund_history_keeps_two_hour_cadence_away_from_boundary(self) -> None:
        self.assertEqual(
            latest_fund_history_refresh_delay(datetime.fromisoformat("2026-08-03T12:00:00+08:00")),
            2 * 60 * 60,
        )

    def test_maintenance_queue_keeps_work_submitted_while_busy(self) -> None:
        started = threading.Event()
        release = threading.Event()
        calls: list[set[str]] = []

        def handler(flags: set[str]) -> None:
            calls.append(flags)
            if "first" in flags:
                started.set()
                self.assertTrue(release.wait(timeout=2))

        queue = CoalescingMaintenanceQueue(handler)
        queue.submit({"first"})
        self.assertTrue(started.wait(timeout=2))
        queue.submit({"second"})
        release.set()
        queue.join()

        self.assertEqual(calls, [{"first"}, {"second"}])

    def test_maintenance_queue_continues_after_handler_error(self) -> None:
        calls: list[set[str]] = []

        def handler(flags: set[str]) -> None:
            calls.append(flags)
            if "first" in flags:
                raise RuntimeError("test failure")

        queue = CoalescingMaintenanceQueue(handler)
        with patch("builtins.print"):
            queue.submit({"first"})
            queue.join()
        queue.submit({"second"})
        queue.join()

        self.assertEqual(calls, [{"first"}, {"second"}])


if __name__ == "__main__":
    unittest.main()
