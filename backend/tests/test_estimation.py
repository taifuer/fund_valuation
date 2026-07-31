from __future__ import annotations

import unittest

from backend.estimation import estimate_cumulative_return, select_calibration


class EstimateCalculationTests(unittest.TestCase):
    def test_uses_benchmark_for_undisclosed_weight(self) -> None:
        prices = {
            ("gb_a", "2026-07-29"): 100,
            ("gb_a", "2026-07-30"): 110,
        }
        fx = {
            ("USD", "2026-07-29"): 7.0,
            ("USD", "2026-07-30"): 7.0,
        }
        benchmark = {
            ("sina-us", ".NDX", "2026-07-29"): 100,
            ("sina-us", ".NDX", "2026-07-30"): 105,
        }
        result = estimate_cumulative_return(
            [{"sinaSymbol": "gb_a", "weight": 0.6, "currency": "USD"}],
            base_date="2026-07-29",
            target_date="2026-07-30",
            price_lookup=lambda symbol, day: prices.get((symbol, day)),
            fx_lookup=lambda currency, day: fx.get((currency, day)),
            benchmark={"source": "sina-us", "symbol": ".NDX", "currency": "USD"},
            benchmark_lookup=lambda source, symbol, day: benchmark.get((source, symbol, day)),
        )

        self.assertIsNotNone(result)
        assert result is not None
        self.assertAlmostEqual(result["return"], 0.08)
        self.assertEqual(result["model"], "holdingsBenchmark")

    def test_falls_back_to_coverage_normalization_without_benchmark(self) -> None:
        prices = {("gb_a", "a"): 100, ("gb_a", "b"): 110}
        result = estimate_cumulative_return(
            [{"sinaSymbol": "gb_a", "weight": 0.5, "currency": "CNY"}],
            base_date="a",
            target_date="b",
            price_lookup=lambda symbol, day: prices.get((symbol, day)),
            fx_lookup=lambda _currency, _day: None,
        )
        self.assertIsNotNone(result)
        assert result is not None
        self.assertAlmostEqual(result["return"], 0.10)
        self.assertEqual(result["model"], "coverageNormalizedFallback")

    def test_calibration_requires_samples_and_validation_improvement(self) -> None:
        self.assertFalse(select_calibration([(0.01, 0.02)] * 10)["applied"])
        pairs = [(index / 1000, 0.001 + 1.2 * index / 1000) for index in range(40)]
        selected = select_calibration(pairs)
        self.assertTrue(selected["applied"])
        self.assertGreater(selected["improvement"], 0.1)


if __name__ == "__main__":
    unittest.main()
