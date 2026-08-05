from __future__ import annotations

from collections.abc import Callable
from typing import Any


PriceLookup = Callable[[str, str], float | None]
FxLookup = Callable[[str, str], float | None]
BenchmarkLookup = Callable[[str, str, str], float | None]


def compounded_return(price_return: float, fx_return: float) -> float:
    return (1 + price_return) * (1 + fx_return) - 1


def relative_change(current: float | None, basis: float | None) -> float | None:
    if current is None or basis is None or current <= 0 or basis <= 0:
        return None
    return current / basis - 1


def estimate_cumulative_return(
    holdings: list[dict[str, Any]],
    *,
    base_date: str,
    target_date: str,
    price_lookup: PriceLookup,
    fx_lookup: FxLookup,
    benchmark: dict[str, str] | None = None,
    benchmark_lookup: BenchmarkLookup | None = None,
) -> dict[str, Any] | None:
    """Estimate cumulative CNY return between two fund valuation dates.

    Disclosed holdings contribute at their disclosed portfolio weights. The
    remaining portfolio weight uses an explicitly configured broad benchmark.
    Coverage normalization is retained only as a documented fallback when that
    benchmark series is unavailable.
    """
    contribution = 0.0
    local_contribution = 0.0
    covered_weight = 0.0
    priced_count = 0
    components: list[dict[str, Any]] = []

    for holding in holdings:
        symbol = str(holding.get("sinaSymbol") or "")
        weight = float(holding.get("weight") or 0)
        currency = str(holding.get("currency") or "CNY")
        if not symbol or weight <= 0:
            continue
        base_price = price_lookup(symbol, base_date)
        target_price = price_lookup(symbol, target_date)
        price_return = relative_change(target_price, base_price)
        if price_return is None:
            continue
        base_fx = 1.0
        target_fx = 1.0
        fx_return = 0.0
        if currency != "CNY":
            base_fx = fx_lookup(currency, base_date)
            target_fx = fx_lookup(currency, target_date)
            resolved_fx = relative_change(target_fx, base_fx)
            if resolved_fx is None:
                continue
            fx_return = resolved_fx
        combined = compounded_return(price_return, fx_return)
        local_contribution += weight * price_return
        weighted_contribution = weight * combined
        contribution += weighted_contribution
        covered_weight += weight
        priced_count += 1
        components.append({
            "sinaSymbol": symbol,
            "symbol": str(holding.get("symbol") or ""),
            "name": str(holding.get("name") or ""),
            "weight": weight,
            "currency": currency,
            "basePrice": float(base_price),
            "targetPrice": float(target_price),
            "baseFxRate": float(base_fx),
            "targetFxRate": float(target_fx),
            "priceReturn": price_return,
            "fxReturn": fx_return,
            "combinedReturn": combined,
            "weightedContribution": weighted_contribution,
        })

    if covered_weight <= 0:
        return None

    residual_weight = max(1.0 - covered_weight, 0.0)
    benchmark_return: float | None = None
    benchmark_source = ""
    benchmark_symbol = ""
    benchmark_currency = "CNY"
    benchmark_component: dict[str, Any] | None = None
    if benchmark and benchmark_lookup:
        benchmark_source = str(benchmark.get("source") or "")
        benchmark_symbol = str(benchmark.get("symbol") or "")
        benchmark_currency = str(benchmark.get("currency") or "CNY")
        benchmark_base = benchmark_lookup(benchmark_source, benchmark_symbol, base_date)
        benchmark_target = benchmark_lookup(benchmark_source, benchmark_symbol, target_date)
        benchmark_price_return = relative_change(benchmark_target, benchmark_base)
        benchmark_return = benchmark_price_return
        benchmark_base_fx = 1.0
        benchmark_target_fx = 1.0
        benchmark_fx_return = 0.0
        if benchmark_return is not None and benchmark_currency != "CNY":
            benchmark_base_fx = fx_lookup(benchmark_currency, base_date)
            benchmark_target_fx = fx_lookup(benchmark_currency, target_date)
            benchmark_fx_return = relative_change(benchmark_target_fx, benchmark_base_fx)
            if benchmark_fx_return is None:
                benchmark_return = None
            else:
                benchmark_return = compounded_return(benchmark_return, benchmark_fx_return)
        if benchmark_return is not None:
            benchmark_component = {
                "source": benchmark_source,
                "symbol": benchmark_symbol,
                "currency": benchmark_currency,
                "weight": residual_weight,
                "baseValue": float(benchmark_base),
                "targetValue": float(benchmark_target),
                "baseFxRate": float(benchmark_base_fx),
                "targetFxRate": float(benchmark_target_fx),
                "priceReturn": float(benchmark_price_return),
                "fxReturn": float(benchmark_fx_return),
                "combinedReturn": benchmark_return,
                "weightedContribution": residual_weight * benchmark_return,
            }

    if benchmark_return is not None:
        estimated_return = contribution + residual_weight * benchmark_return
        model = "holdingsBenchmark"
        for component in components:
            component["contribution"] = component["weightedContribution"]
        if benchmark_component:
            benchmark_component["contribution"] = benchmark_component["weightedContribution"]
    else:
        estimated_return = contribution / covered_weight
        model = "coverageNormalizedFallback"
        for component in components:
            component["contribution"] = component["weightedContribution"] / covered_weight

    return {
        "return": estimated_return,
        "localReturn": local_contribution / covered_weight,
        "holdingContribution": contribution,
        "coveredWeight": covered_weight,
        "residualWeight": residual_weight,
        "pricedHoldingCount": priced_count,
        "benchmarkReturn": benchmark_return,
        "benchmarkSource": benchmark_source,
        "benchmarkSymbol": benchmark_symbol,
        "components": components,
        "benchmarkComponent": benchmark_component,
        "model": model,
    }


