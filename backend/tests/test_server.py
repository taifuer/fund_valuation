from __future__ import annotations

import os
import json
import sqlite3
import tempfile
import unittest
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo
from unittest.mock import patch


_TEMP_DATA = tempfile.TemporaryDirectory()
os.environ["FUND_VALUATION_DATA_DIR"] = _TEMP_DATA.name

from backend import server  # noqa: E402
from backend.storage import CACHE_BODY_COMPRESSION_MAGIC  # noqa: E402
from backend.fx_history import parse_ecb_reference_rates  # noqa: E402
from backend.data_coverage import expected_holding_periods, historical_data_coverage  # noqa: E402


class FakeResponse:
    def __init__(self, body: bytes, status: int = 200, content_type: str = "text/plain; charset=utf-8") -> None:
        self._body = body
        self.status = status
        self.headers = {"Content-Type": content_type}

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self) -> bytes:
        return self._body


class ServerDataRefreshTests(unittest.TestCase):
    def setUp(self) -> None:
        server.ensure_storage()
        with sqlite3.connect(server.DB_PATH) as conn:
            conn.executescript(
                """
                DELETE FROM response_cache;
                DELETE FROM fund_nav_history;
                DELETE FROM fund_holdings;
                DELETE FROM fund_purchase_status;
                DELETE FROM fund_profiles;
                DELETE FROM market_history;
                DELETE FROM market_calendar;
                DELETE FROM stock_daily_history;
                DELETE FROM fx_daily_history;
                DELETE FROM fund_estimate_snapshots;
                DELETE FROM market_quote_snapshots;
                DELETE FROM dashboard_snapshots;
                DELETE FROM background_jobs;
                """
            )
        with server._RATE_LIMIT_GUARD:
            server._RATE_LIMIT_BUCKETS.clear()
        with server._RESPONSE_CACHE_GUARD:
            server._RESPONSE_CACHE.clear()
        with server._MARKET_HISTORY_REFRESH_GUARD:
            server._MARKET_HISTORY_REFRESHING.clear()
        with server._FUND_NAV_REFRESH_GUARD:
            server._FUND_NAV_REFRESHING.clear()
        with server._FUND_PROFILE_REFRESH_GUARD:
            server._FUND_PROFILE_REFRESHING.clear()
        with server._FUND_HISTORY_REFRESH_GUARD:
            server._FUND_HISTORY_REFRESHING.clear()
        with server._FUND_PURCHASE_REFRESH_GUARD:
            server._FUND_PURCHASE_REFRESHING = False
        with server._UPSTREAM_HEALTH_GUARD:
            server._UPSTREAM_HEALTH.clear()
        with server._BACKGROUND_REFRESH_GUARD:
            server._BACKGROUND_REFRESH_STATE.update({
                "started": False,
                "lastRunAt": 0,
                "lastSuccessAt": 0,
                "lastErrorAt": 0,
                "lastError": "",
                "runCount": 0,
            })

    def test_fetch_upstream_uses_cache_until_force_refresh(self) -> None:
        bodies = [b"old", b"new"]
        calls: list[str] = []

        def fake_urlopen(req: object, timeout: int) -> FakeResponse:
            del timeout
            calls.append(getattr(req, "full_url", ""))
            return FakeResponse(bodies[len(calls) - 1])

        with patch.object(server, "urlopen", side_effect=fake_urlopen):
            first = server.fetch_upstream(
                "https://example.test/data",
                referer="https://example.test/",
                content_type="text/plain",
                cache_key="quote:test",
                kind="quote",
                ttl_seconds=3600,
            )
            cached = server.fetch_upstream(
                "https://example.test/data",
                referer="https://example.test/",
                content_type="text/plain",
                cache_key="quote:test",
                kind="quote",
                ttl_seconds=3600,
            )
            refreshed = server.fetch_upstream(
                "https://example.test/data",
                referer="https://example.test/",
                content_type="text/plain",
                cache_key="quote:test",
                kind="quote",
                ttl_seconds=3600,
                force_refresh=True,
            )
            cached_after_refresh = server.fetch_upstream(
                "https://example.test/data",
                referer="https://example.test/",
                content_type="text/plain",
                cache_key="quote:test",
                kind="quote",
                ttl_seconds=3600,
            )

        self.assertEqual(first[2], b"old")
        self.assertEqual(cached[2], b"old")
        self.assertEqual(refreshed[2], b"new")
        self.assertEqual(cached_after_refresh[2], b"new")
        self.assertEqual(len(calls), 2)

    def test_cache_put_compresses_large_body_and_cache_get_decodes_it(self) -> None:
        body = b'{"history":[123.45,678.90]}' * 2000

        server.cache_put("large:test", "https://example.test/large", 200, "application/json", body)

        with sqlite3.connect(server.DB_PATH) as conn:
            stored = bytes(
                conn.execute(
                    "SELECT body FROM response_cache WHERE cache_key = ?",
                    ("large:test",),
                ).fetchone()[0]
            )
        self.assertTrue(stored.startswith(CACHE_BODY_COMPRESSION_MAGIC))
        self.assertLess(len(stored), len(body))
        self.assertEqual(server.cache_get("large:test", 3600), (200, "application/json", body))

    def test_cache_get_discards_corrupt_compressed_body(self) -> None:
        with sqlite3.connect(server.DB_PATH) as conn:
            conn.execute(
                """
                INSERT INTO response_cache(cache_key, url, status, content_type, body, fetched_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    "corrupt:test",
                    "https://example.test/corrupt",
                    200,
                    "application/json",
                    CACHE_BODY_COMPRESSION_MAGIC + b"not-zlib",
                    server.now_ms(),
                ),
            )

        self.assertIsNone(server.cache_get("corrupt:test", 3600))
        with sqlite3.connect(server.DB_PATH) as conn:
            count = conn.execute(
                "SELECT COUNT(*) FROM response_cache WHERE cache_key = ?",
                ("corrupt:test",),
            ).fetchone()[0]
        self.assertEqual(count, 0)

    def test_fetch_upstream_records_stale_fallback_health(self) -> None:
        with sqlite3.connect(server.DB_PATH) as conn:
            conn.execute(
                """
                INSERT INTO response_cache(cache_key, url, status, content_type, body, fetched_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                ("quote:stale", "https://example.test/data", 200, "text/plain", b"stale", server.now_ms() - 90_000),
            )

        with patch.object(server, "urlopen", side_effect=server.URLError("timeout")):
            result = server.fetch_upstream(
                "https://example.test/data",
                referer="https://example.test/",
                content_type="text/plain",
                cache_key="quote:stale",
                kind="quote",
                ttl_seconds=1,
            )

        self.assertEqual(result[2], b"stale")
        snapshot = server.upstream_health_snapshot()
        self.assertEqual(snapshot["staleCount"], 1)
        self.assertEqual(snapshot["errorCount"], 1)
        self.assertEqual(snapshot["issueCount"], 1)
        self.assertIn("quote:stale", snapshot["issues"][0]["key"])

    def test_upstream_health_ignores_expired_transient_issues(self) -> None:
        with patch.object(server, "now_ms", return_value=1_000):
            server.record_upstream_health(
                cache_key="quote:expired",
                kind="quote",
                url="sina:expired",
                source="error",
                error="temporary failure",
            )
        with patch.object(
            server,
            "now_ms",
            return_value=1_000 + server.UPSTREAM_HEALTH_ISSUE_TTL_MS + 1,
        ):
            snapshot = server.upstream_health_snapshot()

        self.assertEqual(snapshot["issueCount"], 0)
        self.assertEqual(snapshot["errorCount"], 0)
        self.assertEqual(snapshot["expiredIssueCount"], 1)

    def test_eastmoney_json_can_disable_stale_fallback(self) -> None:
        with sqlite3.connect(server.DB_PATH) as conn:
            conn.execute(
                """
                INSERT INTO response_cache(cache_key, url, status, content_type, body, fetched_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    "eastmoney-global:100.N225",
                    "https://push2.eastmoney.com/api/qt/stock/get?secid=100.N225",
                    200,
                    "application/json",
                    b'{"data":{"f43":12345}}',
                    server.now_ms() - 90_000,
                ),
            )

        with patch.object(server, "fetch_eastmoney_body", return_value=(b"", 599, "application/json")):
            payload = server.fetch_eastmoney_json(
                "https://push2.eastmoney.com/api/qt/stock/get?secid=100.N225",
                cache_key="eastmoney-global:100.N225",
                kind="eastmoney-global",
                ttl_seconds=1,
                allow_stale_cache=False,
            )

        self.assertIsNone(payload)
        snapshot = server.upstream_health_snapshot()
        self.assertEqual(snapshot["staleCount"], 0)
        self.assertEqual(snapshot["issueCount"], 1)
        self.assertEqual(snapshot["issues"][0]["source"], "error")

    def test_data_health_endpoint_reports_storage_state(self) -> None:
        with (
            patch.object(server, "configured_fund_codes_from_constants", return_value=["016664"]),
            patch.object(server, "configured_market_return_items_from_constants", return_value=["sina-cn:sh000001"]),
        ):
            response = server.app.test_client().get("/api/datahealth")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["status"], "degraded")
        self.assertEqual(payload["fundHistory"]["missing"], 1)
        self.assertEqual(payload["marketHistory"]["missing"], 1)
        self.assertIn("backgroundRefresh", payload)

    def test_fund_valuation_basis_reads_latest_values_on_or_before_nav_date(self) -> None:
        with sqlite3.connect(server.DB_PATH) as conn:
            conn.executemany(
                """
                INSERT INTO stock_daily_history(sina_symbol, date, close, change_percent, fetched_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                [
                    ("gb_aapl", "2026-07-20", 200, 1, 1),
                    ("gb_aapl", "2026-07-21", 204, 2, 2),
                    ("gb_aapl", "2026-07-22", 210, 3, 3),
                ],
            )
            conn.executemany(
                """
                INSERT INTO fx_daily_history(currency, date, rate, change_percent, fetched_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                [
                    ("USD", "2026-07-20", 6.80, 0, 1),
                    ("USD", "2026-07-21", 6.82, 0.3, 2),
                    ("USD", "2026-07-22", 6.84, 0.3, 3),
                ],
            )

        response = server.app.test_client().post("/api/fundvaluationbasis", json={
            "funds": [{
                "code": "017436",
                "navDate": "2026-07-21",
                "symbols": ["gb_aapl"],
                "currencies": ["USD"],
            }],
        })

        self.assertEqual(response.status_code, 200)
        basis = response.get_json()["017436"]
        self.assertEqual(basis["holdingPrices"]["gb_aapl"], {"date": "2026-07-21", "close": 204.0})
        self.assertEqual(basis["fxRates"]["USD"], {"date": "2026-07-21", "rate": 6.82})

    def test_fund_valuation_basis_rejects_unvalidated_symbols(self) -> None:
        response = server.app.test_client().post("/api/fundvaluationbasis", json={
            "funds": [{
                "code": "017436",
                "navDate": "2026-07-21",
                "symbols": ["../../etc/passwd"],
                "currencies": ["USD"],
            }],
        })
        self.assertEqual(response.status_code, 400)

    def test_fund_valuation_basis_requires_management_token_for_custom_funds(self) -> None:
        payload = {
            "funds": [{
                "code": "118001",
                "navDate": "2026-07-21",
                "symbols": ["gb_aapl"],
                "currencies": ["USD"],
            }],
        }
        client = server.app.test_client()
        with patch.dict(os.environ, {
            "FUND_VALUATION_ENABLE_FUND_MANAGEMENT": "1",
            "FUND_VALUATION_FUND_MANAGEMENT_TOKEN": "management-secret",
        }):
            denied = client.post("/api/fundvaluationbasis", json=payload)
            allowed = client.post(
                "/api/fundvaluationbasis",
                json=payload,
                headers={"X-Fund-Management-Token": "management-secret"},
            )

        self.assertEqual(denied.status_code, 403)
        self.assertEqual(allowed.status_code, 200)

    def test_fund_estimates_separate_completed_target_from_live_preview(self) -> None:
        with sqlite3.connect(server.DB_PATH) as conn:
            conn.executemany(
                "INSERT INTO fund_nav_history VALUES (?, ?, ?, ?, ?)",
                [
                    ("017436", "2026-07-28", 0.99, 0, 1),
                    ("017436", "2026-07-29", 1.00, 1.01, 2),
                ],
            )
            conn.executemany(
                "INSERT INTO stock_daily_history VALUES (?, ?, ?, ?, ?)",
                [
                    ("gb_aapl", "2026-07-29", 100, 0, 1),
                    ("gb_aapl", "2026-07-30", 110, 10, 2),
                ],
            )
            conn.executemany(
                "INSERT INTO fx_daily_history VALUES (?, ?, ?, ?, ?)",
                [
                    ("USD", "2026-07-29", 7.0, 0, 1),
                    ("USD", "2026-07-30", 7.0, 0, 2),
                    ("USD", "2026-07-31", 7.0, 0, 3),
                ],
            )
            conn.executemany(
                "INSERT INTO market_history VALUES (?, ?, ?, ?, ?)",
                [
                    ("sina-us", ".NDX", "2026-07-29", 100, 1),
                    ("sina-us", ".NDX", "2026-07-30", 105, 2),
                ],
            )
        dashboard = {
            "generatedAt": 123456,
            "fxText": 'var hq_str_fx_susdcny="美元人民币,7.0,0,0,0,0,0,0,0,23:00:00,0,2026-07-31";',
            "quotes": {
                "gb_aapl": {
                    "price": 120,
                    "previousClose": 110,
                    "changePercent": 9.09,
                    "time": "2026-07-31 23:00:00",
                    "dateReliable": True,
                    "session": "regular",
                },
                "gb_ndx": {
                    "price": 120,
                    "previousClose": 105,
                    "changePercent": 14.29,
                    "time": "2026-07-31 23:00:00",
                    "dateReliable": True,
                    "session": "regular",
                },
            },
            "marketStates": {"gb_aapl": {"state": "live"}},
        }
        holdings = [{
            "sinaSymbol": "gb_aapl",
            "weight": 0.6,
            "currency": "USD",
            "reportDate": "2026-06-30",
        }]
        current = datetime(2026, 7, 31, 23, 0, tzinfo=ZoneInfo("Asia/Shanghai"))
        with (
            patch.object(server, "read_fund_holdings_from_db", return_value=holdings),
            patch.object(server, "universe_fund_benchmark", return_value={
                "source": "sina-us", "symbol": ".NDX", "currency": "USD",
            }),
        ):
            payload = server.build_fund_estimates(
                ["017436"], current=current, dashboard_payload=dashboard,
            )

        result = payload["017436"]
        self.assertEqual(result["pending"]["targetDate"], "2026-07-30")
        self.assertTrue(result["pending"]["complete"])
        self.assertAlmostEqual(result["pending"]["estimatedNav"], 1.08)
        self.assertEqual(result["preview"]["targetDate"], "2026-07-31")
        self.assertFalse(result["preview"]["complete"])
        self.assertEqual(result["preview"]["phase"], "LIVE")
        self.assertAlmostEqual(result["preview"]["estimatedNav"], 1.20)
        self.assertEqual(len(result["preview"]["inputSignature"]), 24)

    def test_post_market_preview_carries_completed_us_session_into_next_valuation_day(self) -> None:
        with sqlite3.connect(server.DB_PATH) as conn:
            conn.executemany(
                "INSERT INTO fund_nav_history VALUES (?, ?, ?, ?, ?)",
                [
                    ("017436", "2026-07-31", 1.0, 0, 1),
                    ("017436", "2026-08-03", 1.0, 0, 2),
                ],
            )
            conn.execute(
                "INSERT INTO stock_daily_history VALUES (?, ?, ?, ?, ?)",
                ("gb_aapl", "2026-08-03", 100, 0, 1),
            )
            conn.executemany(
                "INSERT INTO fx_daily_history VALUES (?, ?, ?, ?, ?)",
                [
                    ("USD", "2026-08-03", 7.0, 0, 1),
                    ("USD", "2026-08-04", 7.0, 0, 2),
                    ("USD", "2026-08-05", 7.0, 0, 3),
                ],
            )
            conn.execute(
                "INSERT INTO market_history VALUES (?, ?, ?, ?, ?)",
                ("sina-us", ".NDX", "2026-08-03", 100, 1),
            )
        dashboard = {
            "generatedAt": 123456,
            "fxText": 'var hq_str_fx_susdcny="美元人民币,7.0,0,0,0,0,0,0,0,07:55:00,0,2026-08-05";',
            "quotes": {
                "gb_aapl": {
                    "price": 111,
                    "previousClose": 100,
                    "changePercent": 11,
                    "time": "2026-08-05 07:55:00",
                    "dateReliable": True,
                    "session": "post",
                    "regularPrice": 110,
                    "regularTime": "2026-08-05 04:00:00",
                },
                "gb_ndx": {
                    "price": 105,
                    "previousClose": 100,
                    "changePercent": 5,
                    "time": "2026-08-05 04:00:00",
                    "dateReliable": True,
                    "session": "regular",
                },
            },
            "marketStates": {
                "gb_aapl": {
                    "state": "closed",
                    "lastTradingDay": "2026-08-04",
                },
            },
        }
        holdings = [{
            "sinaSymbol": "gb_aapl",
            "weight": 0.6,
            "currency": "USD",
            "reportDate": "2026-06-30",
        }]
        current = datetime(2026, 8, 5, 7, 55, tzinfo=ZoneInfo("Asia/Shanghai"))
        with (
            patch.object(server, "read_fund_holdings_from_db", return_value=holdings),
            patch.object(server, "universe_fund_benchmark", return_value={
                "source": "sina-us", "symbol": ".NDX", "currency": "USD",
            }),
        ):
            payload = server.build_fund_estimates(
                ["017436"], current=current, dashboard_payload=dashboard,
            )

        result = payload["017436"]
        self.assertEqual(result["pending"]["targetDate"], "2026-08-04")
        self.assertAlmostEqual(result["pending"]["estimatedNav"], 1.08)
        self.assertEqual(result["pending"]["comparisonDate"], "2026-08-03")
        self.assertAlmostEqual(result["pending"]["holdingContributionPercent"], 6.0)
        self.assertAlmostEqual(result["pending"]["residualContributionPercent"], 2.0)
        self.assertAlmostEqual(
            result["pending"]["holdingContributionPercent"]
            + result["pending"]["residualContributionPercent"]
            + result["pending"]["calibrationContributionPercent"],
            result["pending"]["changePercent"],
        )
        self.assertEqual(result["preview"]["targetDate"], "2026-08-05")
        self.assertEqual(result["preview"]["phase"], "POST")
        self.assertAlmostEqual(result["preview"]["estimatedNav"], 1.086)
        self.assertAlmostEqual(result["preview"]["changePercent"], 0.5556)
        self.assertEqual(result["preview"]["comparisonDate"], "2026-08-04")
        self.assertAlmostEqual(result["preview"]["holdingContributionPercent"], 0.5556)
        self.assertAlmostEqual(result["preview"]["residualContributionPercent"], 0.0)
        self.assertAlmostEqual(
            result["preview"]["holdingContributionPercent"]
            + result["preview"]["residualContributionPercent"]
            + result["preview"]["calibrationContributionPercent"],
            result["preview"]["changePercent"],
        )
        contribution = result["preview"]["holdingContributions"][0]
        self.assertEqual(contribution["sinaSymbol"], "gb_aapl")
        self.assertAlmostEqual(contribution["basePrice"], 110)
        self.assertAlmostEqual(contribution["targetPrice"], 111)
        self.assertAlmostEqual(contribution["priceChangePercent"], 0.9091)
        self.assertAlmostEqual(contribution["contributionPercent"], 0.5556)

    def test_valuation_cycle_rolls_after_the_us_session_closes(self) -> None:
        server.ensure_market_calendar_seeded(2026)
        before_roll = datetime(2026, 7, 31, 1, 0, tzinfo=ZoneInfo("Asia/Shanghai"))
        after_roll = datetime(2026, 7, 31, 7, 0, tzinfo=ZoneInfo("Asia/Shanghai"))

        self.assertEqual(server.cn_valuation_day_on_or_before(before_roll), "2026-07-30")
        self.assertEqual(server.cn_valuation_day_on_or_before(after_roll), "2026-07-31")

    def test_fund_estimate_snapshot_reconciles_official_nav(self) -> None:
        payload = {
            "017436": {
                "officialNavDate": "2026-07-29",
                "officialNav": 1.0,
                "holdingReportDate": "2026-06-30",
                "pending": {
                    "targetDate": "2026-07-30",
                    "comparisonDate": "2026-07-29",
                    "estimatedNav": 1.08,
                    "rawChangePercent": 7.5,
                    "changePercent": 8.0,
                    "cumulativeChangePercent": 8.0,
                    "coverage": 0.6,
                    "residualWeight": 0.4,
                    "pricedHoldingCount": 10,
                    "benchmarkSource": "sina-us",
                    "benchmarkSymbol": ".NDX",
                    "model": "holdingsBenchmark",
                    "holdingContributionPercent": 5.0,
                    "residualContributionPercent": 2.5,
                    "calibrationContributionPercent": 0.5,
                    "inputSignature": "test-input-signature",
                    "holdingContributions": [{"sinaSymbol": "gb_aapl", "contributionPercent": 5.0}],
                    "benchmarkChangePercent": 6.25,
                    "benchmarkFxChangePercent": -0.1,
                    "phase": "CLOSED",
                    "complete": True,
                    "asOf": 123,
                },
                "preview": None,
            },
        }
        server.store_fund_estimate_snapshots(payload)
        with sqlite3.connect(server.DB_PATH) as conn:
            conn.execute(
                "INSERT INTO fund_nav_history VALUES (?, ?, ?, ?, ?)",
                ("017436", "2026-07-30", 1.07, 7.0, 1),
            )
        server.reconcile_fund_estimate_snapshots(["017436"])
        with sqlite3.connect(server.DB_PATH) as conn:
            row = conn.execute(
                """
                SELECT actual_nav, actual_change, error, comparison_date,
                       holding_report_date, estimate_model, holding_contribution,
                       residual_contribution, calibration_contribution,
                       residual_weight, priced_holding_count, input_signature,
                       details_json
                FROM fund_estimate_snapshots WHERE code = ?
                """,
                ("017436",),
            ).fetchone()
        self.assertEqual(row[:-1], (
            1.07, 7.0, 1.0, "2026-07-29", "2026-06-30", "holdingsBenchmark",
            5.0, 2.5, 0.5, 0.4, 10, "test-input-signature",
        ))
        self.assertEqual(json.loads(row[-1]), {
            "holdingContributions": [{"sinaSymbol": "gb_aapl", "contributionPercent": 5.0}],
            "benchmarkChangePercent": 6.25,
            "benchmarkFxChangePercent": -0.1,
        })

    def test_fund_estimate_input_signature_is_stable_and_input_sensitive(self) -> None:
        cumulative = {
            "model": "holdingsBenchmark",
            "benchmarkSource": "sina-us",
            "benchmarkSymbol": ".NDX",
            "components": [
                {"sinaSymbol": "gb_msft", "weight": 0.2, "currency": "USD"},
                {"sinaSymbol": "gb_aapl", "weight": 0.3, "currency": "USD"},
            ],
        }
        reordered = {**cumulative, "components": list(reversed(cumulative["components"]))}
        changed = {
            **cumulative,
            "components": [
                {"sinaSymbol": "gb_msft", "weight": 0.2, "currency": "USD"},
                {"sinaSymbol": "gb_aapl", "weight": 0.31, "currency": "USD"},
            ],
        }

        signature = server.fund_estimate_input_signature("2026-06-30", cumulative)

        self.assertEqual(signature, server.fund_estimate_input_signature("2026-06-30", reordered))
        self.assertNotEqual(signature, server.fund_estimate_input_signature("2026-06-30", changed))
        self.assertNotEqual(signature, server.fund_estimate_input_signature("2026-03-31", cumulative))

    def test_fund_estimate_calibration_uses_recent_matching_complete_snapshots(self) -> None:
        rows = []
        start = date(2025, 1, 1)
        for index in range(130):
            target = (start + timedelta(days=index)).isoformat()
            raw_change = (index + 1) / 10
            actual_change = 0.1 + 1.2 * raw_change
            rows.append((
                "017436", target, "pending", server.FUND_ESTIMATE_MODEL_VERSION,
                "2024-12-31", 1.0, 1.0, raw_change, raw_change, raw_change,
                0.6, "sina-us", ".NDX", "CLOSED", 1, index,
                1.0, actual_change, raw_change - actual_change,
            ))
        rows.extend([
            (
                "017436", "2024-01-01", "pending", server.FUND_ESTIMATE_MODEL_VERSION,
                "2023-12-31", 1.0, 1.0, 10.0, 10.0, 10.0,
                0.6, "sina-us", ".INX", "CLOSED", 1, 1, 1.0, -10.0, 20.0,
            ),
            (
                "017436", "2025-01-01", "pending", "older-model",
                "2024-12-31", 1.0, 1.0, 10.0, 10.0, 10.0,
                0.6, "sina-us", ".NDX", "CLOSED", 1, 1, 1.0, -10.0, 20.0,
            ),
            (
                "017436", "2024-01-02", "pending", server.FUND_ESTIMATE_MODEL_VERSION,
                "2024-01-01", 1.0, 1.0, 10.0, 10.0, 10.0,
                0.6, "sina-us", ".NDX", "LIVE", 0, 1, 1.0, -10.0, 20.0,
            ),
            (
                "017436", "2026-01-01", "pending", server.FUND_ESTIMATE_MODEL_VERSION,
                "2024-12-31", 1.0, 1.0, 10.0, 10.0, 10.0,
                0.6, "sina-us", ".NDX", "CLOSED", 1, 1, 1.0, -10.0, 20.0,
            ),
            (
                "017436", "2026-01-02", "pending", server.FUND_ESTIMATE_MODEL_VERSION,
                "2024-12-31", 1.0, 1.0, 10.0, 10.0, 10.0,
                0.6, "sina-us", ".NDX", "CLOSED", 1, 1, 1.0, -10.0, 20.0,
            ),
            (
                "017436", "2026-01-03", "pending", server.FUND_ESTIMATE_MODEL_VERSION,
                "2024-12-31", 1.0, 1.0, 10.0, 10.0, 10.0,
                0.6, "sina-us", ".NDX", "CLOSED", 1, 1, 1.0, -10.0, 20.0,
            ),
        ])
        with sqlite3.connect(server.DB_PATH) as conn:
            conn.executemany(
                """
                INSERT INTO fund_estimate_snapshots(
                  code, target_date, estimate_kind, model_version,
                  base_nav_date, base_nav, estimated_nav, raw_change,
                  estimated_change, cumulative_change, coverage,
                  benchmark_source, benchmark_symbol, phase, complete, as_of,
                  actual_nav, actual_change, error
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )
            conn.execute(
                "UPDATE fund_estimate_snapshots SET estimate_model = 'other' WHERE target_date = '2026-01-01'"
            )
            conn.execute(
                "UPDATE fund_estimate_snapshots SET holding_report_date = '2025-03-31' WHERE target_date = '2026-01-02'"
            )
            conn.execute(
                "UPDATE fund_estimate_snapshots SET input_signature = 'other' WHERE target_date = '2026-01-03'"
            )

        calibration = server.fund_estimate_calibration(
            "017436",
            benchmark_source="sina-us",
            benchmark_symbol=".NDX",
            estimate_model="",
            holding_report_date="",
            input_signature="",
        )

        self.assertEqual(calibration["sampleCount"], server.FUND_ESTIMATE_CALIBRATION_MAX_SAMPLES)
        self.assertTrue(calibration["applied"])
        self.assertAlmostEqual(calibration["alpha"], 0.001)
        self.assertAlmostEqual(calibration["beta"], 1.2)

    def test_fund_estimate_calibration_keeps_coverage_fallback_samples_separate(self) -> None:
        rows = []
        start = date(2025, 1, 1)
        for index in range(40):
            target = (start + timedelta(days=index)).isoformat()
            raw_change = (index + 1) / 10
            actual_change = 0.1 + 1.2 * raw_change
            rows.append((
                "539002", target, "pending", server.FUND_ESTIMATE_MODEL_VERSION,
                "2024-12-31", 1.0, 1.0, raw_change, raw_change, raw_change,
                0.6, "", "", "CLOSED", 1, index,
                1.0, actual_change, raw_change - actual_change,
            ))
        with sqlite3.connect(server.DB_PATH) as conn:
            conn.executemany(
                """
                INSERT INTO fund_estimate_snapshots(
                  code, target_date, estimate_kind, model_version,
                  base_nav_date, base_nav, estimated_nav, raw_change,
                  estimated_change, cumulative_change, coverage,
                  benchmark_source, benchmark_symbol, phase, complete, as_of,
                  actual_nav, actual_change, error
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )

        fallback = server.fund_estimate_calibration(
            "539002",
            benchmark_source="",
            benchmark_symbol="",
            estimate_model="",
            holding_report_date="",
            input_signature="",
        )
        eem = server.fund_estimate_calibration(
            "539002",
            benchmark_source="sina-us",
            benchmark_symbol="EEM",
            estimate_model="",
            holding_report_date="",
            input_signature="",
        )

        self.assertEqual(fallback["sampleCount"], 40)
        self.assertTrue(fallback["applied"])
        self.assertEqual(eem, {
            "applied": False,
            "sampleCount": 0,
            "reason": "insufficientSamples",
        })

    def test_available_fund_estimates_reads_worker_snapshot(self) -> None:
        expected = {"code": "017436", "officialNavDate": "2026-07-30"}
        server.store_dashboard_snapshot(
            {"017436": expected},
            server.FUND_ESTIMATE_SNAPSHOT_NAME,
        )

        with patch.object(server, "build_fund_estimates", side_effect=AssertionError("must use snapshot")):
            payload = server.available_fund_estimates(["017436"])

        self.assertEqual(payload, {"017436": expected})

    def test_background_refresh_schedules_configured_work(self) -> None:
        with (
            patch.object(
                server,
                "refresh_latest_fund_history",
                return_value={"checked": 1, "updated": 0, "failed": 0, "errors": []},
            ) as fund_refresh,
            patch.object(server, "configured_market_return_items_from_constants", return_value=["sina-cn:sh000001"]),
            patch.object(server, "market_history_should_refresh_for_returns", return_value=True),
            patch.object(server, "schedule_market_history_refresh") as market_refresh,
            patch.object(server, "prewarm_response_cache") as prewarm,
            patch.object(server, "prewarm_fund_nav_cache_async") as nav_prewarm,
            patch.object(
                server,
                "refresh_latest_fund_holdings",
                return_value={"checked": 1, "updated": 0, "errors": []},
            ) as holdings_refresh,
            patch.object(server, "configured_sina_symbols_from_constants", return_value=[]),
        ):
            self.assertTrue(server.run_background_refresh_once())

        fund_refresh.assert_called_once_with()
        market_refresh.assert_called_once_with("sina-cn", "sh000001")
        prewarm.assert_called_once()
        nav_prewarm.assert_called_once()
        holdings_refresh.assert_called_once()
        self.assertGreater(server.background_refresh_state_snapshot()["runCount"], 0)

    def test_latest_fund_history_refresh_fetches_only_latest_rows(self) -> None:
        server.store_fund_history("017091", [{"FSRQ": "2026-07-30", "DWJZ": "2.7450", "JZZZL": "-1.0"}])
        rows = [
            {"FSRQ": "2026-07-31", "DWJZ": "2.7554", "JZZZL": "0.38"},
            {"FSRQ": "2026-07-30", "DWJZ": "2.7450", "JZZZL": "-1.0"},
        ]
        with server._RESPONSE_CACHE_GUARD:
            server._RESPONSE_CACHE["api:overview:test"] = (10**12, 200, "application/json", b"{}")
            server._RESPONSE_CACHE["api:fundreturns:test"] = (10**12, 200, "application/json", b"{}")

        with patch.object(server, "fetch_fund_history_page", return_value=(rows, 100)) as fetch:
            result = server.refresh_latest_fund_history(["017091"], max_workers=1)

        fetch.assert_called_once_with("017091", 1, 2, refresh=True)
        self.assertEqual(result["updated"], 1)
        self.assertEqual(result["failed"], 0)
        self.assertEqual(server.latest_fund_history_point("017091"), ("2026-07-31", 2.7554, 0.38))
        self.assertEqual(server.read_dashboard_snapshot(server.FUND_HISTORY_SYNC_SNAPSHOT_NAME)["updated"], 1)
        with server._RESPONSE_CACHE_GUARD:
            self.assertNotIn("api:overview:test", server._RESPONSE_CACHE)
            self.assertNotIn("api:fundreturns:test", server._RESPONSE_CACHE)

    def test_background_job_lease_allows_only_one_owner(self) -> None:
        self.assertTrue(server.claim_background_job("worker-a", lease_seconds=120, current_ms=1_000))
        self.assertFalse(server.claim_background_job("worker-b", lease_seconds=120, current_ms=2_000))
        self.assertTrue(server.claim_background_job("worker-a", lease_seconds=120, current_ms=2_000))
        self.assertTrue(server.release_background_job("worker-a"))
        self.assertTrue(server.claim_background_job("worker-b", lease_seconds=120, current_ms=3_000))
        self.assertFalse(server.release_background_job("worker-a"))
        self.assertTrue(server.release_background_job("worker-b"))
        self.assertTrue(server.claim_background_job("worker-b", lease_seconds=120, current_ms=123_000))

    def test_embedded_scheduler_is_disabled_by_default(self) -> None:
        with (
            patch.dict(os.environ, {}, clear=False),
            patch.object(server.threading, "Thread") as thread,
        ):
            os.environ.pop("FUND_VALUATION_BACKGROUND_REFRESH", None)
            server.start_background_refresh_scheduler()

        thread.assert_not_called()

    def test_sina_proxy_decodes_gb18030_fund_name(self) -> None:
        upstream_body = 'var hq_str_f_118001="易方达亚洲精选股票(QDII),1.693,1.693,1.673,2026-05-21,22.6875";'.encode("gb18030")

        with patch.object(server, "fetch_upstream", return_value=(200, "text/plain; charset=utf-8", upstream_body)):
            response = server.app.test_client().get("/api/sina?list=f_118001&refresh=1")

        self.assertEqual(response.status_code, 200)
        self.assertIn("charset=utf-8", response.content_type)
        self.assertIn("易方达亚洲精选股票(QDII)", response.get_data(as_text=True))
        self.assertNotIn("�", response.get_data(as_text=True))

    def test_naver_equity_adapter_normalizes_price_direction_and_beijing_time(self) -> None:
        payload = json.dumps({
            "stockNameEng": "SK Hynix",
            "closePrice": "350,500",
            "compareToPreviousClosePrice": "4,500",
            "fluctuationsRatio": "1.27",
            "compareToPreviousPrice": {"name": "FALLING"},
            "localTradedAt": "2026-07-31T15:30:00+09:00",
        }).encode()
        with patch.object(
            server,
            "fetch_upstream",
            return_value=(200, "application/json; charset=utf-8", payload),
        ) as fetch:
            line = server.naver_market_quote_line("kr000660")

        self.assertEqual(
            line,
            'var hq_str_kr000660="SK Hynix,350500.0000,-4500.0000,-1.2700,2026-07-31,14:30:00";',
        )
        self.assertIn("/api/stock/000660/basic", fetch.call_args.args[0])

    def test_naver_kospi_adapter_normalizes_index_quote_and_beijing_time(self) -> None:
        payload = json.dumps({
            "stockName": "코스피",
            "closePrice": "6,628.68",
            "compareToPreviousClosePrice": "269.73",
            "fluctuationsRatio": "4.24",
            "compareToPreviousPrice": {"name": "RISING"},
            "localTradedAt": "2026-08-05T09:22:00+09:00",
        }).encode()
        with patch.object(
            server,
            "fetch_upstream",
            return_value=(200, "application/json; charset=utf-8", payload),
        ) as fetch:
            line = server.naver_market_quote_line("b_KOSPI")

        self.assertEqual(
            line,
            'var hq_str_b_KOSPI="코스피,6628.6800,269.7300,4.2400,2026-08-05,08:22:00";',
        )
        self.assertIn("/api/index/KOSPI/basic", fetch.call_args.args[0])

    def test_market_quote_adapter_combines_sina_and_naver_lines(self) -> None:
        def fake_fetch(url: str, **_kwargs: object) -> tuple[int, str, bytes]:
            if "hq.sinajs.cn" in url:
                return 200, "text/plain", b'var hq_str_gb_nvda="NVIDIA,1,2";'
            return 200, "application/json", json.dumps({
                "stockNameEng": "Advantest",
                "closePrice": "19,320",
                "compareToPreviousClosePrice": "250",
                "fluctuationsRatio": "1.31",
                "compareToPreviousPrice": {"name": "RISING"},
                "localTradedAt": "2026-07-31T15:30:00+09:00",
            }).encode()

        with patch.object(server, "fetch_upstream", side_effect=fake_fetch):
            status, text = server.fetch_market_quote_text(["gb_nvda", "jp6857"])

        self.assertEqual(status, 200)
        self.assertIn("hq_str_gb_nvda", text)
        self.assertIn("hq_str_jp6857", text)
        self.assertIn("2026-07-31,14:30:00", text)

    def test_binance_bitcoin_adapter_uses_utc_daily_open_and_beijing_timestamp(self) -> None:
        payload = json.dumps([[1786060800000, "64323.61", "65390.99", "64166.00", "64948.00", "10.5", 1786147199999]])
        captured_at = int(datetime.fromisoformat("2026-08-07T23:15:00+08:00").timestamp() * 1000)

        line = server.parse_binance_bitcoin_quote_line(payload, captured_at)
        quote = server.normalize_quote_text(line or "", captured_at)["fx_sbtcusd"]

        self.assertIn("Binance BTCUSDT", line or "")
        self.assertAlmostEqual(quote["price"], 64948.0)
        self.assertAlmostEqual(quote["previousClose"], 64323.61)
        self.assertAlmostEqual(quote["changePercent"], (64948 / 64323.61 - 1) * 100, places=3)
        self.assertEqual(quote["time"], "2026-08-07 23:15:00")
        self.assertIsNone(server.parse_binance_bitcoin_quote_line(
            json.dumps([[1786060800000, "64323.61", "64000", "64166", "64948", "10.5", 1786147199999]]),
            captured_at,
        ))

    def test_market_quote_adapter_prefers_binance_and_falls_back_to_sina(self) -> None:
        binance = json.dumps([[1786060800000, "64323.61", "65390.99", "64166.00", "64948.00", "10.5", 1786147199999]]).encode()
        captured_at = int(datetime.fromisoformat("2026-08-07T23:15:00+08:00").timestamp() * 1000)
        with (
            patch.object(server, "now_ms", return_value=captured_at),
            patch.object(server, "fetch_upstream", return_value=(200, "application/json", binance)) as fetch,
        ):
            status, text = server.fetch_market_quote_text(["fx_sbtcusd"])

        self.assertEqual(status, 200)
        self.assertIn("64948.00000000", text)
        self.assertEqual(fetch.call_count, 1)
        self.assertIn("data-api.binance.vision", fetch.call_args.args[0])

        sina = (
            'var hq_str_fx_sbtcusd="23:15:00,65000,65000,64000,1,64000,66000,63000,'
            '65000,Bitcoin,1.00,650,1,Sina,0,0,,2026-08-07";'
        ).encode()
        with patch.object(server, "fetch_upstream", side_effect=[
            (599, "application/json", b""),
            (200, "text/plain", sina),
        ]):
            fallback_status, fallback_text = server.fetch_market_quote_text(["fx_sbtcusd"])

        self.assertEqual(fallback_status, 200)
        self.assertIn("65000", fallback_text)

    def test_market_quote_adapter_prefers_naver_kospi_and_keeps_sina_fallback(self) -> None:
        def fake_fetch(url: str, **_kwargs: object) -> tuple[int, str, bytes]:
            return 200, "application/json", json.dumps({
                "stockName": "코스피",
                "closePrice": "6,628.68",
                "compareToPreviousClosePrice": "269.73",
                "fluctuationsRatio": "4.24",
                "compareToPreviousPrice": {"name": "RISING"},
                "localTradedAt": "2026-08-05T09:22:00+09:00",
            }).encode()

        with patch.object(server, "fetch_upstream", side_effect=fake_fetch):
            status, text = server.fetch_market_quote_text(["b_KOSPI"])

        self.assertEqual(status, 200)
        self.assertEqual(text.count("hq_str_b_KOSPI"), 1)
        self.assertIn("6628.6800", text)
        self.assertIn("2026-08-05,08:22:00", text)

        with patch.object(server, "fetch_upstream", side_effect=[
            (599, "application/json", b""),
            (200, "text/plain", (
                'var hq_str_b_KOSPI="韩国KOSPI指数,6358.95,0,0,2:27 AM,14:27:00,'
                '2026-08-04,14:30:00,6358.95,6358.95";'
            ).encode()),
        ]):
            _status, fallback_text = server.fetch_market_quote_text(["b_KOSPI"])

        self.assertIn("2026-08-04,14:30:00", fallback_text)

    def test_japanese_and_korean_holding_symbols_are_classified_for_quotes(self) -> None:
        self.assertEqual(
            server.classify_holding_symbol("005930", "", "三星电子"),
            ("kr", "kr005930", "KRW"),
        )
        self.assertEqual(
            server.classify_holding_symbol("6857", "", "ADVANTEST"),
            ("jp", "jp6857", "JPY"),
        )
        self.assertEqual(
            server.classify_holding_symbol("JP3236330001", "", "KIOXIA HOLDINGS"),
            ("jp", "jp285A", "JPY"),
        )
        self.assertEqual(
            server.classify_holding_symbol("JP3684400009", "", "NITTO BOSEKI"),
            ("jp", "jp3110", "JPY"),
        )

    def test_naver_equity_history_uses_supported_page_size_and_parses_rows(self) -> None:
        target = server.stock_history_url("jp6857")
        self.assertIsNotNone(target)
        assert target is not None
        self.assertIn("pageSize=60", target[0])
        rows = server.parse_stock_history_rows("jp6857", json.dumps([
            {"localTradedAt": "2026-07-31T15:00:00+09:00", "closePrice": "19,320"},
            {"localTradedAt": "2026-07-30T15:00:00+09:00", "closePrice": "19,570"},
        ]))
        self.assertEqual(rows, [
            {"date": "2026-07-31", "close": 19320.0},
            {"date": "2026-07-30", "close": 19570.0},
        ])

    def test_tencent_hk_equity_history_parses_adjusted_daily_rows(self) -> None:
        rows = server.parse_stock_history_rows("hk00522", json.dumps({
            "code": 0,
            "data": {
                "hk00522": {
                    "qfqday": [
                        ["2026-07-31", "155.300", "151.300", "165.000", "149.100", "6786319"],
                        ["2026-08-03", "147.600", "150.300", "151.900", "147.000", "2041281"],
                    ],
                },
            },
        }))

        self.assertEqual(rows, [
            {"date": "2026-07-31", "close": 151.3},
            {"date": "2026-08-03", "close": 150.3},
        ])

    def test_hk_stock_history_falls_back_to_tencent_when_sina_has_no_rows(self) -> None:
        tencent_payload = json.dumps({
            "code": 0,
            "data": {
                "hk00522": {
                    "day": [
                        ["2026-07-31", "155.300", "151.300", "165.000", "149.100", "6786319"],
                        ["2026-08-03", "147.600", "150.300", "151.900", "147.000", "2041281"],
                    ],
                },
            },
        }).encode()
        calls: list[tuple[str, str]] = []

        def fake_fetch(url: str, **kwargs: object) -> tuple[int, str, bytes]:
            calls.append((url, str(kwargs.get("cache_key") or "")))
            if "fqkline" in url:
                return 200, "application/json; charset=utf-8", tencent_payload
            return 200, "application/javascript; charset=utf-8", (
                b'var _=({"__ERROR":3,"__ERRORMSG":"Service not valid"});'
            )

        with patch.object(server, "fetch_upstream", side_effect=fake_fetch):
            updated = server.fetch_and_store_stock_history("hk00522", refresh=True)

        self.assertTrue(updated)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1][1], "stockhistory-fallback:tencent:hk00522")
        with sqlite3.connect(server.DB_PATH) as conn:
            rows = conn.execute(
                "SELECT date,close FROM stock_daily_history WHERE sina_symbol=? ORDER BY date",
                ("hk00522",),
            ).fetchall()
        self.assertEqual(rows, [("2026-07-31", 151.3), ("2026-08-03", 150.3)])
        health = server.upstream_health_snapshot()
        self.assertEqual(health["fallbackCount"], 1)
        self.assertIn("Tencent daily history", health["issues"][0]["error"])

    def test_hk_stock_history_does_not_fetch_fallback_when_sina_is_valid(self) -> None:
        sina_payload = b'var _=([{"d":"2026-08-03","c":"150.300"}]);'
        with patch.object(
            server,
            "fetch_upstream",
            return_value=(200, "application/javascript; charset=utf-8", sina_payload),
        ) as fetch:
            updated = server.fetch_and_store_stock_history("hk00522", refresh=True)

        self.assertTrue(updated)
        fetch.assert_called_once()

    def test_dashboard_aggregates_market_snapshot_and_uses_cache(self) -> None:
        quote_body = 'var hq_str_s_sh000001="上证指数,3000,10,0.33";'.encode("gb18030")
        fx_body = 'var hq_str_fx_susdcny="美元人民币,7.1000,0,0,0,0,0,0,0,09:30:00,0.12,2026-06-12";'.encode("gb18030")
        calls: list[str] = []

        def fake_fetch(url: str, **_kwargs: object) -> tuple[int, str, bytes]:
            calls.append(url)
            if "fx_susdcny" in url:
                return 200, "text/plain; charset=utf-8", fx_body
            return 200, "text/plain; charset=utf-8", quote_body

        with patch.object(server, "fetch_upstream", side_effect=fake_fetch):
            snapshot = server.build_dashboard_payload(
                ["s_sh000001"], ["USD"], "2026-05-26T10:00:00+08:00", allow_upstream=True
            )
            server.store_dashboard_snapshot(snapshot)

        client = server.app.test_client()
        url = "/api/dashboard?symbols=s_sh000001&currencies=USD"
        with patch.object(server, "fetch_upstream", side_effect=AssertionError("request path must not fetch upstream")):
            first = client.get(url)
            second = client.get(url)
            refreshed = client.get(f"{url}&refresh=1")

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        payload = first.get_json()
        self.assertEqual(payload["schemaVersion"], 1)
        self.assertIn("上证指数", payload["quotesText"])
        self.assertAlmostEqual(payload["quotes"]["s_sh000001"]["price"], 3000.0)
        self.assertAlmostEqual(payload["quotes"]["s_sh000001"]["changePercent"], 0.33)
        self.assertIn("美元人民币", payload["fxText"])
        self.assertEqual(payload["marketStates"]["s_sh000001"]["state"], "live")
        self.assertEqual(first.headers.get("X-Cache"), "MISS")
        self.assertEqual(second.headers.get("X-Cache"), "HIT")
        self.assertEqual(refreshed.status_code, 200)
        self.assertEqual(refreshed.headers.get("Cache-Control"), "no-store")
        self.assertIsNone(refreshed.headers.get("X-Cache"))
        self.assertEqual(len(calls), 2)

    def test_legacy_fund_backtest_endpoint_is_removed(self) -> None:
        response = server.app.test_client().get("/api/fundbacktest?codes=016664")

        self.assertEqual(response.status_code, 404)

    def test_overview_aggregates_market_fx_and_fund_summary(self) -> None:
        server.store_fund_history(
            "016664",
            [
                {"FSRQ": "2026-05-21", "DWJZ": "3.0848", "JZZZL": "-0.83"},
                {"FSRQ": "2026-05-20", "DWJZ": "3.1106", "JZZZL": "-0.28"},
            ],
        )
        quote_body = 'var hq_str_s_sh000001="上证指数,3000,10,0.33";'.encode("gb18030")
        fx_body = 'var hq_str_fx_susdcny="美元人民币,7.1000,0,0,0,0,0,0,0,09:30:00,0.12,2026-06-12";'.encode("gb18030")

        def fake_fetch(url: str, **_kwargs: object) -> tuple[int, str, bytes]:
            if "fx_susdcny" in url:
                return 200, "text/plain; charset=utf-8", fx_body
            return 200, "text/plain; charset=utf-8", quote_body

        with patch.object(server, "fetch_upstream", side_effect=fake_fetch):
            snapshot = server.build_dashboard_payload(
                ["s_sh000001"], ["USD"], "2026-05-26T10:00:00+08:00", allow_upstream=True
            )
            server.store_dashboard_snapshot(snapshot)

        with patch.object(server, "fetch_upstream", side_effect=AssertionError("request path must not fetch upstream")):
            response = server.app.test_client().get(
                "/api/overview?symbols=s_sh000001&currencies=USD&fundCodes=016664"
            )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertIn("上证指数", payload["quotesText"])
        self.assertIn("美元人民币", payload["fxText"])
        self.assertEqual(payload["marketStates"]["s_sh000001"]["state"], "live")
        self.assertEqual(payload["fundSummaries"]["016664"]["navDate"], "2026-05-21")
        self.assertAlmostEqual(payload["fundSummaries"]["016664"]["officialChange"], -0.83, places=2)

    def test_sina_proxy_replaces_bad_nikkei_with_eastmoney_spot_quote(self) -> None:
        sina_body = (
            'var hq_str_b_TWSE="台湾台北指数,25580.32,-443.53,-1.70,9/26/2025,2025-09-26";\n'
            'var hq_str_int_nikkei="日经指数,44946.64,-408.35,-0.90";\n'
        ).encode("gb18030")
        timestamp = int(datetime(2026, 6, 24, 10, 30, 0, tzinfo=ZoneInfo("Asia/Shanghai")).timestamp())

        def fake_fetch(url: str, **_kwargs: object) -> tuple[int, str, bytes]:
            return 200, "text/plain; charset=utf-8", sina_body

        def fake_eastmoney(url: str, **_kwargs: object) -> dict[str, object] | None:
            self.assertIn("100.N225", url)
            return {"data": {"f43": 6940450, "f169": 8700, "f170": 13, "f86": timestamp, "f58": "日经225"}}

        with (
            patch.object(server, "fetch_upstream", side_effect=fake_fetch),
            patch.object(server, "fetch_eastmoney_json", side_effect=fake_eastmoney) as eastmoney,
            patch.object(server, "expected_quote_date_for_symbol", return_value="2026-06-24"),
        ):
            response = server.app.test_client().get("/api/sina?list=int_nikkei,b_TWSE&refresh=1")

        text = response.get_data(as_text=True)
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("44946.64", text)
        self.assertIn('var hq_str_int_nikkei="日经225,69404.50,87.00,0.13,2026-06-24,10:30:00";', text)
        eastmoney.assert_called_once()

    def test_sina_proxy_drops_bad_nikkei_when_eastmoney_spot_unavailable(self) -> None:
        sina_body = 'var hq_str_int_nikkei="日经指数,44946.64,-408.35,-0.90";\n'.encode("gb18030")

        with (
            patch.object(server, "fetch_upstream", return_value=(200, "text/plain; charset=utf-8", sina_body)),
            patch.object(server, "fetch_eastmoney_json", return_value=None),
        ):
            response = server.app.test_client().get("/api/sina?list=int_nikkei&refresh=1")

        text = response.get_data(as_text=True)
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("int_nikkei", text)

    def test_sina_proxy_uses_sina_world_index_fallback_for_nikkei(self) -> None:
        stale_body = 'var hq_str_int_nikkei="日经指数,44946.64,-408.35,-0.90";\n'.encode("gb18030")
        fallback_body = (
            'var hq_str_znb_NKY="日经225,69174.7500,-613.63,-0.88,2:12 AM,1759126320,'
            '2026-06-24,14:30:01,69615.0800,69788.3800,70218.7100,68461.1000,0";\n'
        ).encode("gb18030")

        def fake_fetch(url: str, **_kwargs: object) -> tuple[int, str, bytes]:
            if "znb_NKY" in url:
                return 200, "text/plain; charset=gb18030", fallback_body
            return 200, "text/plain; charset=gb18030", stale_body

        with (
            patch.object(server, "fetch_upstream", side_effect=fake_fetch),
            patch.object(server, "fetch_eastmoney_json", return_value=None),
            patch.object(server, "expected_quote_date_for_symbol", return_value="2026-06-24"),
        ):
            response = server.app.test_client().get("/api/sina?list=int_nikkei&refresh=1")

        text = response.get_data(as_text=True)
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("44946.64", text)
        self.assertIn('var hq_str_int_nikkei="日经225,69174.75,-613.63,-0.88,2026-06-24,14:30:01";', text)

    def test_sina_proxy_uses_sina_world_index_fallback_for_taiwan(self) -> None:
        stale_body = (
            'var hq_str_b_TWSE="台湾台北指数,25580.32,-443.53,-1.70,9/26/2025,2025-09-26";\n'
        ).encode("gb18030")
        fallback_body = (
            'var hq_str_znb_TWJQ="台湾加权指数,46465.1992,587.81,1.28,,,2026-06-19,15:21:45,'
            '45972.2578,45877.3906,46565.6992,45972.2578,16336543744";\n'
        ).encode("gb18030")

        def fake_fetch(url: str, **_kwargs: object) -> tuple[int, str, bytes]:
            if "znb_TWJQ" in url:
                return 200, "text/plain; charset=gb18030", fallback_body
            return 200, "text/plain; charset=gb18030", stale_body

        with (
            patch.object(server, "fetch_upstream", side_effect=fake_fetch),
            patch.object(server, "fetch_eastmoney_json", return_value=None),
            patch.object(server, "quote_date_is_usable", return_value=True),
        ):
            response = server.app.test_client().get("/api/sina?list=b_TWSE&refresh=1")

        text = response.get_data(as_text=True)
        self.assertEqual(response.status_code, 200)
        self.assertIn('var hq_str_b_TWSE="台湾加权,46465.20,587.81,1.28,2026-06-19,15:21:45";', text)

    def test_sina_proxy_drops_stale_taiwan_when_fallback_unavailable(self) -> None:
        stale_body = (
            'var hq_str_b_TWSE="台湾台北指数,25580.32,-443.53,-1.70,9/26/2025,2025-09-26";\n'
        ).encode("gb18030")

        with (
            patch.object(server, "fetch_upstream", return_value=(200, "text/plain; charset=gb18030", stale_body)),
            patch.object(server, "fetch_eastmoney_json", return_value=None),
        ):
            response = server.app.test_client().get("/api/sina?list=b_TWSE&refresh=1")

        text = response.get_data(as_text=True)
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("b_TWSE", text)
        self.assertNotIn("25580.32", text)

    def test_eastmoney_global_quote_falls_back_to_latest_daily_kline(self) -> None:
        latest_date = datetime.now(ZoneInfo("Asia/Shanghai")).date()
        previous_date = latest_date - timedelta(days=1)
        kline_payload = {
            "data": {
                "name": "日经225",
                "klines": [
                    f"{previous_date.isoformat()},66783.22,69317.50,69682.23,66783.22,0,0.00,4.39,4.99,3297.46,0.00",
                    f"{latest_date.isoformat()},69288.91,69404.50,70020.68,69095.67,0,0.00,1.33,0.13,87.00,0.00",
                ],
            }
        }

        def fake_eastmoney(url: str, **_kwargs: object) -> dict[str, object] | None:
            if "stock/get" in url:
                return None
            return kline_payload

        with patch.object(server, "fetch_eastmoney_json", side_effect=fake_eastmoney):
            line = server.eastmoney_global_quote_line("int_nikkei")

        self.assertEqual(
            line,
            f'var hq_str_int_nikkei="日经225,69404.50,87.00,0.13,{latest_date.isoformat()}";',
        )

    def test_fund_api_rejects_invalid_codes_before_upstream_fetch(self) -> None:
        with patch.object(server, "fetch_upstream") as fetch:
            response = server.app.test_client().get("/api/fundnav?codes=016664,abc123")

        self.assertEqual(response.status_code, 400)
        self.assertIn("Invalid fund code", response.get_data(as_text=True))
        fetch.assert_not_called()

    def test_fund_api_limits_code_count(self) -> None:
        codes = ",".join(f"{100000 + index:06d}" for index in range(server.MAX_FUND_CODES_PER_REQUEST + 1))

        response = server.app.test_client().get(f"/api/fundreturns?codes={codes}")

        self.assertEqual(response.status_code, 400)
        self.assertIn("Too many fund codes", response.get_data(as_text=True))

    def test_disabled_fund_management_rejects_non_configured_codes(self) -> None:
        configured_code = server.configured_fund_codes_from_constants()[0]
        with patch.dict(os.environ, {"FUND_VALUATION_ENABLE_FUND_MANAGEMENT": "0"}):
            configured_response = server.app.test_client().get(f"/api/fundreturns?codes={configured_code}")
            custom_response = server.app.test_client().get("/api/fundreturns?codes=118001")

        self.assertEqual(configured_response.status_code, 200)
        self.assertEqual(custom_response.status_code, 403)
        self.assertIn("Fund management is disabled", custom_response.get_data(as_text=True))

    def test_token_protected_fund_management_allows_only_authorized_custom_codes(self) -> None:
        configured_code = server.configured_fund_codes_from_constants()[0]
        client = server.app.test_client()
        with patch.dict(os.environ, {
            "FUND_VALUATION_ENABLE_FUND_MANAGEMENT": "1",
            "FUND_VALUATION_FUND_MANAGEMENT_TOKEN": "management-secret",
        }):
            configured_response = client.get(f"/api/fundreturns?codes={configured_code}")
            denied = client.get("/api/fundreturns?codes=118001")
            wrong = client.get(
                "/api/fundreturns?codes=118001",
                headers={"X-Fund-Management-Token": "wrong"},
            )
            allowed = client.get(
                "/api/fundreturns?codes=118001",
                headers={"X-Fund-Management-Token": "management-secret"},
            )

        self.assertEqual(configured_response.status_code, 200)
        self.assertEqual(denied.status_code, 403)
        self.assertEqual(wrong.status_code, 403)
        self.assertEqual(allowed.status_code, 200)

    def test_fund_management_verification_and_sina_fund_fallback_require_token(self) -> None:
        client = server.app.test_client()
        upstream_body = b'var hq_str_f_118001="fund,1.0,1.0,1.0,2026-05-21,0";'
        with (
            patch.dict(os.environ, {
                "FUND_VALUATION_ENABLE_FUND_MANAGEMENT": "1",
                "FUND_VALUATION_FUND_MANAGEMENT_TOKEN": "management-secret",
            }),
            patch.object(
                server,
                "fetch_upstream",
                return_value=(200, "text/plain; charset=utf-8", upstream_body),
            ) as fetch,
        ):
            denied_verify = client.post("/api/fund-management/verify")
            allowed_verify = client.post(
                "/api/fund-management/verify",
                headers={"X-Fund-Management-Token": "management-secret"},
            )
            denied_quote = client.get("/api/sina?list=f_118001&refresh=1")
            invalid_quote = client.get(
                "/api/sina?list=f_abcdef&refresh=1",
                headers={"X-Fund-Management-Token": "management-secret"},
            )
            allowed_quote = client.get(
                "/api/sina?list=f_118001&refresh=1",
                headers={"X-Fund-Management-Token": "management-secret"},
            )

        self.assertEqual(denied_verify.status_code, 403)
        self.assertEqual(allowed_verify.get_json(), {"mode": "token", "ok": True})
        self.assertEqual(denied_quote.status_code, 403)
        self.assertEqual(invalid_quote.status_code, 400)
        self.assertEqual(allowed_quote.status_code, 200)
        fetch.assert_called_once()

    def test_fund_api_rate_limits_by_client(self) -> None:
        body = b'jsonpgz({"fundcode":"016664","name":"test"});'

        with patch.dict(server.RATE_LIMIT_RULES, {"fundnav": (1, 60)}):
            with patch.object(server, "fetch_upstream", return_value=(200, "text/plain; charset=utf-8", body)):
                client = server.app.test_client()
                first = client.get("/api/fundnav?codes=016664")
                second = client.get("/api/fundnav?codes=016664")

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 429)

    def test_fund_nav_returns_stale_cache_without_request_refresh(self) -> None:
        body = b'jsonpgz({"fundcode":"016664","name":"test","dwjz":"1.0000","jzrq":"2026-05-21"});'
        server.cache_put(
            "fundnav:016664",
            "https://fundgz.1234567.com.cn/js/016664.js",
            200,
            "text/plain; charset=utf-8",
            body,
        )
        with sqlite3.connect(server.DB_PATH) as conn:
            conn.execute(
                "UPDATE response_cache SET fetched_at = ? WHERE cache_key = ?",
                (server.now_ms() - (server.FUND_NAV_CACHE_TTL_SECONDS + 1) * 1000, "fundnav:016664"),
            )

        with (
            patch.object(server, "fetch_upstream", side_effect=AssertionError("unexpected upstream fetch")),
            patch.object(server, "schedule_fund_nav_refresh") as schedule_refresh,
        ):
            response = server.app.test_client().get("/api/fundnav?codes=016664")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers.get("X-Cache"), "STALE")
        self.assertEqual(response.get_json()["016664"]["fundcode"], "016664")
        schedule_refresh.assert_not_called()

    def test_fund_nav_returns_partial_cache_without_blocking_on_missing_code(self) -> None:
        body = b'jsonpgz({"fundcode":"016664","name":"test","dwjz":"1.0000","jzrq":"2026-05-21"});'
        server.cache_put(
            "fundnav:016664",
            "https://fundgz.1234567.com.cn/js/016664.js",
            200,
            "text/plain; charset=utf-8",
            body,
        )

        with (
            patch.object(server, "fetch_fund_nav_payload", side_effect=AssertionError("unexpected blocking fetch")),
            patch.object(server, "schedule_fund_nav_refresh") as schedule_refresh,
        ):
            response = server.app.test_client().get("/api/fundnav?codes=016664,118001")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers.get("X-Cache"), "STALE")
        self.assertEqual(set(response.get_json()), {"016664"})
        schedule_refresh.assert_not_called()

    def test_fund_nav_uses_persisted_history_without_blocking_fetch(self) -> None:
        fetched_at = server.now_ms()
        with sqlite3.connect(server.DB_PATH) as conn:
            conn.executemany(
                "INSERT INTO fund_nav_history(code, date, nav, change_percent, fetched_at) VALUES (?, ?, ?, ?, ?)",
                [
                    ("016664", "2026-05-21", 1.2345, 1.2, fetched_at),
                    ("016664", "2026-05-20", 1.2199, -0.3, fetched_at),
                ],
            )

        with (
            patch.object(server, "fetch_fund_nav_payload", side_effect=AssertionError("unexpected blocking fetch")),
            patch.object(server, "schedule_fund_nav_refresh") as schedule_refresh,
        ):
            response = server.app.test_client().get("/api/fundnav?codes=016664")

        payload = response.get_json()["016664"]
        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["jzrq"], "2026-05-21")
        self.assertEqual(payload["dwjz"], "1.2345")
        self.assertEqual(payload["gsz"], "")
        schedule_refresh.assert_not_called()

    def test_fund_nav_does_not_repeat_recent_empty_upstream_attempt(self) -> None:
        server.cache_put(
            "fundnav:016664",
            "https://fundgz.1234567.com.cn/js/016664.js",
            200,
            "text/plain; charset=utf-8",
            b"jsonpgz();",
        )
        fetched_at = server.now_ms()
        with sqlite3.connect(server.DB_PATH) as conn:
            conn.executemany(
                "INSERT INTO fund_nav_history(code, date, nav, change_percent, fetched_at) VALUES (?, ?, ?, ?, ?)",
                [
                    ("016664", "2026-05-21", 1.2345, 1.2, fetched_at),
                    ("016664", "2026-05-20", 1.2199, -0.3, fetched_at),
                ],
            )

        with patch.object(server, "schedule_fund_nav_refresh") as schedule_refresh:
            response = server.app.test_client().get("/api/fundnav?codes=016664")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["016664"]["dwjz"], "1.2345")
        schedule_refresh.assert_not_called()

    def test_prewarm_fund_nav_cache_async_schedules_default_funds(self) -> None:
        with (
            patch.object(server, "configured_fund_codes_from_constants", return_value=["016664", "118001"]),
            patch.object(server, "schedule_fund_nav_refresh") as schedule_refresh,
        ):
            server.prewarm_fund_nav_cache_async()

        schedule_refresh.assert_called_once_with(["016664", "118001"])

    def test_fund_purchase_returns_partial_stale_cache_without_request_refresh(self) -> None:
        with sqlite3.connect(server.DB_PATH) as conn:
            conn.execute(
                """
                INSERT INTO fund_purchase_status(
                  code, name, fund_type, nav_date, purchase_status, redeem_status,
                  next_open_date, min_purchase, daily_limit, fee_rate, fetched_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "016664", "test", "QDII", "2026-05-21", "开放申购", "开放赎回",
                    "", "10", "1000", "0.10%", server.now_ms() - 7 * 60 * 60 * 1000,
                ),
            )

        with (
            patch.object(server, "fetch_and_store_purchase_status", side_effect=AssertionError("unexpected blocking fetch")),
            patch.object(server, "schedule_purchase_status_refresh") as schedule_refresh,
        ):
            response = server.app.test_client().get("/api/fundpurchase?codes=016664,118001")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers.get("X-Cache"), "STALE")
        self.assertEqual(set(response.get_json()), {"016664"})
        schedule_refresh.assert_not_called()

    def test_prewarm_purchase_status_skips_fresh_complete_cache(self) -> None:
        with (
            patch.object(server, "configured_fund_codes_from_constants", return_value=["016664"]),
            patch.object(server, "read_purchase_status_from_db", return_value={"016664": {}}),
            patch.object(server, "fetch_and_store_purchase_status") as fetch_purchase,
        ):
            server.prewarm_purchase_status_cache()

        fetch_purchase.assert_not_called()

    def test_fund_history_refresh_caps_upstream_target_count(self) -> None:
        with patch.object(server, "fetch_and_store_fund_history") as fetch_history:
            response = server.app.test_client().get(
                "/api/fundhistory?codes=016664&pageSize=5000&pageIndex=100000&refresh=1"
            )

        self.assertEqual(response.status_code, 200)
        fetch_history.assert_called_once_with(
            "016664",
            server.MAX_FUND_HISTORY_REFRESH_ROWS,
            refresh=True,
        )

    def test_market_states_marks_known_holidays(self) -> None:
        self.assertNotEqual(server.HOLIDAYS_FILE.parent, server.DATA_DIR)
        response = server.app.test_client().get(
            "/api/marketstates?symbols=hkHSI,b_KOSPI,s_sh000001&now=2026-05-25T13:00:00%2B08:00"
        )

        self.assertEqual(response.status_code, 200)
        self.assertIn("X-Elapsed-ms", response.headers)
        payload = response.get_json()
        self.assertEqual(payload["hkHSI"]["state"], "holiday")
        self.assertEqual(payload["b_KOSPI"]["state"], "holiday")
        self.assertEqual(payload["s_sh000001"]["state"], "live")

    def test_calendar_reseed_applies_holiday_corrections_to_existing_database(self) -> None:
        with sqlite3.connect(server.DB_PATH) as conn:
            conn.execute(
                """
                INSERT INTO market_calendar(market, date, status, sessions, timezone, source, fetched_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                ("kr", "2026-07-17", "open", '[["09:00", "15:30"]]', "Asia/Seoul", "stale", 1),
            )

        server.ensure_market_calendar_seeded(2026)
        state = server.market_state_for_symbol(
            "b_KOSPI",
            datetime.fromisoformat("2026-07-17T10:00:00+08:00"),
        )

        self.assertEqual(state["state"], "holiday")
        self.assertEqual(state["lastTradingDay"], "2026-07-16")

    def test_korea_holiday_status_uses_beijing_date_during_midnight_rollover(self) -> None:
        server.ensure_market_calendar_seeded(2026)

        state = server.market_state_for_symbol(
            "b_KOSPI",
            datetime.fromisoformat("2026-07-17T23:30:00+08:00"),
        )

        self.assertEqual(state["date"], "2026-07-17")
        self.assertEqual(state["state"], "holiday")

    def test_market_states_uses_response_cache(self) -> None:
        client = server.app.test_client()
        url = "/api/marketstates?symbols=s_sh000001,sh600519&now=2026-05-26T12:00:00%2B08:00"

        first = client.get(url)
        second = client.get(url)

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(first.headers.get("X-Cache"), "MISS")
        self.assertEqual(second.headers.get("X-Cache"), "HIT")

    def test_prewarm_response_cache_primes_fund_returns(self) -> None:
        codes = server.configured_fund_codes_from_constants()
        self.assertGreater(len(codes), 0)
        code = codes[0]
        with sqlite3.connect(server.DB_PATH) as conn:
            conn.executemany(
                """
                INSERT INTO fund_nav_history(code, date, nav, change_percent, fetched_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                [
                    (code, "2026-01-02", 1.0, 0.0, 1),
                    (code, "2026-06-01", 1.2, 1.0, 1),
                ],
            )

        with server.app.app_context():
            server.prewarm_response_cache()

        response = server.app.test_client().get(f"/api/fundreturns?codes={','.join(codes)}")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers.get("X-Cache"), "HIT")
        self.assertIn(code, response.get_json())

    def test_market_states_marks_weekend_separately(self) -> None:
        response = server.app.test_client().get(
            "/api/marketstates?symbols=s_sh000001&now=2026-05-23T10:00:00%2B08:00"
        )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["s_sh000001"]["state"], "weekend")

    def test_market_states_marks_lunch_break_separately(self) -> None:
        response = server.app.test_client().get(
            "/api/marketstates?symbols=s_sh000001,sh600519&now=2026-05-26T12:00:00%2B08:00"
        )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["s_sh000001"]["state"], "break")
        self.assertEqual(payload["sh600519"]["state"], "break")

    def test_market_state_session_matrix(self) -> None:
        server.ensure_market_calendar_seeded()
        cases = [
            ("sh000001", "2026-05-26T10:00:00+08:00", "live"),
            ("sh000001", "2026-05-26T12:00:00+08:00", "break"),
            ("sh000001", "2026-05-26T15:30:00+08:00", "closed"),
            ("hkHSI", "2026-05-26T12:30:00+08:00", "break"),
            ("int_nikkei", "2026-05-26T11:00:00+08:00", "break"),
            ("b_KOSPI", "2026-05-26T10:00:00+08:00", "live"),
            ("b_TWSE", "2026-05-26T10:00:00+08:00", "live"),
            ("gb_inx", "2026-06-15T22:00:00+08:00", "live"),
            ("gb_inx", "2026-06-15T21:00:00+08:00", "closed"),
            ("hf_NQ", "2026-06-15T18:00:00+08:00", "live"),
            ("fx_sbtcusd", "2026-05-24T10:00:00+08:00", "live"),
        ]
        for symbol, raw_now, expected in cases:
            with self.subTest(symbol=symbol, now=raw_now):
                state = server.market_state_for_symbol(symbol, datetime.fromisoformat(raw_now))
                self.assertEqual(state["state"], expected)

    def test_live_quote_snapshot_expires_faster_than_closed_snapshot(self) -> None:
        now = datetime.now(ZoneInfo("Asia/Shanghai"))
        line = (
            'var hq_str_sh000001="上证指数,4000.0000,3990.0000,4010.0000,4010.0000,3990.0000,'
            '0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2026-06-29,09:41:00,00";'
        )
        states = {"sh000001": {"state": "live", "lastTradingDay": "2026-06-29"}}
        server.store_quote_snapshots(line, line, ["sh000001"], states, now)
        with sqlite3.connect(server.DB_PATH) as conn:
            raw_line, sanitized_line = conn.execute(
                "SELECT raw_line, sanitized_line FROM market_quote_snapshots WHERE symbol = ?",
                ("sh000001",),
            ).fetchone()
            self.assertEqual(raw_line, "")
            self.assertEqual(sanitized_line, line)
            conn.execute(
                "UPDATE market_quote_snapshots SET captured_at = ? WHERE symbol = ?",
                (server.now_ms() - 3 * 60 * 1000, "sh000001"),
            )

        live_text, live_missing = server.read_latest_quote_snapshot_text(
            ["sh000001"], max_age_by_symbol={"sh000001": 2 * 60},
        )
        closed_text, closed_missing = server.read_latest_quote_snapshot_text(
            ["sh000001"], max_age_by_symbol={"sh000001": 20 * 60},
        )

        self.assertEqual(live_text, "")
        self.assertEqual(live_missing, ["sh000001"])
        self.assertIn("sh000001", closed_text)
        self.assertEqual(closed_missing, [])

    def test_asia_quote_date_accepts_previous_close_after_market_opens(self) -> None:
        server.ensure_market_calendar_seeded(2026)
        monday_open = datetime.fromisoformat("2026-06-29T08:05:00+08:00")

        self.assertTrue(server.quote_date_is_usable("int_nikkei", "2026-06-26", monday_open))
        self.assertTrue(server.quote_date_is_usable("b_KOSPI", "2026-06-26", monday_open))
        self.assertFalse(server.quote_date_is_usable("int_nikkei", "2026-06-25", monday_open))

    def test_quote_snapshots_are_bucketed_and_record_normalization(self) -> None:
        now = datetime.fromisoformat("2026-05-26T09:10:00+08:00")
        raw = (
            'var hq_str_sh000001="上证指数,4000.0000,4000.0000,4010.0000,4010.0000,3990.0000,'
            '0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2026-05-26,09:10:00,00";'
        )
        normalized = raw.replace("4010.0000", "4000.0000")
        states = {"sh000001": {"state": "closed", "lastTradingDay": "2026-05-25"}}

        server.store_quote_snapshots(raw, normalized, ["sh000001"], states, now)
        server.store_quote_snapshots(raw, normalized, ["sh000001"], states, now)

        with sqlite3.connect(server.DB_PATH) as conn:
            rows = conn.execute(
                "SELECT source, validation_status, raw_line FROM market_quote_snapshots WHERE symbol = ?",
                ("sh000001",),
            ).fetchall()
        self.assertEqual(rows, [("normalized", "ok", raw)])
        self.assertEqual(server.prune_quote_snapshots(retention_days=1), 1)

    def test_snapshot_reader_rejects_expired_rows(self) -> None:
        now = datetime.fromisoformat("2026-05-26T10:00:00+08:00")
        line = (
            'var hq_str_sh000001="上证指数,4000.0000,3990.0000,4010.0000,4010.0000,3990.0000,'
            '0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2026-05-26,10:00:00,00";'
        )
        server.store_quote_snapshots(
            line,
            line,
            ["sh000001"],
            {"sh000001": {"state": "live", "lastTradingDay": "2026-05-26"}},
            now,
        )

        text, missing = server.read_latest_quote_snapshot_text(["sh000001"], max_age_seconds=60)

        self.assertEqual(text, "")
        self.assertEqual(missing, ["sh000001"])

    def test_dashboard_and_sina_read_fresh_worker_snapshot_without_upstream(self) -> None:
        now = datetime.now(ZoneInfo("Asia/Shanghai"))
        day = now.strftime("%Y-%m-%d")
        line = (
            f'var hq_str_sh000001="上证指数,4000.0000,3990.0000,4010.0000,4010.0000,3990.0000,'
            f'0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,{day},10:00:00,00";'
        )
        state = server.market_state_for_symbol("sh000001", now)
        server.store_quote_snapshots(line, line, ["sh000001"], {"sh000001": state}, now)

        with patch.object(server, "fetch_upstream") as fetch:
            dashboard = server.app.test_client().get("/api/dashboard?symbols=sh000001")
            sina = server.app.test_client().get("/api/sina?list=sh000001")

        self.assertEqual(dashboard.status_code, 200)
        self.assertIn("sh000001", dashboard.get_json()["quotesText"])
        self.assertEqual(sina.status_code, 200)
        self.assertIn("sh000001", sina.get_data(as_text=True))
        fetch.assert_not_called()

    def test_dashboard_and_sina_never_fetch_upstream_without_snapshot(self) -> None:
        with patch.object(server, "fetch_upstream", side_effect=AssertionError("request path must not fetch upstream")):
            dashboard = server.app.test_client().get("/api/dashboard?symbols=sh000001&currencies=USD")
            sina = server.app.test_client().get("/api/sina?list=sh000001")

        self.assertEqual(dashboard.status_code, 200)
        self.assertEqual(dashboard.get_json()["quotes"], {})
        self.assertEqual(sina.status_code, 200)
        self.assertEqual(sina.get_data(as_text=True), "")

    def test_twse_official_history_parser_stores_daily_closes(self) -> None:
        payload = json.dumps({
            "stat": "OK",
            "data": [
                ["2026/07/15", "44,850.69", "45,881.91", "44,850.69", "45,354.61"],
                ["2026/07/16", "45,400.00", "46,000.00", "45,300.00", "45,900.25"],
            ],
        })

        stored = server.store_market_history("twse-official", "TWII", payload)
        rows = server.read_market_history_from_db("twse-official", "TWII")

        self.assertEqual(stored, 2)
        self.assertEqual(rows[-1], {"date": "2026-07-16", "close": 45900.25})

    def test_coinmetrics_bitcoin_history_parser_stores_daily_usd_closes(self) -> None:
        payload = json.dumps({
            "data": [
                {"asset": "btc", "time": "2026-08-01T00:00:00.000000000Z", "PriceUSD": "62751.8791"},
                {"asset": "btc", "time": "2026-08-02T00:00:00.000000000Z", "PriceUSD": "63445.6830"},
            ]
        })

        stored = server.store_market_history("coinmetrics-crypto", "BTC", payload)
        rows = server.read_market_history_from_db("coinmetrics-crypto", "BTC")

        self.assertEqual(stored, 2)
        self.assertEqual(rows[-1], {"date": "2026-08-02", "close": 63445.683})

    def test_binance_bitcoin_parser_excludes_open_daily_candle(self) -> None:
        payload = json.dumps([
            [1785628800000, "62000", "64000", "61000", "63445.68", "1", 1785715199999],
            [1785715200000, "63445", "64000", "62000", "63000", "1", 1785801599999],
        ])

        rows = server.parse_binance_bitcoin_history(payload, current_ms=1785750000000)

        self.assertEqual(rows, [{"date": "2026-08-02", "close": 63445.68}])

    def test_coinmetrics_bitcoin_history_uses_binance_only_for_empty_bootstrap(self) -> None:
        fallback = json.dumps([
            {"date": "2026-08-01", "close": 62751.88},
            {"date": "2026-08-02", "close": 63445.68},
        ])
        with (
            patch.object(server, "fetch_upstream", return_value=(200, "application/json", b'{"data":[]}')),
            patch.object(server, "binance_bitcoin_history_text", return_value=fallback) as binance,
        ):
            status, _content_type, body = server.fetch_market_history_payload(
                "coinmetrics-crypto",
                "BTC",
                ttl_seconds=300,
                force_refresh=True,
            )

        self.assertEqual(status, 200)
        self.assertEqual(json.loads(server.decode_body(body))[-1]["close"], 63445.68)
        binance.assert_called_once_with(300, force_refresh=True)

    def test_coinmetrics_failure_keeps_existing_canonical_history(self) -> None:
        server.store_market_history(
            "coinmetrics-crypto",
            "BTC",
            json.dumps({"data": [{
                "time": "2026-08-01T00:00:00.000000000Z",
                "PriceUSD": "62751.88",
            }]}),
        )
        with (
            patch.object(server, "fetch_upstream", return_value=(200, "application/json", b'{"data":[]}')),
            patch.object(server, "binance_bitcoin_history_text") as binance,
        ):
            status, _content_type, _body = server.fetch_market_history_payload(
                "coinmetrics-crypto",
                "BTC",
                ttl_seconds=300,
                force_refresh=True,
            )

        self.assertEqual(status, 599)
        binance.assert_not_called()

    def test_market_history_refresh_waits_for_market_close(self) -> None:
        server.ensure_market_calendar_seeded(2026)
        server.store_market_history(
            "sina-cn",
            "sh000001",
            '[{"day":"2026-05-25","close":"4000.00"}]',
        )
        with sqlite3.connect(server.DB_PATH) as conn:
            conn.execute(
                "UPDATE market_history SET fetched_at = 0 WHERE source = ? AND symbol = ?",
                ("sina-cn", "sh000001"),
            )

        before_close = datetime.fromisoformat("2026-05-26T10:00:00+08:00")
        after_close = datetime.fromisoformat("2026-05-26T16:00:00+08:00")

        self.assertFalse(server.market_history_should_refresh_for_returns(
            "sina-cn", "sh000001", current=before_close
        ))
        self.assertTrue(server.market_history_should_refresh_for_returns(
            "sina-cn", "sh000001", current=after_close
        ))

    def test_us_futures_history_rolls_after_daily_settlement(self) -> None:
        server.ensure_market_calendar_seeded(2026)
        before = datetime.fromisoformat("2026-05-26T16:30:00-04:00")
        after = datetime.fromisoformat("2026-05-26T17:30:00-04:00")

        self.assertEqual(server.latest_completed_trading_day("hf_GC", before), "2026-05-22")
        self.assertEqual(server.latest_completed_trading_day("hf_GC", after), "2026-05-26")

    def test_twse_official_history_uses_non_redirecting_official_domain(self) -> None:
        url, referer = server.market_history_url("twse-official", "TWII")

        self.assertTrue(url.startswith("https://www.twse.com.tw/"))
        self.assertTrue(referer.startswith("https://www.twse.com.tw/"))

    def test_naver_kospi_history_parser_stores_daily_closes(self) -> None:
        payload = """
        [['날짜', '시가', '고가', '저가', '종가', '거래량', '외국인소진율'],
         ['20260102', 4224.53, 4313.55, 4216.68, 4309.63, 406339, 0.0],
         ['20260720', 6643.58, 6814.86, 6472.80, 6516.27, 345825, 0.0]]
        """

        stored = server.store_market_history("naver-korea", "KOSPI", payload)
        rows = server.read_market_history_from_db("naver-korea", "KOSPI")

        self.assertEqual(stored, 2)
        self.assertEqual(rows[-1], {"date": "2026-07-20", "close": 6516.27})

        history = server.app.test_client().get(
            "/api/markethistory?source=naver-korea&symbol=KOSPI"
        )
        returns = server.app.test_client().get(
            "/api/marketreturns?items=naver-korea:KOSPI"
        )
        self.assertEqual(history.status_code, 200)
        self.assertEqual(history.get_json()[-1]["close"], 6516.27)
        self.assertEqual(returns.status_code, 200)
        self.assertIn("ytd", returns.get_json()["naver-korea:KOSPI"]["ranges"])

    def test_naver_kospi_history_url_requests_ten_years(self) -> None:
        url, referer = server.market_history_url("naver-korea", "KOSPI")

        self.assertTrue(url.startswith("https://api.finance.naver.com/siseJson.naver?"))
        self.assertIn("symbol=KOSPI", url)
        self.assertIn("timeframe=day", url)
        self.assertTrue(referer.startswith("https://finance.naver.com/"))

    def test_naver_kospi_history_falls_back_to_eastmoney(self) -> None:
        fallback = json.dumps([
            {"date": "2026-07-17", "close": 6820.60},
            {"date": "2026-07-20", "close": 6516.27},
        ])
        with (
            patch.object(server, "fetch_upstream", return_value=(200, "text/plain", b"invalid")),
            patch.object(server, "eastmoney_kospi_history_text", return_value=fallback) as eastmoney,
        ):
            status, _content_type, body = server.fetch_market_history_payload(
                "naver-korea",
                "KOSPI",
                ttl_seconds=300,
                force_refresh=True,
            )

        self.assertEqual(status, 200)
        self.assertEqual(server.parse_naver_korea_history(server.decode_body(body))[-1]["close"], 6516.27)
        eastmoney.assert_called_once_with(300, force_refresh=True)

    def test_naver_kospi_refresh_returns_standard_json(self) -> None:
        payload = (
            "[['날짜', '시가', '고가', '저가', '종가', '거래량', '외국인소진율'],"
            "['20260720', 6643.58, 6814.86, 6472.80, 6516.27, 345825, 0.0]]"
        ).encode()
        with patch.object(
            server,
            "fetch_market_history_payload",
            return_value=(200, "text/plain; charset=utf-8", payload),
        ):
            response = server.app.test_client().get(
                "/api/markethistory?source=naver-korea&symbol=KOSPI&refresh=1"
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), [{"date": "2026-07-20", "close": 6516.27}])

    def test_eastmoney_kospi_fallback_normalizes_kline_rows(self) -> None:
        payload = {
            "data": {
                "klines": [
                    "2026-07-17,6900.00,6820.60,7000.00,6800.00,123456",
                    "2026-07-20,6643.58,6516.27,6814.86,6472.80,345825",
                ]
            }
        }
        with patch.object(server, "fetch_eastmoney_json", return_value=payload):
            text = server.eastmoney_kospi_history_text(300, force_refresh=False)

        self.assertIsNotNone(text)
        assert text is not None
        self.assertEqual(server.parse_naver_korea_history(text)[-1]["close"], 6516.27)

    def test_quote_group_refresh_interval_tracks_market_activity(self) -> None:
        server.ensure_market_calendar_seeded()
        self.assertEqual(
            server.quote_group_refresh_interval(
                ["sh000001"], datetime.fromisoformat("2026-05-26T10:00:00+08:00")
            ),
            60,
        )
        self.assertEqual(
            server.quote_group_refresh_interval(
                ["sh000001"], datetime.fromisoformat("2026-05-26T12:00:00+08:00")
            ),
            5 * 60,
        )
        self.assertEqual(
            server.quote_group_refresh_interval(
                ["sh000001"], datetime.fromisoformat("2026-05-23T10:00:00+08:00")
            ),
            15 * 60,
        )
        self.assertEqual(
            server.quote_group_refresh_interval(
                ["sh000001"], datetime.fromisoformat("2026-05-26T09:10:00+08:00")
            ),
            60,
        )
        self.assertEqual(
            server.quote_group_refresh_interval(
                ["fx_sbtcusd"], datetime.fromisoformat("2026-05-23T10:00:00+08:00")
            ),
            5 * 60,
        )
        self.assertEqual(
            server.quote_group_refresh_interval(
                ["hf_NQ", "fx_sbtcusd"], datetime.fromisoformat("2026-05-26T19:00:00+08:00")
            ),
            2 * 60,
        )

    def test_quote_snapshot_health_reports_fresh_and_missing_symbols(self) -> None:
        now = datetime.fromisoformat("2026-05-26T10:00:00+08:00")
        line = (
            'var hq_str_sh000001="上证指数,4000.0000,3990.0000,4010.0000,4010.0000,3990.0000,'
            '0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2026-05-26,10:00:00,00";'
        )
        states = {"sh000001": {"state": "live", "lastTradingDay": "2026-05-26"}}
        server.store_quote_snapshots(line, line, ["sh000001"], states, now)

        with (
            patch.object(server, "configured_quote_symbols", return_value=["sh000001", "sz399006"]),
            patch.object(server, "configured_unsupported_quote_symbols", return_value=["tw2330"]),
            patch.object(server, "market_state_for_symbol", side_effect=lambda symbol, _now: {
                "symbol": symbol, "state": "live", "lastTradingDay": "2026-05-26",
            }),
        ):
            health = server.quote_snapshot_health(now)

        self.assertEqual(health["healthy"], 1)
        self.assertEqual(health["issueCount"], 1)
        self.assertEqual(health["issues"][0]["symbol"], "sz399006")
        self.assertEqual(health["unsupportedCount"], 1)
        self.assertEqual(health["unsupported"][0]["symbol"], "tw2330")

    def test_unsupported_quotes_are_diagnostic_only(self) -> None:
        now = datetime.fromisoformat("2026-05-26T10:00:00+08:00")
        with (
            patch.object(server, "configured_quote_symbols", return_value=[]),
            patch.object(
                server,
                "configured_unsupported_quote_symbols",
                return_value=["tw2317", "tw2330"],
            ),
        ):
            health = server.quote_snapshot_health(now)

        self.assertEqual(health["status"], "ok")
        self.assertEqual(health["issueCount"], 0)
        self.assertEqual(health["unsupportedCount"], 2)

    def test_dynamic_backend_adapted_holdings_are_polled(self) -> None:
        holdings = [
            {"sinaSymbol": "gb_nvda"},
            {"sinaSymbol": "kr005930"},
            {"sinaSymbol": "", "quoteSupported": False},
        ]
        with (
            patch.object(server, "configured_sina_symbols_from_constants", return_value=["sh000001"]),
            patch.object(server, "configured_fund_codes_from_constants", return_value=["000001"]),
            patch.object(server, "read_fund_holdings_from_db", return_value=holdings),
        ):
            supported = server.configured_quote_symbols()
            unsupported = server.configured_unsupported_quote_symbols()

        self.assertEqual(supported, ["gb_nvda", "kr005930", "sh000001"])
        self.assertEqual(unsupported, [])

    def test_quote_diagnostics_requires_configured_token(self) -> None:
        client = server.app.test_client()
        self.assertEqual(client.get("/api/diagnostics/quotes").status_code, 403)
        with patch.dict(os.environ, {"FUND_VALUATION_DIAGNOSTICS_TOKEN": "secret"}):
            denied = client.get("/api/diagnostics/quotes")
            allowed = client.get("/api/diagnostics/quotes", headers={"X-Diagnostics-Token": "secret"})

        self.assertEqual(denied.status_code, 403)
        self.assertEqual(allowed.status_code, 200)
        self.assertIn("backgroundRefresh", allowed.get_json())
        self.assertIn("requestMetrics", allowed.get_json())
        self.assertIn("historyCoverage", allowed.get_json())

    def test_health_does_not_expose_database_path_and_readiness_checks_db(self) -> None:
        client = server.app.test_client()
        health = client.get("/api/health")
        ready = client.get("/api/ready")

        self.assertEqual(health.get_json(), {"ok": True})
        self.assertEqual(ready.status_code, 200)
        self.assertTrue(ready.get_json()["ready"])
        self.assertEqual(ready.get_json()["schemaVersion"], server.SCHEMA_VERSION)
        self.assertNotIn("db", health.get_json())
        self.assertRegex(health.headers["X-Request-ID"], r"^[a-f0-9]{32}$")
        self.assertEqual(health.headers["X-API-Schema-Version"], "1")

    def test_api_meta_exposes_supported_contract_versions(self) -> None:
        with patch.dict(os.environ, {
            "FUND_VALUATION_ENABLE_FUND_MANAGEMENT": "1",
            "FUND_VALUATION_FUND_MANAGEMENT_TOKEN": "management-secret",
        }):
            response = server.app.test_client().get("/api/meta", headers={"X-Request-ID": "test-request-1"})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["X-Request-ID"], "test-request-1")
        self.assertEqual(response.get_json(), {
            "apiSchemaVersion": 1,
            "dashboardSchemaVersion": 1,
            "fundManagementMode": "token",
        })

    def test_shared_universe_supplies_funds_holdings_and_market_targets(self) -> None:
        codes = server.configured_fund_codes_from_constants()
        holdings = server.parse_default_fund_holdings_from_constants(codes[0])

        self.assertEqual(len(codes), 17)
        self.assertGreater(len(holdings), 0)
        self.assertRegex(holdings[0]["sinaSymbol"], r"^[A-Za-z0-9_]+$")
        self.assertIn("sina-cn:sh000001", server.configured_market_return_items_from_constants())
        self.assertIn("tencent-hk:hkHSTECH", server.configured_market_return_items_from_constants())
        self.assertIn("hkHSTECH", server.configured_sina_symbols_from_constants())
        self.assertIn("kr000660", server.configured_sina_symbols_from_constants())
        self.assertIn("kr005930", server.configured_sina_symbols_from_constants())
        self.assertIn("sina-us:EEM", server.configured_market_return_items_from_constants())
        self.assertIn("gb_eem", server.configured_sina_symbols_from_constants())
        self.assertEqual(server.universe_fund_benchmark("539002"), {
            "source": "sina-us",
            "symbol": "EEM",
            "currency": "USD",
        })
        self.assertEqual(server.configured_unsupported_quote_symbols(), [])

    def test_history_health_uses_disclosure_lag_and_completed_market_sessions(self) -> None:
        server.ensure_market_calendar_seeded(2026)
        beijing_now = datetime.fromisoformat("2026-07-24T10:00:00+08:00")
        self.assertFalse(server.fund_history_is_stale("2026-07-23", beijing_now))
        self.assertTrue(server.fund_history_is_stale("2026-07-16", beijing_now))

        before_us_open = datetime.fromisoformat("2026-07-24T08:00:00-04:00")
        after_us_close = datetime.fromisoformat("2026-07-24T17:00:00-04:00")
        self.assertEqual(server.latest_completed_trading_day("gb_inx", before_us_open), "2026-07-23")
        self.assertEqual(server.latest_completed_trading_day("gb_inx", after_us_close), "2026-07-24")

    def test_fx_daily_history_is_persisted_for_valuation_basis(self) -> None:
        text = 'var hq_str_fx_susdcny="美元人民币,7.1000,0,0,0,0,0,0,0,09:30:00,0.12,2026-06-29";'

        self.assertEqual(server.store_fx_daily_history(text), 1)
        basis = server.read_fund_valuation_basis([{
            "code": "000001",
            "navDate": "2026-06-30",
            "symbols": [],
            "currencies": ["USD"],
        }])
        self.assertAlmostEqual(basis["000001"]["fxRates"]["USD"]["rate"], 7.1)

    def test_ecb_reference_rates_are_crossed_to_cny_and_stored_with_daily_changes(self) -> None:
        text = "\n".join([
            "CURRENCY,TIME_PERIOD,OBS_VALUE",
            "CNY,2026-06-30,7.7000",
            "USD,2026-06-30,1.1000",
            "JPY,2026-06-30,170.0000",
            "CNY,2026-07-01,7.7700",
            "USD,2026-07-01,1.1100",
            "JPY,2026-07-01,171.0000",
        ])

        parsed = parse_ecb_reference_rates(text)
        self.assertIn(("EUR", "2026-06-30", 7.7), parsed)
        self.assertIn(("USD", "2026-06-30", 7.0), parsed)
        self.assertEqual(server.store_ecb_reference_rates(text, 123), 6)
        with sqlite3.connect(server.DB_PATH) as conn:
            changes = {
                (currency, day): change
                for currency, day, change in conn.execute(
                    "SELECT currency, date, change_percent FROM fx_daily_history WHERE date = ?",
                    ("2026-07-01",),
                ).fetchall()
            }
        self.assertAlmostEqual(changes[("USD", "2026-07-01")], 0.0)
        self.assertAlmostEqual(changes[("EUR", "2026-07-01")], (7.77 / 7.7 - 1) * 100)

    def test_configured_fx_history_backfills_when_existing_coverage_is_short(self) -> None:
        short_summary = {
            currency: {"startDate": "2026-06-25", "endDate": "2026-08-03", "count": 33}
            for currency in ("USD", "EUR", "JPY", "KRW", "HKD")
        }
        with (
            patch.object(server, "fx_history_summary", return_value=short_summary),
            patch.object(server, "refresh_ecb_fx_history", return_value=5000) as refresh,
        ):
            rows = server.refresh_configured_fx_history(years=6)

        self.assertEqual(rows, 5000)
        self.assertIsNotNone(refresh.call_args.kwargs["start_date"])
        self.assertTrue(refresh.call_args.kwargs["force_refresh"])

    def test_configured_fx_history_uses_incremental_overlap_after_backfill(self) -> None:
        complete_summary = {
            currency: {"startDate": "2019-01-02", "endDate": "2026-08-03", "count": 1900}
            for currency in ("USD", "EUR", "JPY", "KRW", "HKD")
        }
        with (
            patch.object(server, "fx_history_summary", return_value=complete_summary),
            patch.object(server, "refresh_ecb_fx_history", return_value=25) as refresh,
        ):
            rows = server.refresh_configured_fx_history(years=6)

        self.assertEqual(rows, 25)
        self.assertIsNone(refresh.call_args.kwargs["start_date"])

    def test_history_coverage_reports_missing_datasets_without_fetching_upstream(self) -> None:
        periods = expected_holding_periods(years=3, as_of=date(2026, 7, 3))
        coverage = historical_data_coverage(years=3, as_of=date(2026, 7, 3))

        self.assertTrue(periods)
        self.assertTrue(all(str(period["availableDate"]) <= "2026-07-03" for period in periods))
        self.assertEqual(coverage["status"], "incomplete")
        self.assertEqual(coverage["summary"]["fundsWithoutNav"], 17)
        self.assertGreater(coverage["summary"]["missingHoldingPeriods"], 0)
        self.assertEqual(
            coverage["summary"]["marketsWithoutHistory"],
            len(server.configured_market_return_items_from_constants()),
        )

    def test_missing_holding_refresh_validates_period_and_stores_rows(self) -> None:
        gap = {"code": "017436", "year": 2025, "quarter": 4, "reportDate": "2025-12-31"}
        rows = [{
            "code": "017436", "reportDate": "2025-12-31", "rank": 1,
            "stockCode": "NVDA", "symbol": "NVDA", "name": "NVIDIA",
            "weight": 0.1, "market": "us", "sinaSymbol": "gb_nvda", "currency": "USD",
        }]
        with (
            patch.object(server, "missing_holding_requests", return_value=[gap]),
            patch.object(server, "fetch_upstream", return_value=(200, "text/plain", b"payload")),
            patch.object(server, "parse_fund_holdings", return_value=rows),
        ):
            result = server.refresh_missing_fund_holdings(max_requests=1, start_offset=0)

        self.assertEqual(result["stored"], 1)
        self.assertEqual(result["unavailable"], 0)
        with sqlite3.connect(server.DB_PATH) as conn:
            count = conn.execute(
                "SELECT COUNT(*) FROM fund_holdings WHERE code = ? AND report_date = ?",
                ("017436", "2025-12-31"),
            ).fetchone()[0]
        self.assertEqual(count, 1)

    def test_store_fund_holdings_rejects_non_quarter_report_date(self) -> None:
        server.store_fund_holdings(
            "017091",
            [{
                "code": "017091", "reportDate": "2023-09-07", "rank": 1,
                "stockCode": "NVDA", "symbol": "NVDA", "name": "NVIDIA",
                "weight": 0.1, "market": "us", "sinaSymbol": "gb_nvda", "currency": "USD",
            }],
        )

        self.assertEqual(server.read_fund_holdings_from_db("017091"), [])

    def test_read_fund_holdings_ignores_legacy_non_quarter_rows(self) -> None:
        with sqlite3.connect(server.DB_PATH) as conn:
            conn.execute(
                """
                INSERT INTO fund_holdings(
                  code, report_date, rank, stock_code, stock_name, weight,
                  market, sina_symbol, currency, fetched_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                ("017091", "2023-09-07", 1, "NVDA", "NVIDIA", 0.1, "us", "gb_nvda", "USD", 1),
            )

        self.assertEqual(server.read_fund_holdings_from_db("017091"), [])

    def test_current_fund_holdings_ignore_stale_but_valid_reports(self) -> None:
        server.store_fund_holdings(
            "501312",
            [{
                "code": "501312", "reportDate": "2023-09-30", "rank": 1,
                "stockCode": "513580", "symbol": "513580", "name": "华宝中证韩国芯片ETF",
                "weight": 0.9, "market": "cn", "sinaSymbol": "sh513580", "currency": "CNY",
            }],
        )

        self.assertEqual(server.read_fund_holdings_from_db("501312"), [])

    def test_latest_holding_refresh_updates_only_valid_quarterly_reports(self) -> None:
        valid_rows = [{
            "code": "017436", "reportDate": "2026-06-30", "rank": 1,
            "stockCode": "NVDA", "symbol": "NVDA", "name": "NVIDIA",
            "weight": 0.12, "market": "us", "sinaSymbol": "gb_nvda", "currency": "USD",
        }]
        invalid_rows = [{
            "code": "017091", "reportDate": "2023-09-07", "rank": 1,
            "stockCode": "MSFT", "symbol": "MSFT", "name": "Microsoft",
            "weight": 0.1, "market": "us", "sinaSymbol": "gb_msft", "currency": "USD",
        }]

        with (
            patch.object(server, "fetch_upstream", return_value=(200, "text/plain", b"payload")) as fetch,
            patch.object(
                server,
                "parse_fund_holdings",
                side_effect=lambda code, _text: valid_rows if code == "017436" else invalid_rows,
            ),
        ):
            result = server.refresh_latest_fund_holdings(
                ["017436", "017091"],
                force_refresh=True,
            )

        self.assertEqual(result["checked"], 2)
        self.assertEqual(result["stored"], 1)
        self.assertEqual(result["updated"], 1)
        self.assertEqual(result["changedCodes"], ["017436"])
        self.assertEqual(result["unavailable"], 1)
        self.assertEqual(result["errors"], [])
        self.assertEqual(server.read_fund_holdings_from_db("017436")[0]["reportDate"], "2026-06-30")
        self.assertEqual(server.read_fund_holdings_from_db("017091"), [])
        self.assertEqual(fetch.call_count, 2)
        for call in fetch.call_args_list:
            self.assertEqual(call.kwargs["ttl_seconds"], server.FUND_HOLDINGS_REFRESH_TTL_SECONDS)
            self.assertIs(call.kwargs["force_refresh"], True)

    def test_target_etf_fund_refreshes_holdings_from_target_code(self) -> None:
        rows = [{
            "code": "017091", "reportDate": "2026-06-30", "rank": 1,
            "stockCode": "NVDA", "symbol": "NVDA", "name": "NVIDIA",
            "weight": 0.1301, "market": "us", "sinaSymbol": "gb_nvda", "currency": "USD",
        }]
        with (
            patch.object(server, "fetch_upstream", return_value=(200, "text/plain", b"payload")) as fetch,
            patch.object(server, "parse_fund_holdings", return_value=rows) as parse,
        ):
            result = server.refresh_latest_fund_holdings(["017091"], force_refresh=True)

        self.assertEqual(result["latestReports"], {"017091": "2026-06-30"})
        self.assertIn("code=159509", fetch.call_args.args[0])
        self.assertIn("ccmx_159509.html", fetch.call_args.kwargs["referer"])
        parse.assert_called_once_with("017091", "payload")
        self.assertEqual(server.read_fund_holdings_from_db("017091")[0]["stockCode"], "NVDA")

    def test_configured_etf_portfolio_is_stored_without_invalid_stock_scrape(self) -> None:
        with (
            patch.object(server, "fetch_upstream", side_effect=AssertionError("must use disclosed ETF portfolio")),
            patch.object(server, "current_fund_holding_report_date", return_value=True),
        ):
            result = server.refresh_latest_fund_holdings(["501312"], force_refresh=True)

        self.assertEqual(result["latestReports"], {"501312": "2026-06-30"})
        holdings = server.read_fund_holdings_from_db("501312")
        self.assertEqual(holdings[0]["stockCode"], "ARKK")
        self.assertEqual(holdings[0]["sinaSymbol"], "gb_arkk")
        self.assertAlmostEqual(holdings[0]["weight"], 0.1848)

    def test_latest_holding_refresh_does_not_replace_newer_report(self) -> None:
        latest_rows = [{
            "code": "017436", "reportDate": "2026-06-30", "rank": 1,
            "stockCode": "NVDA", "symbol": "NVDA", "name": "NVIDIA",
            "weight": 0.12, "market": "us", "sinaSymbol": "gb_nvda", "currency": "USD",
        }]
        server.store_fund_holdings("017436", latest_rows)
        older_rows = [{**latest_rows[0], "reportDate": "2026-03-31", "weight": 0.08}]

        with (
            patch.object(server, "fetch_upstream", return_value=(200, "text/plain", b"payload")),
            patch.object(server, "parse_fund_holdings", return_value=older_rows),
        ):
            result = server.refresh_latest_fund_holdings(["017436"])

        self.assertEqual(result["stored"], 0)
        self.assertEqual(result["updated"], 0)
        self.assertEqual(result["unavailable"], 1)
        self.assertEqual(server.read_fund_holdings_from_db("017436")[0]["reportDate"], "2026-06-30")

    def test_latest_holding_refresh_retries_frequency_cap(self) -> None:
        rows = [{
            "code": "017436", "reportDate": "2026-06-30", "rank": 1,
            "stockCode": "NVDA", "symbol": "NVDA", "name": "NVIDIA",
            "weight": 0.12, "market": "us", "sinaSymbol": "gb_nvda", "currency": "USD",
        }]
        with (
            patch.object(
                server,
                "fetch_upstream",
                side_effect=[RuntimeError("HTTP Error 514: Frequency Capped"), (200, "text/plain", b"payload")],
            ) as fetch,
            patch.object(server, "parse_fund_holdings", return_value=rows),
            patch.object(server.time, "sleep") as sleep,
        ):
            result = server.refresh_latest_fund_holdings(["017436"])

        self.assertEqual(result["stored"], 1)
        self.assertEqual(result["errors"], [])
        self.assertEqual(fetch.call_count, 2)
        sleep.assert_any_call(2)
        sleep.assert_any_call(server.FUND_HOLDINGS_REQUEST_DELAY_SECONDS)

    def test_fund_profiles_parses_basic_profile(self) -> None:
        upstream_body = """
        <table class="info w790">
          <tr><th>基金代码</th><td>118001（前端）</td><th>基金类型</th><td>QDII-普通股票</td></tr>
          <tr><th>发行日期</th><td>2009年12月07日</td><th>成立日期/规模</th><td>2010年01月21日 / 5.921亿份</td></tr>
          <tr><th>净资产规模</th><td>31.69亿元（截止至：2026年03月31日）</td><th>份额规模</th><td>22.6875亿份</td></tr>
          <tr><th>管理费率</th><td>1.20%（每年）</td><th>托管费率</th><td>0.20%（每年）</td></tr>
          <tr><th>销售服务费率</th><td>---（每年）</td><th>最高认购费率</th><td>1.50%（前端）</td></tr>
        </table>
        """.encode()

        with patch.object(server, "fetch_upstream", return_value=(200, "text/html; charset=utf-8", upstream_body)):
            response = server.app.test_client().get("/api/fundprofiles?codes=118001&refresh=1")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["118001"]["inceptionDate"], "2010-01-21")
        self.assertEqual(payload["118001"]["assetScale"], "31.69亿元")
        self.assertEqual(payload["118001"]["scaleDate"], "2026-03-31")
        self.assertEqual(payload["118001"]["managementFee"], "1.20%")
        self.assertEqual(payload["118001"]["custodianFee"], "0.20%")
        self.assertEqual(payload["118001"]["salesServiceFee"], "0.00%")

        stored = server.read_fund_profiles_from_db(["118001"])["118001"]
        self.assertEqual(stored["scaleDate"], "2026-03-31")

    def test_fund_profiles_uses_persisted_profile_without_upstream_request(self) -> None:
        server.store_fund_profile("017436", {
            "inceptionDate": "2023-03-14",
            "assetScale": "47.06亿元",
            "scaleDate": "2026-06-30",
            "managementFee": "1.20%",
            "custodianFee": "0.20%",
            "salesServiceFee": "0.00%",
        })

        with patch.object(server, "fetch_upstream", side_effect=AssertionError("unexpected upstream fetch")):
            response = server.app.test_client().get("/api/fundprofiles?codes=017436")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()["017436"]
        self.assertEqual(payload["assetScale"], "47.06亿元")
        self.assertEqual(payload["scaleDate"], "2026-06-30")

        with patch.object(server, "fetch_and_store_fund_profile", side_effect=AssertionError("unexpected refresh")):
            result = server.refresh_fund_profiles(["017436"])
        self.assertEqual(result["updated"], 0)
        self.assertEqual(result["errors"], [])

    def test_fund_history_without_refresh_reads_sqlite(self) -> None:
        server.store_fund_history(
            "016664",
            [
                {"FSRQ": "2026-05-15", "DWJZ": "3.1194", "JZZZL": "-4.73"},
                {"FSRQ": "2026-05-14", "DWJZ": "3.2742", "JZZZL": "-1.22"},
            ],
        )

        with patch.object(server, "fetch_upstream", side_effect=AssertionError("unexpected upstream fetch")):
            response = server.app.test_client().get("/api/fundhistory?codes=016664&pageSize=2&pageIndex=1")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["016664"][0]["FSRQ"], "2026-05-15")

    def test_fund_history_without_refresh_does_not_fetch_missing_sqlite_rows(self) -> None:
        with patch.object(server, "fetch_upstream", side_effect=AssertionError("unexpected upstream fetch")):
            response = server.app.test_client().get("/api/fundhistory?codes=016664&pageSize=3000&pageIndex=1")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {})

    def test_fund_history_without_refresh_keeps_stale_sqlite_rows(self) -> None:
        server.store_fund_history(
            "016664",
            [{"FSRQ": "2026-05-15", "DWJZ": "3.1194", "JZZZL": "-4.73"}],
        )
        with sqlite3.connect(server.DB_PATH) as conn:
            conn.execute(
                "UPDATE fund_nav_history SET fetched_at = ? WHERE code = ?",
                (server.now_ms() - server.HISTORY_AUTO_REFRESH_TTL_MS - 1, "016664"),
            )
        upstream_body = (
            'jQuery({"Data":{"LSJZList":['
            '{"FSRQ":"2026-05-21","DWJZ":"3.0848","JZZZL":"-0.83"},'
            '{"FSRQ":"2026-05-20","DWJZ":"3.1106","JZZZL":"-0.28"}'
            ']}});'
        ).encode()

        def fake_fetch_upstream(*_args: object, **kwargs: object) -> tuple[int, str, bytes]:
            self.assertIs(kwargs.get("force_refresh"), True)
            return 200, "text/plain; charset=utf-8", upstream_body

        with patch.object(server, "fetch_upstream", side_effect=fake_fetch_upstream):
            response = server.app.test_client().get("/api/fundhistory?codes=016664&pageSize=2&pageIndex=1")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["016664"][0]["FSRQ"], "2026-05-15")
        self.assertEqual(server.read_fund_history_from_db("016664", 1, 1)[0]["FSRQ"], "2026-05-15")

    def test_fund_history_refresh_fetches_latest_and_updates_sqlite(self) -> None:
        server.store_fund_history(
            "016664",
            [{"FSRQ": "2026-05-15", "DWJZ": "3.1194", "JZZZL": "-4.73"}],
        )
        upstream_body = (
            'jQuery({"Data":{"LSJZList":['
            '{"FSRQ":"2026-05-19","DWJZ":"3.0848","JZZZL":"-0.83"},'
            '{"FSRQ":"2026-05-18","DWJZ":"3.1106","JZZZL":"-0.28"}'
            ']}});'
        ).encode()

        def fake_fetch_upstream(*_args: object, **kwargs: object) -> tuple[int, str, bytes]:
            self.assertIs(kwargs.get("force_refresh"), True)
            return 200, "text/plain; charset=utf-8", upstream_body

        with patch.object(server, "fetch_upstream", side_effect=fake_fetch_upstream):
            response = server.app.test_client().get("/api/fundhistory?codes=016664&pageSize=2&pageIndex=1&refresh=1")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["016664"][0]["FSRQ"], "2026-05-19")
        self.assertEqual(server.read_fund_history_from_db("016664", 1, 1)[0]["FSRQ"], "2026-05-19")

    def test_fund_history_refresh_merges_upstream_rows_with_sqlite(self) -> None:
        server.store_fund_history(
            "016664",
            [
                {"FSRQ": "2026-05-15", "DWJZ": "3.1194", "JZZZL": "-4.73"},
                {"FSRQ": "2026-05-14", "DWJZ": "3.2742", "JZZZL": "-1.22"},
                {"FSRQ": "2026-05-13", "DWJZ": "3.3147", "JZZZL": "0.91"},
            ],
        )
        upstream_body = (
            'jQuery({"Data":{"LSJZList":['
            '{"FSRQ":"2026-05-19","DWJZ":"3.0848","JZZZL":"-0.83"},'
            '{"FSRQ":"2026-05-18","DWJZ":"3.1106","JZZZL":"-0.28"}'
            ']}});'
        ).encode()

        with patch.object(server, "fetch_upstream", return_value=(200, "text/plain; charset=utf-8", upstream_body)):
            response = server.app.test_client().get("/api/fundhistory?codes=016664&pageSize=5&pageIndex=1&refresh=1")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(
            [row["FSRQ"] for row in payload["016664"]],
            ["2026-05-19", "2026-05-18", "2026-05-15", "2026-05-14", "2026-05-13"],
        )

    def test_fund_history_refresh_fetches_multiple_capped_pages(self) -> None:
        page_rows = {
            1: [
                {"FSRQ": "2026-05-21", "DWJZ": "1.6930", "JZZZL": "1.20"},
                {"FSRQ": "2026-05-20", "DWJZ": "1.6730", "JZZZL": "0.72"},
            ],
            2: [
                {"FSRQ": "2026-05-19", "DWJZ": "1.6610", "JZZZL": "-1.37"},
                {"FSRQ": "2026-05-18", "DWJZ": "1.6840", "JZZZL": "0.00"},
            ],
            3: [
                {"FSRQ": "2026-05-15", "DWJZ": "1.6840", "JZZZL": "-3.77"},
            ],
        }

        def fake_fetch_upstream(*_args: object, **kwargs: object) -> tuple[int, str, bytes]:
            cache_key = str(kwargs.get("cache_key") or "")
            page_index = int(cache_key.split(":")[2])
            rows = page_rows.get(page_index, [])
            body = json_body = f'jQuery({{"Data":{{"TotalCount":5,"LSJZList":{rows!r}}}}});'
            return 200, "text/plain; charset=utf-8", json_body.replace("'", '"').encode()

        with patch.object(server, "fetch_upstream", side_effect=fake_fetch_upstream):
            response = server.app.test_client().get("/api/fundhistory?codes=118001&pageSize=5&pageIndex=1&refresh=1")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(len(payload["118001"]), 5)
        self.assertEqual(payload["118001"][0]["FSRQ"], "2026-05-21")
        self.assertEqual(server.read_fund_history_from_db("118001", 10, 1)[-1]["FSRQ"], "2026-05-15")

    def test_fund_history_large_refresh_caps_upstream_page_size(self) -> None:
        upstream_body = (
            'jQuery({"Data":{"TotalCount":1,"LSJZList":['
            '{"FSRQ":"2026-07-21","DWJZ":"2.2390","JZZZL":"1.85"}'
            ']}});'
        ).encode()

        def fake_fetch_upstream(url: str, **kwargs: object) -> tuple[int, str, bytes]:
            self.assertIn(f"pageSize={server.FUND_HISTORY_UPSTREAM_PAGE_SIZE}", url)
            self.assertEqual(
                kwargs.get("cache_key"),
                f"fundhistory:017436:1:{server.FUND_HISTORY_UPSTREAM_PAGE_SIZE}",
            )
            return 200, "text/plain; charset=utf-8", upstream_body

        with patch.object(server, "fetch_upstream", side_effect=fake_fetch_upstream) as fetch:
            server.fetch_and_store_fund_history(
                "017436",
                server.MAX_FUND_HISTORY_REFRESH_ROWS,
                refresh=True,
            )

        fetch.assert_called_once()
        latest = server.read_fund_history_from_db("017436", 1, 1)[0]
        self.assertEqual(latest["FSRQ"], "2026-07-21")

    def test_fund_history_refresh_falls_back_to_sqlite_on_upstream_error(self) -> None:
        server.store_fund_history(
            "016664",
            [
                {"FSRQ": "2026-05-15", "DWJZ": "3.1194", "JZZZL": "-4.73"},
                {"FSRQ": "2026-05-14", "DWJZ": "3.2742", "JZZZL": "-1.22"},
            ],
        )

        def fake_fetch_upstream(*_args: object, **kwargs: object) -> tuple[int, str, bytes]:
            self.assertIs(kwargs.get("force_refresh"), True)
            return 502, "text/plain; charset=utf-8", b""

        with patch.object(server, "fetch_upstream", side_effect=fake_fetch_upstream):
            response = server.app.test_client().get("/api/fundhistory?codes=016664&pageSize=3000&pageIndex=1&refresh=1")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(len(payload["016664"]), 2)
        self.assertEqual(payload["016664"][0]["FSRQ"], "2026-05-15")

    def test_fund_history_refresh_falls_back_to_sqlite_on_empty_upstream_rows(self) -> None:
        server.store_fund_history(
            "016664",
            [
                {"FSRQ": "2026-05-15", "DWJZ": "3.1194", "JZZZL": "-4.73"},
                {"FSRQ": "2026-05-14", "DWJZ": "3.2742", "JZZZL": "-1.22"},
            ],
        )
        upstream_body = b'jQuery({"Data":{"LSJZList":[]}});'

        with patch.object(server, "fetch_upstream", return_value=(200, "text/plain; charset=utf-8", upstream_body)):
            response = server.app.test_client().get("/api/fundhistory?codes=016664&pageSize=3000&pageIndex=1&refresh=1")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(len(payload["016664"]), 2)
        self.assertEqual(payload["016664"][0]["FSRQ"], "2026-05-15")

    def test_fund_history_refresh_without_sqlite_cache_returns_empty_payload(self) -> None:
        with patch.object(server, "fetch_upstream", return_value=(502, "text/plain; charset=utf-8", b"")):
            response = server.app.test_client().get("/api/fundhistory?codes=016664&pageSize=3000&pageIndex=1&refresh=1")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {})

    def test_fund_history_paginates_sqlite_rows(self) -> None:
        server.store_fund_history(
            "016664",
            [
                {"FSRQ": "2026-05-15", "DWJZ": "3.1194", "JZZZL": "-4.73"},
                {"FSRQ": "2026-05-14", "DWJZ": "3.2742", "JZZZL": "-1.22"},
                {"FSRQ": "2026-05-13", "DWJZ": "3.3147", "JZZZL": "0.91"},
                {"FSRQ": "2026-05-12", "DWJZ": "3.2848", "JZZZL": "-0.18"},
            ],
        )

        with patch.object(server, "fetch_upstream", side_effect=AssertionError("unexpected upstream fetch")):
            response = server.app.test_client().get("/api/fundhistory?codes=016664&pageSize=2&pageIndex=2")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual([row["FSRQ"] for row in payload["016664"]], ["2026-05-13", "2026-05-12"])

    def test_fund_returns_without_history_does_not_fetch_upstream(self) -> None:
        with patch.object(server, "fetch_upstream", side_effect=AssertionError("unexpected upstream fetch")):
            response = server.app.test_client().get("/api/fundreturns?codes=016664")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {})

    def test_fund_returns_include_risk_metrics(self) -> None:
        server.store_fund_history(
            "016664",
            [
                {"FSRQ": "2026-01-04", "DWJZ": "1.1000", "JZZZL": "22.22"},
                {"FSRQ": "2026-01-03", "DWJZ": "0.9000", "JZZZL": "-25.00"},
                {"FSRQ": "2026-01-02", "DWJZ": "1.2000", "JZZZL": "20.00"},
                {"FSRQ": "2025-12-31", "DWJZ": "1.0000", "JZZZL": "0.00"},
            ],
        )

        response = server.app.test_client().get("/api/fundreturns?codes=016664")

        self.assertEqual(response.status_code, 200)
        ytd = response.get_json()["016664"]["ranges"]["ytd"]
        self.assertEqual(ytd["returnPercent"], 10.0)
        self.assertEqual(ytd["maxDrawdownPercent"], -25.0)
        self.assertEqual(ytd["winRatePercent"], 66.67)
        self.assertNotIn("volatilityPercent", ytd)

    def test_fund_holdings_refresh_parses_and_stores_top_holdings(self) -> None:
        upstream_body = (
            'var apidata={ content:"<div><label class=\'right\'>截止至：<font class=\'px12\'>2026-03-31</font></label>'
            '<table><tbody>'
            '<tr><td>1</td><td class=\'toc\'><a href=\'//quote.eastmoney.com/unify/r/105.TSM\'>TSM</a></td>'
            '<td class=\'toc\'><a>台积电</a></td><td>--</td><td>--</td><td></td><td>4.89%</td></tr>'
            '<tr><td>2</td><td class=\'toc\'><a href=\'//quote.eastmoney.com/unify/r/116.09988\'>09988</a></td>'
            '<td class=\'toc\'><a>阿里巴巴-W</a></td><td>--</td><td>--</td><td></td><td>5.03%</td></tr>'
            '<tr><td>3</td><td class=\'toc\'><span>005930</span></td>'
            '<td class=\'toc\'><span>三星电子</span></td><td>--</td><td>--</td><td></td><td>5.28%</td></tr>'
            '<tr><td>4</td><td class=\'toc\'><span>2330</span></td>'
            '<td class=\'toc\'><span>台积电</span></td><td>--</td><td>--</td><td></td><td>5.48%</td></tr>'
            '</tbody></table></div>",arryear:[2026],curyear:2026};'
        ).encode()

        with patch.object(server, "fetch_upstream", return_value=(200, "text/plain; charset=utf-8", upstream_body)):
            response = server.app.test_client().get("/api/fundholdings?codes=457001&refresh=1")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        rows = payload["457001"]
        self.assertEqual(len(rows), 4)
        self.assertEqual(rows[0]["sinaSymbol"], "gb_tsm")
        self.assertEqual(rows[0]["currency"], "USD")
        self.assertEqual(rows[1]["sinaSymbol"], "hk09988")
        self.assertEqual(rows[1]["currency"], "HKD")
        self.assertEqual(rows[2]["sinaSymbol"], "kr005930")
        self.assertEqual(rows[2]["currency"], "KRW")
        self.assertEqual(rows[3]["market"], "tw")
        self.assertEqual(rows[3]["sinaSymbol"], "")

        cached = server.read_fund_holdings_from_db("457001")
        self.assertEqual(len(cached), 4)
        self.assertEqual(cached[0]["reportDate"], "2026-03-31")

    def test_fund_holdings_without_refresh_reads_sqlite(self) -> None:
        server.store_fund_holdings(
            "457001",
            [{
                "reportDate": "2026-03-31",
                "rank": 1,
                "stockCode": "TSM",
                "name": "台积电",
                "weight": 0.0489,
                "market": "us",
                "sinaSymbol": "gb_tsm",
                "currency": "USD",
            }],
        )

        with patch.object(server, "fetch_upstream", side_effect=AssertionError("unexpected upstream fetch")):
            response = server.app.test_client().get("/api/fundholdings?codes=457001")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["457001"][0]["sinaSymbol"], "gb_tsm")

    def test_fund_holdings_refresh_falls_back_to_sqlite_on_empty_upstream(self) -> None:
        server.store_fund_holdings(
            "457001",
            [{
                "reportDate": "2026-03-31",
                "rank": 1,
                "stockCode": "TSM",
                "name": "台积电",
                "weight": 0.0489,
                "market": "us",
                "sinaSymbol": "gb_tsm",
                "currency": "USD",
            }],
        )

        with patch.object(server, "fetch_upstream", return_value=(200, "text/plain; charset=utf-8", b"var apidata={ content:\"\",arryear:[]};")):
            response = server.app.test_client().get("/api/fundholdings?codes=457001&refresh=1")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["457001"][0]["sinaSymbol"], "gb_tsm")

    def test_market_history_without_refresh_reads_sqlite(self) -> None:
        server.store_market_history("sina-us", ".INX", 'var _=([{"d":"2026-05-14","c":"7501.24"}]);')

        with patch.object(server, "fetch_upstream", side_effect=AssertionError("unexpected upstream fetch")):
            response = server.app.test_client().get("/api/markethistory?source=sina-us&symbol=.INX")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload[0]["date"], "2026-05-14")
        self.assertEqual(payload[0]["close"], 7501.24)

    def test_market_history_without_refresh_does_not_fetch_missing_sqlite_rows(self) -> None:
        with patch.object(server, "fetch_upstream", side_effect=AssertionError("unexpected upstream fetch")):
            response = server.app.test_client().get("/api/markethistory?source=sina-us&symbol=.INX")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), [])

    def test_market_history_without_refresh_keeps_stale_sqlite_rows(self) -> None:
        server.store_market_history("sina-us", ".INX", 'var _=([{"d":"2026-05-14","c":"7501.24"}]);')
        with sqlite3.connect(server.DB_PATH) as conn:
            conn.execute(
                "UPDATE market_history SET fetched_at = ? WHERE source = ? AND symbol = ?",
                (server.now_ms() - server.HISTORY_AUTO_REFRESH_TTL_MS - 1, "sina-us", ".INX"),
            )
        upstream_body = b'var _=([{"d":"2026-05-19","c":"7353.61"}]);'

        def fake_fetch_upstream(*_args: object, **kwargs: object) -> tuple[int, str, bytes]:
            self.assertIs(kwargs.get("force_refresh"), True)
            return 200, "application/json; charset=utf-8", upstream_body

        with patch.object(server, "fetch_upstream", side_effect=fake_fetch_upstream):
            response = server.app.test_client().get("/api/markethistory?source=sina-us&symbol=.INX")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload[-1]["date"], "2026-05-14")
        rows = server.read_market_history_from_db("sina-us", ".INX")
        self.assertEqual(rows[-1]["date"], "2026-05-14")

    def test_market_returns_returns_cached_rows_without_request_refresh(self) -> None:
        server.store_market_history(
            "sina-us",
            ".INX",
            'var _=([{"d":"2025-12-31","c":"100"},{"d":"2026-05-14","c":"110"}]);',
        )
        with sqlite3.connect(server.DB_PATH) as conn:
            conn.execute(
                "UPDATE market_history SET fetched_at = ? WHERE source = ? AND symbol = ?",
                (server.now_ms() - server.HISTORY_AUTO_REFRESH_TTL_MS - 1, "sina-us", ".INX"),
            )
        scheduled: list[tuple[str, str]] = []
        with patch.object(server, "schedule_market_history_refresh", side_effect=lambda source, symbol: scheduled.append((source, symbol))):
            response = server.app.test_client().get("/api/marketreturns?items=sina-us:.INX")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        summary = payload["sina-us:.INX"]
        self.assertEqual(summary["endDate"], "2026-05-14")
        self.assertEqual(summary["returnPercent"], 10.0)
        self.assertEqual(summary["latest"]["startDate"], "2025-12-31")
        self.assertEqual(summary["latest"]["endDate"], "2026-05-14")
        self.assertEqual(summary["latest"]["returnPercent"], 10.0)
        self.assertEqual(summary["ranges"]["ytd"]["returnPercent"], 10.0)
        self.assertEqual(scheduled, [])

    def test_market_returns_does_not_refresh_missing_rows_on_request(self) -> None:
        scheduled: list[tuple[str, str]] = []
        with patch.object(server, "schedule_market_history_refresh", side_effect=lambda source, symbol: scheduled.append((source, symbol))):
            response = server.app.test_client().get("/api/marketreturns?items=sina-cn:sh000688")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertNotIn("sina-cn:sh000688", payload)
        self.assertEqual(scheduled, [])

    def test_overview_does_not_schedule_stale_fund_history_refresh(self) -> None:
        server.store_fund_history(
            "017436",
            [
                {"FSRQ": "2026-07-02", "DWJZ": "2.0000", "JZZZL": "1.00"},
                {"FSRQ": "2026-07-01", "DWJZ": "1.9800", "JZZZL": "0.50"},
            ],
        )
        with sqlite3.connect(server.DB_PATH) as conn:
            conn.execute(
                "UPDATE fund_nav_history SET fetched_at = ? WHERE code = ?",
                (server.now_ms() - server.HISTORY_AUTO_REFRESH_TTL_MS - 1, "017436"),
            )
        scheduled: list[tuple[list[str], int]] = []

        with patch.object(
            server,
            "schedule_fund_history_refresh",
            side_effect=lambda codes, target_count: scheduled.append((codes, target_count)),
        ), patch.object(
            server,
            "build_dashboard_payload",
            return_value={"schemaVersion": server.DASHBOARD_SCHEMA_VERSION, "quotes": {}, "marketStates": {}},
        ):
            response = server.app.test_client().get(
                "/api/overview?symbols=sh000001&currencies=USD&fundCodes=017436",
            )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["fundSummaries"]["017436"]["navDate"], "2026-07-02")
        self.assertEqual(scheduled, [])

    def test_market_returns_adjusts_cn_etf_ex_rights_gap(self) -> None:
        server.store_market_history(
            "sina-cn",
            "sh515070",
            json.dumps([
                {"day": "2026-06-09", "close": "2.461"},
                {"day": "2026-07-03", "close": "2.584"},
                {"day": "2026-07-06", "close": "1.281"},
                {"day": "2026-07-09", "close": "1.379"},
            ]),
        )

        response = server.app.test_client().get("/api/marketreturns?items=sina-cn:sh515070")

        self.assertEqual(response.status_code, 200)
        summary = response.get_json()["sina-cn:sh515070"]
        one_month = summary["ranges"]["1m"]
        self.assertGreater(one_month["returnPercent"], 10)
        self.assertLess(one_month["returnPercent"], 15)
        self.assertEqual(one_month["endClose"], 1.379)
        self.assertAlmostEqual(one_month["endAdjustedClose"], 2.7815, places=3)

    def test_market_history_returns_adjusted_cn_etf_series(self) -> None:
        server.store_market_history(
            "sina-cn",
            "sz159558",
            json.dumps([
                {"day": "2026-07-07", "close": "4.148"},
                {"day": "2026-07-08", "close": "4.215"},
                {"day": "2026-07-09", "close": "1.546"},
            ]),
        )

        response = server.app.test_client().get("/api/markethistory?source=sina-cn&symbol=sz159558")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload[-1]["date"], "2026-07-09")
        self.assertAlmostEqual(payload[-1]["close"], 4.215, places=3)
        self.assertEqual(payload[-1]["rawClose"], 1.546)
        self.assertTrue(payload[-1]["adjusted"])

    def test_market_returns_does_not_adjust_cn_index_history(self) -> None:
        server.store_market_history(
            "sina-cn",
            "sh000001",
            json.dumps([
                {"day": "2026-06-09", "close": "3000"},
                {"day": "2026-07-09", "close": "1500"},
            ]),
        )

        response = server.app.test_client().get("/api/marketreturns?items=sina-cn:sh000001")

        self.assertEqual(response.status_code, 200)
        summary = response.get_json()["sina-cn:sh000001"]
        self.assertEqual(summary["ranges"]["1m"]["returnPercent"], -50.0)

    def test_sina_zero_cn_index_quote_falls_back_to_latest_history_close(self) -> None:
        server.store_market_history(
            "sina-cn",
            "sz399006",
            '[{"day":"2026-06-24","close":"4251.43"},{"day":"2026-06-25","close":"4371.99"}]',
        )

        text = server.sanitize_sina_quote_text(
            'var hq_str_s_sz399006="创业板指,0.00,0.00,0.00,0,0";',
            ["s_sz399006"],
            now=datetime.fromisoformat("2026-06-25T10:00:00+08:00"),
        )

        self.assertIn('hq_str_s_sz399006="创业板指,4371.9900,120.5600,2.84', text)
        self.assertIn("2026-06-25", text)
        health = server.upstream_health_snapshot()
        self.assertEqual(health["fallbackCount"], 1)
        self.assertEqual(health["issues"][0]["key"], "quote:s_sz399006")

    def test_cn_indices_use_previous_close_before_call_auction(self) -> None:
        indices = {
            "sh000001": "上证指数",
            "sz399001": "深证成指",
            "sh000300": "沪深300",
            "sz399006": "创业板指",
        }
        for symbol in indices:
            server.store_market_history(
                "sina-cn",
                symbol,
                '[{"day":"2026-05-22","close":"3950.00"},{"day":"2026-05-25","close":"4000.00"},'
                '{"day":"2026-05-26","close":"4100.00"}]',
            )
        raw_lines = []
        for symbol, name in indices.items():
            raw_lines.append(
                f'var hq_str_{symbol}="{name},4000.0000,4000.0000,4010.0000,4010.0000,3990.0000,'
                '0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2026-05-26,09:10:00,00";'
            )

        text = server.sanitize_sina_quote_text(
            "\n".join(raw_lines),
            list(indices),
            datetime.fromisoformat("2026-05-26T09:10:00+08:00"),
        )

        for symbol, name in indices.items():
            self.assertIn(
                f'hq_str_{symbol}="{name},4000.0000,3950.0000,4000.0000',
                text,
            )
        self.assertEqual(server.upstream_health_snapshot()["fallbackCount"], 0)

    def test_cn_index_accepts_timestamped_current_call_auction_quote(self) -> None:
        line = (
            'var hq_str_sz399006="创业板指,4002.0000,4000.0000,4010.0000,4012.0000,3998.0000,'
            '0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2026-05-26,09:20:00,00";'
        )

        text = server.sanitize_sina_quote_text(
            line,
            ["sz399006"],
            datetime.fromisoformat("2026-05-26T09:20:00+08:00"),
        )

        self.assertEqual(text.strip(), line)

    def test_cn_index_rejects_untimestamped_call_auction_quote(self) -> None:
        server.store_market_history(
            "sina-cn",
            "sz399006",
            '[{"day":"2026-05-22","close":"3950.00"},{"day":"2026-05-25","close":"4000.00"}]',
        )

        text = server.sanitize_sina_quote_text(
            'var hq_str_s_sz399006="创业板指,4010.00,10.00,0.25,0,0";',
            ["s_sz399006"],
            datetime.fromisoformat("2026-05-26T09:20:00+08:00"),
        )

        self.assertIn('hq_str_s_sz399006="创业板指,4000.0000,50.0000,1.27', text)

    def test_sina_zero_cn_etf_quote_falls_back_to_previous_close_without_history(self) -> None:
        text = server.sanitize_sina_quote_text(
            'var hq_str_sz159326="电网设备,0.000,2.189,0.000,0.000,0.000,0.000,0.000,0,0.000,0,0.000,0,0.000,0,0.000,0,0.000,0,0.000,0,0.000,0,0.000,0,0.000,0,0.000,0,0.000,2026-06-25,09:10:00,00";',
            ["sz159326"],
        )

        self.assertIn('hq_str_sz159326="电网设备,2.1890,2.189,2.1890', text)
        health = server.upstream_health_snapshot()
        self.assertEqual(health["fallbackCount"], 1)

    def test_sina_missing_quote_line_is_recorded_in_data_health(self) -> None:
        text = server.sanitize_sina_quote_text(
            'var hq_str_s_sh000001="上证指数,3000,10,0.33";',
            ["s_sh000001", "s_sz399006"],
        )

        self.assertIn("s_sh000001", text)
        health = server.upstream_health_snapshot()
        self.assertEqual(health["errorCount"], 1)
        self.assertEqual(health["issues"][0]["key"], "quote:s_sz399006")

    def test_market_history_refresh_fetches_tencent_hk_history(self) -> None:
        upstream_body = (
            b'{"code":0,"data":{"hkHSTECH":{"day":['
            b'["2025-12-31","4400.00","4500.00","4510.00","4390.00","1000"],'
            b'["2026-06-11","4700.00","4950.00","5000.00","4650.00","2000"]'
            b']}}}'
        )

        def fake_fetch_upstream(*_args: object, **kwargs: object) -> tuple[int, str, bytes]:
            self.assertIs(kwargs.get("force_refresh"), True)
            return 200, "application/json; charset=utf-8", upstream_body

        with patch.object(server, "fetch_upstream", side_effect=fake_fetch_upstream):
            server.ensure_market_history_for_returns("tencent-hk", "hkHSTECH")

        summary = server.read_market_return_summary_from_db("tencent-hk", "hkHSTECH")
        self.assertIsNotNone(summary)
        assert summary is not None
        self.assertEqual(summary["endDate"], "2026-06-11")
        self.assertEqual(summary["ranges"]["ytd"]["returnPercent"], 10.0)
        rows = server.read_market_history_from_db("tencent-hk", "hkHSTECH")
        self.assertEqual(rows[-1]["date"], "2026-06-11")
        self.assertEqual(rows[-1]["close"], 4950.0)

    def test_market_history_refresh_fetches_latest_and_updates_sqlite(self) -> None:
        server.store_market_history("sina-us", ".INX", 'var _=([{"d":"2026-05-14","c":"7501.24"}]);')
        upstream_body = b'var _=([{"d":"2026-05-19","c":"7353.61"}]);'

        def fake_fetch_upstream(*_args: object, **kwargs: object) -> tuple[int, str, bytes]:
            self.assertIs(kwargs.get("force_refresh"), True)
            return 200, "application/json; charset=utf-8", upstream_body

        with patch.object(server, "fetch_upstream", side_effect=fake_fetch_upstream):
            response = server.app.test_client().get("/api/markethistory?source=sina-us&symbol=.INX&refresh=1")

        self.assertEqual(response.status_code, 200)
        self.assertIn("2026-05-19", response.get_data(as_text=True))
        rows = server.read_market_history_from_db("sina-us", ".INX")
        self.assertEqual(rows[-1]["date"], "2026-05-19")

    def test_market_history_refresh_falls_back_to_sqlite_on_upstream_error(self) -> None:
        server.store_market_history("sina-us", ".INX", 'var _=([{"d":"2026-05-14","c":"7501.24"}]);')

        with patch.object(server, "fetch_upstream", return_value=(503, "text/plain; charset=utf-8", b"unavailable")):
            response = server.app.test_client().get("/api/markethistory?source=sina-us&symbol=.INX&refresh=1")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload[0]["date"], "2026-05-14")
        self.assertEqual(payload[0]["close"], 7501.24)

    def test_market_history_refresh_falls_back_to_sqlite_on_malformed_upstream_body(self) -> None:
        server.store_market_history("sina-us", ".INX", 'var _=([{"d":"2026-05-14","c":"7501.24"}]);')

        with patch.object(server, "fetch_upstream", return_value=(200, "application/json; charset=utf-8", b"not-json")):
            response = server.app.test_client().get("/api/markethistory?source=sina-us&symbol=.INX&refresh=1")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload[0]["date"], "2026-05-14")
        self.assertEqual(payload[0]["close"], 7501.24)

    def test_market_history_refresh_without_sqlite_cache_returns_upstream_error(self) -> None:
        with patch.object(server, "fetch_upstream", return_value=(503, "text/plain; charset=utf-8", b"unavailable")):
            response = server.app.test_client().get("/api/markethistory?source=sina-us&symbol=.INX&refresh=1")

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.get_data(), b"unavailable")


if __name__ == "__main__":
    unittest.main()
