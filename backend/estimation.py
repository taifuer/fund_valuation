from __future__ import annotations

from collections.abc import Callable
import math
from typing import Any


PriceLookup = Callable[[str, str], float | None]
FxLookup = Callable[[str, str], float | None]
BenchmarkLookup = Callable[[str, str, str], float | None]
PriceReturnLookup = Callable[[str, str, str, float, float], float | None]


def compounded_return(price_return: float, fx_return: float) -> float:
    return (1 + price_return) * (1 + fx_return) - 1


def relative_change(current: float | None, basis: float | None) -> float | None:
    if current is None or basis is None or not math.isfinite(current) or not math.isfinite(basis) or current <= 0 or basis <= 0:
        return None
    return current / basis - 1


def estimate_cumulative_return(
    holdings: list[dict[str, Any]],
    *,
    base_date: str,
    target_date: str,
    price_lookup: PriceLookup,
    fx_lookup: FxLookup,
    benchmark: dict[str, Any] | None = None,
    benchmark_lookup: BenchmarkLookup | None = None,
    equity_weight: float = 1.0,
    price_return_lookup: PriceReturnLookup | None = None,
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
        if not symbol or weight <= 0 or holding.get("currency") == "":
            continue
        base_price = price_lookup(symbol, base_date)
        target_price = price_lookup(symbol, target_date)
        price_return = relative_change(target_price, base_price)
        if price_return is not None and price_return_lookup is not None:
            price_return = price_return_lookup(symbol, base_date, target_date, base_price, target_price)
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

    equity_weight = max(covered_weight, min(equity_weight, 1.0))
    residual_weight = max(equity_weight - covered_weight, 0.0)
    benchmark_return: float | None = None
    benchmark_source = ""
    benchmark_symbol = ""
    benchmark_currency = "CNY"
    benchmark_name = ""
    benchmark_component: dict[str, Any] | None = None
    if benchmark and benchmark_lookup:
        benchmark_source = str(benchmark.get("source") or "")
        benchmark_symbol = str(benchmark.get("symbol") or "")
        benchmark_currency = str(benchmark.get("currency") or "CNY")
        benchmark_name = str(benchmark.get("name") or "")
        configured_components = benchmark.get("components")
        if isinstance(configured_components, list):
            component_rows: list[dict[str, Any]] = []
            composite_return = 0.0
            composite_available = True
            for raw_component in configured_components:
                if not isinstance(raw_component, dict):
                    composite_available = False
                    break
                kind = str(raw_component.get("kind") or "market")
                weight = float(raw_component.get("weight") or 0)
                source = str(raw_component.get("source") or "stable")
                symbol = str(raw_component.get("symbol") or "STABLE")
                currency = str(raw_component.get("currency") or "CNY")
                base_value = 1.0
                target_value = 1.0
                base_fx = 1.0
                target_fx = 1.0
                price_return = 0.0
                fx_return = 0.0
                combined = 0.0
                if kind != "stable":
                    resolved_base = benchmark_lookup(source, symbol, base_date)
                    resolved_target = benchmark_lookup(source, symbol, target_date)
                    resolved_price_return = relative_change(resolved_target, resolved_base)
                    if resolved_price_return is None:
                        composite_available = False
                        break
                    base_value = float(resolved_base)
                    target_value = float(resolved_target)
                    price_return = resolved_price_return
                    if currency != "CNY":
                        resolved_base_fx = fx_lookup(currency, base_date)
                        resolved_target_fx = fx_lookup(currency, target_date)
                        resolved_fx_return = relative_change(resolved_target_fx, resolved_base_fx)
                        if resolved_fx_return is None:
                            composite_available = False
                            break
                        base_fx = float(resolved_base_fx)
                        target_fx = float(resolved_target_fx)
                        fx_return = resolved_fx_return
                    combined = compounded_return(price_return, fx_return)
                weighted_return = weight * combined
                composite_return += weighted_return
                component_rows.append({
                    "kind": kind,
                    "source": source,
                    "symbol": symbol,
                    "label": str(raw_component.get("label") or symbol),
                    "currency": currency,
                    "weight": weight,
                    "baseValue": base_value,
                    "targetValue": target_value,
                    "baseFxRate": base_fx,
                    "targetFxRate": target_fx,
                    "priceReturn": price_return,
                    "fxReturn": fx_return,
                    "combinedReturn": combined,
                    "weightedReturn": weighted_return,
                    "weightedContribution": residual_weight * weighted_return,
                })
            if composite_available and component_rows:
                benchmark_return = composite_return
                benchmark_component = {
                    "source": benchmark_source,
                    "symbol": benchmark_symbol,
                    "label": benchmark_name or benchmark_symbol,
                    "currency": "CNY",
                    "weight": residual_weight,
                    "baseValue": 1.0,
                    "targetValue": 1.0 + composite_return,
                    "baseFxRate": 1.0,
                    "targetFxRate": 1.0,
                    "priceReturn": composite_return,
                    "fxReturn": 0.0,
                    "combinedReturn": composite_return,
                    "weightedContribution": residual_weight * composite_return,
                    "components": component_rows,
                }
        else:
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
                    "label": benchmark_name or benchmark_symbol,
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
        if benchmark_return is not None and benchmark_component is not None:
            benchmark_component["contribution"] = benchmark_component["weightedContribution"]

    if benchmark_return is not None:
        estimated_return = contribution + residual_weight * benchmark_return
        model = "holdingsCompositeBenchmark" if benchmark_source == "composite" else "holdingsBenchmark"
        for component in components:
            component["contribution"] = component["weightedContribution"]
    elif benchmark_source == "composite":
        return None
    else:
        estimated_return = contribution / covered_weight * equity_weight
        model = "coverageNormalizedFallback"
        for component in components:
            component["contribution"] = component["weightedContribution"] / covered_weight * equity_weight

    return {
        "return": estimated_return,
        "localReturn": local_contribution / covered_weight,
        "holdingContribution": contribution,
        "coveredWeight": covered_weight,
        "residualWeight": residual_weight,
        "equityWeight": equity_weight,
        "pricedHoldingCount": priced_count,
        "benchmarkReturn": benchmark_return,
        "benchmarkSource": benchmark_source,
        "benchmarkSymbol": benchmark_symbol,
        "benchmarkName": benchmark_name,
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


def estimate_aligned_returns(holdings: list[dict[str, Any]], *, target_date: str,
                             previous_date: str | None, **kwargs) -> tuple[dict | None, dict | None]:
    current = estimate_cumulative_return(holdings, target_date=target_date, **kwargs)
    previous = estimate_cumulative_return(holdings, target_date=previous_date, **kwargs) if previous_date else None
    if current and previous:
        current_symbols = {row['sinaSymbol'] for row in current['components']}
        previous_symbols = {row['sinaSymbol'] for row in previous['components']}
        if current_symbols != previous_symbols:
            # Changing quote coverage must not manufacture a daily gain/loss.
            common = current_symbols & previous_symbols
            aligned = [row for row in holdings if row.get('sinaSymbol') in common]
            current = estimate_cumulative_return(aligned, target_date=target_date, **kwargs)
            previous = estimate_cumulative_return(aligned, target_date=previous_date, **kwargs)
    return current, previous


def mean_absolute_error(pairs: list[tuple[float, float]], alpha: float = 0.0, beta: float = 1.0) -> float:
    if not pairs:
        return float("inf")
    return sum(abs((alpha + beta * predicted) - actual) for predicted, actual in pairs) / len(pairs)


def bounded_linear_fit(pairs: list[tuple[float, float]]) -> tuple[float, float]:
    alpha, beta = linear_fit(pairs)
    return max(min(alpha, 0.005), -0.005), max(min(beta, 1.5), 0.5)


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
    validation_alpha, validation_beta = bounded_linear_fit(train)
    raw_mae = mean_absolute_error(validation)
    fitted_mae = mean_absolute_error(validation, validation_alpha, validation_beta)
    improvement = (raw_mae - fitted_mae) / raw_mae if raw_mae > 0 else 0.0
    applied = fitted_mae < raw_mae and improvement >= minimum_improvement
    alpha, beta = bounded_linear_fit(pairs) if applied else (validation_alpha, validation_beta)
    return {
        "applied": applied,
        "sampleCount": len(pairs),
        "alpha": alpha,
        "beta": beta,
        "validationAlpha": validation_alpha,
        "validationBeta": validation_beta,
        "rawMae": raw_mae,
        "fittedMae": fitted_mae,
        "improvement": improvement,
        "reason": "validated" if applied else "noMaterialImprovement",
    }
