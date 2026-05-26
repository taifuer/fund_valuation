from __future__ import annotations

import os
import sqlite3
import tempfile
import unittest
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
                """
            )
        with server._RATE_LIMIT_GUARD:
            server._RATE_LIMIT_BUCKETS.clear()

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

    def test_sina_proxy_decodes_gb18030_fund_name(self) -> None:
        upstream_body = 'var hq_str_f_118001="易方达亚洲精选股票(QDII),1.693,1.693,1.673,2026-05-21,22.6875";'.encode("gb18030")

        with patch.object(server, "fetch_upstream", return_value=(200, "text/plain; charset=utf-8", upstream_body)):
            response = server.app.test_client().get("/api/sina?list=f_118001")

        self.assertEqual(response.status_code, 200)
        self.assertIn("charset=utf-8", response.content_type)
        self.assertIn("易方达亚洲精选股票(QDII)", response.get_data(as_text=True))
        self.assertNotIn("�", response.get_data(as_text=True))

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
        payload = response.get_json()
        self.assertEqual(payload["hkHSI"]["state"], "holiday")
        self.assertEqual(payload["b_KOSPI"]["state"], "holiday")
        self.assertEqual(payload["s_sh000001"]["state"], "live")

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
