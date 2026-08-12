from __future__ import annotations

import unittest

from backend.estimation import estimate_cumulative_return, linear_fit, select_calibration


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
        self.assertAlmostEqual(result["components"][0]["contribution"], 0.06)
        self.assertAlmostEqual(result["components"][0]["targetPrice"], 110)
        self.assertAlmostEqual(result["benchmarkComponent"]["contribution"], 0.02)

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
        self.assertAlmostEqual(result["components"][0]["contribution"], 0.10)
        self.assertIsNone(result["benchmarkComponent"])

    def test_calibration_requires_samples_and_validation_improvement(self) -> None:
        self.assertFalse(select_calibration([(0.01, 0.02)] * 10)["applied"])
        pairs = [(index / 1000, 0.001 + 1.2 * index / 1000) for index in range(40)]
        selected = select_calibration(pairs)
        self.assertTrue(selected["applied"])
        self.assertGreater(selected["improvement"], 0.1)

    def test_validated_calibration_refits_all_available_samples(self) -> None:
        pairs = []
        for index in range(40):
            predicted = (index + 1) / 1000
            actual = (
                0.001 + 1.1 * predicted
                if index < 28
                else 0.002 + 1.2 * predicted
            )
            pairs.append((predicted, actual))

        selected = select_calibration(pairs)
        expected_alpha, expected_beta = linear_fit(pairs)

        self.assertTrue(selected["applied"])
        self.assertAlmostEqual(selected["alpha"], expected_alpha)
        self.assertAlmostEqual(selected["beta"], expected_beta)
        self.assertNotAlmostEqual(selected["beta"], selected["validationBeta"])


if __name__ == "__main__":
    unittest.main()