def linear_fit(pairs: list[tuple[float, float]]) -> tuple[float, float]:
    if len(pairs) < 2:
        return 0.0, 1.0
    mean_x = sum(item[0] for item in pairs) / len(pairs)
    mean_y = sum(item[1] for item in pairs) / len(pairs)
    variance = sum((item[0] - mean_x) ** 2 for item in pairs)
    if variance <= 1e-12:
        return 0.0, 1.0
    covariance = sum((x - mean_x) * (y - mean_y) for x, y in pairs)
    beta = covariance / variance
    alpha = mean_y - beta * mean_x
    return alpha, beta


def mean_absolute_error(pairs: list[tuple[float, float]], alpha: float = 0.0, beta: float = 1.0) -> float:
    if not pairs:
        return float("inf")
    return sum(abs((alpha + beta * predicted) - actual) for predicted, actual in pairs) / len(pairs)


def select_calibration(
    pairs: list[tuple[float, float]],
    *,
    minimum_samples: int = 30,
    minimum_improvement: float = 0.10,
) -> dict[str, Any]:
    """Select a leakage-resistant correction using chronological holdout data."""
    if len(pairs) < minimum_samples:
        return {"applied": False, "sampleCount": len(pairs), "reason": "insufficientSamples"}
    split = max(int(len(pairs) * 0.7), 2)
    if len(pairs) - split < 5:
        return {"applied": False, "sampleCount": len(pairs), "reason": "insufficientValidation"}
    train = pairs[:split]
    validation = pairs[split:]
    alpha, beta = linear_fit(train)
    alpha = max(min(alpha, 0.005), -0.005)
    beta = max(min(beta, 1.5), 0.5)
    raw_mae = mean_absolute_error(validation)
    fitted_mae = mean_absolute_error(validation, alpha, beta)
    improvement = (raw_mae - fitted_mae) / raw_mae if raw_mae > 0 else 0.0
    applied = fitted_mae < raw_mae and improvement >= minimum_improvement
    return {
        "applied": applied,
        "sampleCount": len(pairs),
        "alpha": alpha,
        "beta": beta,
        "rawMae": raw_mae,
        "fittedMae": fitted_mae,
        "improvement": improvement,
        "reason": "validated" if applied else "noMaterialImprovement",
    }
