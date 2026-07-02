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


if __name__ == "__main__":
    unittest.main()
