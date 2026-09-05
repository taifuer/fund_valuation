from __future__ import annotations

import unittest

from backend.estimation import estimate_cumulative_return, linear_fit, select_calibration


class EstimateCalculationTests(unittest.TestCase):
    def test_disclosed_equity_weight_does_not_treat_cash_as_stocks(self) -> None:
        result = estimate_cumulative_return(
            [{"sinaSymbol": "gb_a", "weight": 0.6, "currency": "CNY"}],
            base_date="a", target_date="b", equity_weight=0.8,
            price_lookup=lambda _symbol, day: 100 if day == "a" else 110,
            fx_lookup=lambda _currency, _day: 1,
            benchmark={"source": "sina-us", "symbol": ".NDX", "currency": "CNY"},
            benchmark_lookup=lambda _source, _symbol, day: 100 if day == "a" else 105,
        )
        self.assertAlmostEqual(result['return'], 0.07)
        self.assertAlmostEqual(result['residualWeight'], 0.2)

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

    def test_uses_weighted_composite_benchmark_for_undisclosed_weight(self) -> None:
        prices = {
            ("gb_a", "a"): 100,
            ("gb_a", "b"): 110,
        }
        fx = {
            ("USD", "a"): 7.0,
            ("USD", "b"): 7.1,
            ("HKD", "a"): 0.9,
            ("HKD", "b"): 0.9,
        }
        benchmark_values = {
            ("sina-us", "IXJ", "a"): 100,
            ("sina-us", "IXJ", "b"): 105,
            ("tencent-hk", "hk03069", "a"): 100,
            ("tencent-hk", "hk03069", "b"): 90,
        }
        benchmark = {
            "source": "composite",
            "symbol": "global-healthcare-v1",
            "name": "全球医疗复合代理",
            "components": [
                {"source": "sina-us", "symbol": "IXJ", "currency": "USD", "weight": 0.7},
                {"source": "tencent-hk", "symbol": "hk03069", "currency": "HKD", "weight": 0.1},
                {"kind": "stable", "symbol": "BOND_CASH", "currency": "CNY", "weight": 0.2},
            ],
        }

        result = estimate_cumulative_return(
            [{"sinaSymbol": "gb_a", "weight": 0.5, "currency": "USD"}],
            base_date="a",
            target_date="b",
            price_lookup=lambda symbol, day: prices.get((symbol, day)),
            fx_lookup=lambda currency, day: fx.get((currency, day)),
            benchmark=benchmark,
            benchmark_lookup=lambda source, symbol, day: benchmark_values.get((source, symbol, day)),
        )

        self.assertIsNotNone(result)
        assert result is not None
        stock_return = (1.1 * (7.1 / 7.0)) - 1
        global_healthcare_return = (1.05 * (7.1 / 7.0)) - 1
        composite_return = 0.7 * global_healthcare_return + 0.1 * -0.1
        self.assertAlmostEqual(result["return"], 0.5 * stock_return + 0.5 * composite_return)
        self.assertEqual(result["model"], "holdingsCompositeBenchmark")
        self.assertEqual(result["benchmarkName"], "全球医疗复合代理")
        self.assertEqual(len(result["benchmarkComponent"]["components"]), 3)
        self.assertAlmostEqual(result["benchmarkComponent"]["components"][2]["combinedReturn"], 0)

    def test_does_not_normalize_holdings_when_composite_history_is_missing(self) -> None:
        result = estimate_cumulative_return(
            [{"sinaSymbol": "gb_a", "weight": 0.5, "currency": "CNY"}],
            base_date="a",
            target_date="b",
            price_lookup=lambda _symbol, day: 100 if day == "a" else 110,
            fx_lookup=lambda _currency, _day: None,
            benchmark={
                "source": "composite",
                "symbol": "medical-v1",
                "components": [
                    {"source": "sina-us", "symbol": "IXJ", "currency": "USD", "weight": 0.8},
                    {"kind": "stable", "symbol": "CASH", "currency": "CNY", "weight": 0.2},
                ],
            },
            benchmark_lookup=lambda _source, _symbol, _day: None,
        )

        self.assertIsNone(result)

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
