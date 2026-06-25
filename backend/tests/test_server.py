from __future__ import annotations

import os
import json
import sqlite3
import tempfile
import unittest
from datetime import datetime
from zoneinfo import ZoneInfo
from unittest.mock import patch


_TEMP_DATA = tempfile.TemporaryDirectory()
os.environ["FUND_VALUATION_DATA_DIR"] = _TEMP_DATA.name

from backend import server  # noqa: E402


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
                DELETE FROM market_history;
                DELETE FROM market_calendar;
                DELETE FROM stock_daily_history;
                DELETE FROM fund_estimate_backtest;
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

    def test_background_refresh_schedules_configured_work(self) -> None:
        with (
            patch.object(server, "configured_fund_codes_from_constants", return_value=["016664"]),
            patch.object(server, "latest_fund_history_meta", return_value=("2026-05-21", 0)),
            patch.object(server, "auto_refresh_fund_history_if_stale") as fund_refresh,
            patch.object(server, "configured_market_return_items_from_constants", return_value=["sina-cn:sh000001"]),
            patch.object(server, "market_history_should_refresh_for_returns", return_value=True),
            patch.object(server, "schedule_market_history_refresh") as market_refresh,
            patch.object(server, "prewarm_response_cache") as prewarm,
            patch.object(server, "prewarm_fund_nav_cache_async") as nav_prewarm,
            patch.object(server, "prewarm_fund_backtest_cache", return_value=[]) as backtest_prewarm,
        ):
            server.run_background_refresh_once()

        fund_refresh.assert_called_once_with("016664", server.FUND_HISTORY_AUTO_REFRESH_ROWS)
        market_refresh.assert_called_once_with("sina-cn", "sh000001")
        prewarm.assert_called_once()
        nav_prewarm.assert_called_once()
        backtest_prewarm.assert_called_once()
        self.assertGreater(server.background_refresh_state_snapshot()["runCount"], 0)

    def test_sina_proxy_decodes_gb18030_fund_name(self) -> None:
        upstream_body = 'var hq_str_f_118001="易方达亚洲精选股票(QDII),1.693,1.693,1.673,2026-05-21,22.6875";'.encode("gb18030")

        with patch.object(server, "fetch_upstream", return_value=(200, "text/plain; charset=utf-8", upstream_body)):
            response = server.app.test_client().get("/api/sina?list=f_118001")

        self.assertEqual(response.status_code, 200)
        self.assertIn("charset=utf-8", response.content_type)
        self.assertIn("易方达亚洲精选股票(QDII)", response.get_data(as_text=True))
        self.assertNotIn("�", response.get_data(as_text=True))

    def test_dashboard_aggregates_market_snapshot_and_uses_cache(self) -> None:
        quote_body = 'var hq_str_s_sh000001="上证指数,3000,10,0.33";'.encode("gb18030")
        fx_body = 'var hq_str_fx_susdcny="美元人民币,7.1000,0,0,0,0,0,0,0,09:30:00,0.12,2026-06-12";'.encode("gb18030")
        calls: list[str] = []

        def fake_fetch(url: str, **_kwargs: object) -> tuple[int, str, bytes]:
            calls.append(url)
            if "fx_susdcny" in url:
                return 200, "text/plain; charset=utf-8", fx_body
            return 200, "text/plain; charset=utf-8", quote_body

        client = server.app.test_client()
        url = "/api/dashboard?symbols=s_sh000001&currencies=USD&now=2026-05-26T10:00:00%2B08:00"
        with patch.object(server, "fetch_upstream", side_effect=fake_fetch):
            first = client.get(url)
            second = client.get(url)

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        payload = first.get_json()
        self.assertIn("上证指数", payload["quotesText"])
        self.assertIn("美元人民币", payload["fxText"])
        self.assertEqual(payload["marketStates"]["s_sh000001"]["state"], "live")
        self.assertEqual(first.headers.get("X-Cache"), "MISS")
        self.assertEqual(second.headers.get("X-Cache"), "HIT")
        self.assertEqual(len(calls), 2)

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
            response = server.app.test_client().get(
                "/api/overview?symbols=s_sh000001&currencies=USD&fundCodes=016664&now=2026-05-26T10:00:00%2B08:00"
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
            response = server.app.test_client().get("/api/sina?list=int_nikkei,b_TWSE")

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
            response = server.app.test_client().get("/api/sina?list=int_nikkei")

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
            response = server.app.test_client().get("/api/sina?list=int_nikkei")

        text = response.get_data(as_text=True)
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("44946.64", text)
        self.assertIn('var hq_str_int_nikkei="日经225,69174.75,-613.63,-0.88,2026-06-24";', text)

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
        ):
            response = server.app.test_client().get("/api/sina?list=b_TWSE")

        text = response.get_data(as_text=True)
        self.assertEqual(response.status_code, 200)
        self.assertIn('var hq_str_b_TWSE="台湾加权,46465.20,587.81,1.28,2026-06-19";', text)

    def test_sina_proxy_drops_stale_taiwan_when_fallback_unavailable(self) -> None:
        stale_body = (
            'var hq_str_b_TWSE="台湾台北指数,25580.32,-443.53,-1.70,9/26/2025,2025-09-26";\n'
        ).encode("gb18030")

        with (
            patch.object(server, "fetch_upstream", return_value=(200, "text/plain; charset=gb18030", stale_body)),
            patch.object(server, "fetch_eastmoney_json", return_value=None),
        ):
            response = server.app.test_client().get("/api/sina?list=b_TWSE")

        text = response.get_data(as_text=True)
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("b_TWSE", text)
        self.assertNotIn("25580.32", text)

    def test_eastmoney_global_quote_falls_back_to_latest_daily_kline(self) -> None:
        kline_payload = {
            "data": {
                "name": "日经225",
                "klines": [
                    "2026-06-18,66783.22,69317.50,69682.23,66783.22,0,0.00,4.39,4.99,3297.46,0.00",
                    "2026-06-19,69288.91,69404.50,70020.68,69095.67,0,0.00,1.33,0.13,87.00,0.00",
                ],
            }
        }

        def fake_eastmoney(url: str, **_kwargs: object) -> dict[str, object] | None:
            if "stock/get" in url:
                return None
            return kline_payload

        with patch.object(server, "fetch_eastmoney_json", side_effect=fake_eastmoney):
            line = server.eastmoney_global_quote_line("int_nikkei")

        self.assertEqual(line, 'var hq_str_int_nikkei="日经225,69404.50,87.00,0.13,2026-06-19";')

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

    def test_fund_api_rate_limits_by_client(self) -> None:
        body = b'jsonpgz({"fundcode":"016664","name":"test"});'

        with patch.dict(server.RATE_LIMIT_RULES, {"fundnav": (1, 60)}):
            with patch.object(server, "fetch_upstream", return_value=(200, "text/plain; charset=utf-8", body)):
                client = server.app.test_client()
                first = client.get("/api/fundnav?codes=016664")
                second = client.get("/api/fundnav?codes=016664")

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 429)

    def test_fund_nav_returns_stale_cache_and_schedules_refresh(self) -> None:
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
        schedule_refresh.assert_called_once_with(["016664"])

    def test_prewarm_fund_nav_cache_async_schedules_default_funds(self) -> None:
        with (
            patch.object(server, "configured_fund_codes_from_constants", return_value=["016664", "118001"]),
            patch.object(server, "schedule_fund_nav_refresh") as schedule_refresh,
        ):
            server.prewarm_fund_nav_cache_async()

        schedule_refresh.assert_called_once_with(["016664", "118001"])

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
        response = server.app.test_client().get(
            "/api/marketstates?symbols=hkHSI,b_KOSPI,s_sh000001&now=2026-05-25T13:00:00%2B08:00"
        )

        self.assertEqual(response.status_code, 200)
        self.assertIn("X-Elapsed-ms", response.headers)
        payload = response.get_json()
        self.assertEqual(payload["hkHSI"]["state"], "holiday")
        self.assertEqual(payload["b_KOSPI"]["state"], "holiday")
        self.assertEqual(payload["s_sh000001"]["state"], "live")

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

    def test_prewarm_fund_backtest_cache_uses_configured_codes(self) -> None:
        with (
            patch.object(server, "configured_fund_codes_from_constants", return_value=["016664", "016664", "017436"]),
            patch.object(server, "compute_fund_backtest", return_value={"sampleCount": 12}) as compute,
        ):
            errors = server.prewarm_fund_backtest_cache(days=30)

        self.assertEqual(errors, [])
        self.assertEqual(compute.call_count, 2)
        compute.assert_any_call("016664", 30, refresh=False)
        compute.assert_any_call("017436", 30, refresh=False)

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
            response = server.app.test_client().get("/api/fundprofiles?codes=118001")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["118001"]["inceptionDate"], "2010-01-21")
        self.assertEqual(payload["118001"]["assetScale"], "31.69亿元")
        self.assertEqual(payload["118001"]["scaleDate"], "2026-03-31")
        self.assertEqual(payload["118001"]["managementFee"], "1.20%")
        self.assertEqual(payload["118001"]["custodianFee"], "0.20%")
        self.assertEqual(payload["118001"]["salesServiceFee"], "0.00%")

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

    def test_fund_history_without_refresh_updates_stale_sqlite_rows(self) -> None:
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
        self.assertEqual(payload["016664"][0]["FSRQ"], "2026-05-21")
        self.assertEqual(server.read_fund_history_from_db("016664", 1, 1)[0]["FSRQ"], "2026-05-21")

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

    def test_fund_backtest_uses_cached_stock_history(self) -> None:
        server.store_fund_history(
            "016664",
            [
                {"FSRQ": "2026-05-19", "DWJZ": "1.0000", "JZZZL": "1.00"},
                {"FSRQ": "2026-05-20", "DWJZ": "1.0200", "JZZZL": "2.00"},
                {"FSRQ": "2026-05-21", "DWJZ": "1.0098", "JZZZL": "-1.00"},
            ],
        )
        server.store_stock_history(
            "gb_nvda",
            'var _=([{"d":"2026-05-18","c":"100"},{"d":"2026-05-19","c":"102"},'
            '{"d":"2026-05-20","c":"105"},{"d":"2026-05-21","c":"103"}]);',
        )
        server.store_stock_history(
            "gb_tsm",
            'var _=([{"d":"2026-05-18","c":"50"},{"d":"2026-05-19","c":"51"},'
            '{"d":"2026-05-20","c":"52"},{"d":"2026-05-21","c":"51"}]);',
        )

        response = server.app.test_client().get("/api/fundbacktest?codes=016664&days=3")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        result = payload["016664"]
        self.assertEqual(result["sampleCount"], 3)
        self.assertEqual(result["modelVersion"], server.BACKTEST_MODEL_VERSION)
        self.assertGreater(result["coverageAvg"], 0)
        self.assertIn("mae", result["raw"])
        self.assertIn("beta", result["fit"])

    def test_fund_backtest_rejects_invalid_codes(self) -> None:
        response = server.app.test_client().get("/api/fundbacktest?codes=abc123")

        self.assertEqual(response.status_code, 400)
        self.assertIn("Invalid fund code", response.get_data(as_text=True))

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

    def test_market_history_without_refresh_updates_stale_sqlite_rows(self) -> None:
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
        self.assertEqual(payload[-1]["date"], "2026-05-19")
        rows = server.read_market_history_from_db("sina-us", ".INX")
        self.assertEqual(rows[-1]["date"], "2026-05-19")

    def test_market_returns_returns_cached_rows_and_schedules_stale_refresh(self) -> None:
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
        self.assertEqual(scheduled, [("sina-us", ".INX")])

    def test_market_returns_schedules_missing_sqlite_rows_without_blocking(self) -> None:
        scheduled: list[tuple[str, str]] = []
        with patch.object(server, "schedule_market_history_refresh", side_effect=lambda source, symbol: scheduled.append((source, symbol))):
            response = server.app.test_client().get("/api/marketreturns?items=sina-cn:sh000688")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertNotIn("sina-cn:sh000688", payload)
        self.assertEqual(scheduled, [("sina-cn", "sh000688")])

    def test_sina_zero_cn_index_quote_falls_back_to_latest_history_close(self) -> None:
        server.store_market_history(
            "sina-cn",
            "sz399006",
            '[{"day":"2026-06-24","close":"4251.43"},{"day":"2026-06-25","close":"4371.99"}]',
        )

        text = server.sanitize_sina_quote_text(
            'var hq_str_s_sz399006="创业板指,0.00,0.00,0.00,0,0";',
            ["s_sz399006"],
        )

        self.assertIn('hq_str_s_sz399006="创业板指,4371.9900,120.5600,2.84', text)
        self.assertIn("2026-06-25", text)
        health = server.upstream_health_snapshot()
        self.assertEqual(health["fallbackCount"], 1)
        self.assertEqual(health["issues"][0]["key"], "quote:s_sz399006")

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
