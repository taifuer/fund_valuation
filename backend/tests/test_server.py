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
                DELETE FROM fund_purchase_status;
                DELETE FROM market_history;
                DELETE FROM market_intraday;
                """
            )

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


if __name__ == "__main__":
    unittest.main()
