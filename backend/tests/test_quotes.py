from __future__ import annotations

import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

from backend.quotes import normalize_quote_line


def captured_at(value: str) -> int:
    return int(datetime.fromisoformat(value).replace(tzinfo=ZoneInfo("Asia/Shanghai")).timestamp() * 1000)


class QuoteNormalizationTests(unittest.TestCase):
    def test_full_cn_quote_keeps_current_exchange_time(self) -> None:
        fields = ["测试", "10", "10", "10.2", *(["0"] * 26), "2026-07-01", "10:15:00", "00"]
        record = normalize_quote_line(
            "sz159326",
            f'var hq_str_sz159326="{",".join(fields)}";',
            captured_at("2026-07-01T10:16:00"),
        )

        self.assertIsNotNone(record)
        assert record is not None
        self.assertEqual(record["time"], "2026-07-01 10:15:00")
        self.assertTrue(record["dateReliable"])
        self.assertAlmostEqual(record["changePercent"], 2.0)

    def test_stale_cn_quote_uses_capture_time_and_marks_date_unreliable(self) -> None:
        fields = ["测试", "10", "10", "10.2", *(["0"] * 26), "2026-06-20", "15:00:00", "00"]
        record = normalize_quote_line(
            "sz159326",
            f'var hq_str_sz159326="{",".join(fields)}";',
            captured_at("2026-07-01T09:00:00"),
        )

        self.assertIsNotNone(record)
        assert record is not None
        self.assertEqual(record["time"], "2026-07-01 09:00:00")
        self.assertFalse(record["dateReliable"])

    def test_undated_nikkei_short_quote_is_not_promoted_to_structured_data(self) -> None:
        record = normalize_quote_line(
            "int_nikkei",
            'var hq_str_int_nikkei="日经225,44946.64,10.00,0.02";',
            captured_at("2026-07-01T09:00:00"),
        )

        self.assertIsNone(record)

    def test_dated_nikkei_previous_close_survives_long_weekend(self) -> None:
        record = normalize_quote_line(
            "int_nikkei",
            'var hq_str_int_nikkei="日经225,64140.90,-2694.64,-4.03,2026-07-17,14:30:01";',
            captured_at("2026-07-20T09:30:00"),
        )

        self.assertIsNotNone(record)
        assert record is not None
        self.assertEqual(record["price"], 64140.9)
        self.assertEqual(record["time"], "2026-07-17 14:30:01")
        self.assertFalse(record["dateReliable"])

    def test_implausible_index_change_is_rejected(self) -> None:
        record = normalize_quote_line(
            "s_sh000001",
            'var hq_str_s_sh000001="上证指数,3200,1600,50.00,2026-07-01,10:00:00";',
            captured_at("2026-07-01T10:00:00"),
        )

        self.assertIsNone(record)

    def test_kospi_timestamp_is_already_beijing_time(self) -> None:
        record = normalize_quote_line(
            "b_KOSPI",
            'var hq_str_b_KOSPI="韩国KOSPI指数,7648.09,-655.32,-7.89,2:27 AM,14:27:00,2026-07-02,14:33:00,7933.10,8303.41";',
            captured_at("2026-07-02T14:34:00"),
        )

        self.assertIsNotNone(record)
        assert record is not None
        self.assertEqual(record["time"], "2026-07-02 14:33:00")

    def test_us_post_market_change_uses_regular_close_as_its_basis(self) -> None:
        record = normalize_quote_line(
            "gb_amd",
            'var hq_str_gb_amd="AMD,518.5800,7.00,2026-08-05 08:14:57,33.9400,504.0000,'
            '530.1300,502.2000,584.7300,149.2200,48463564,29657103,845596879891,3.08,'
            '168.370000,0.00,0.00,0.00,0.00,1630600640,73,472.8504,-8.82,-45.73,'
            'Aug 04 07:59PM EDT,Aug 04 04:00PM EDT,484.6400,11354303,1,2026,0,0,0,0,0,0";',
            captured_at("2026-08-05T08:15:00"),
        )

        self.assertIsNotNone(record)
        assert record is not None
        self.assertEqual(record["session"], "post")
        self.assertAlmostEqual(record["price"], 472.8504)
        self.assertAlmostEqual(record["previousClose"], 518.58)
        self.assertAlmostEqual(record["changePercent"], -8.82)
        self.assertAlmostEqual(record["regularPrice"], 518.58)

    def test_us_post_market_change_is_computed_when_upstream_percent_is_missing(self) -> None:
        line = (
            'var hq_str_gb_amd="AMD,518.5800,7.00,2026-08-05 08:14:57,33.9400,504.0000,'
            '530.1300,502.2000,584.7300,149.2200,48463564,29657103,845596879891,3.08,'
            '168.370000,0.00,0.00,0.00,0.00,1630600640,73,472.8504,,-45.73,'
            'Aug 04 07:59PM EDT,Aug 04 04:00PM EDT,484.6400,11354303,1,2026,0,0,0,0,0,0";'
        )
        record = normalize_quote_line("gb_amd", line, captured_at("2026-08-05T08:15:00"))

        self.assertIsNotNone(record)
        assert record is not None
        self.assertAlmostEqual(record["changePercent"], (472.8504 / 518.58 - 1) * 100, places=4)

    def test_backend_adapted_equity_quote_uses_compact_fields(self) -> None:
        record = normalize_quote_line(
            "jp6857",
            'var hq_str_jp6857="Advantest,19320.0000,-250.0000,-1.2775,2026-07-31,14:30:00";',
            captured_at("2026-07-31T14:31:00"),
        )

        self.assertIsNotNone(record)
        assert record is not None
        self.assertEqual(record["price"], 19320)
        self.assertEqual(record["previousClose"], 19570)
        self.assertEqual(record["changePercent"], -1.2775)
        self.assertEqual(record["time"], "2026-07-31 14:30:00")


if __name__ == "__main__":
    unittest.main()
