from __future__ import annotations

import json
import re
import threading
from pathlib import Path
from typing import Any


ROOT_DIR = Path(__file__).resolve().parents[1]
UNIVERSE_FILE = ROOT_DIR / "config" / "universe.json"
_CACHE: dict[str, Any] | None = None
_GUARD = threading.Lock()
FUND_CODE_RE = re.compile(r"^\d{6}$")
SINA_SYMBOL_RE = re.compile(r"^[A-Za-z0-9_]{1,40}$")
HISTORY_SYMBOL_RE = re.compile(r"^[A-Za-z0-9_.-]{1,40}$")
HISTORY_SOURCES = {
    "sina-cn",
    "sina-us",
    "sina-futures",
    "tencent-hk",
    "twse-official",
    "naver-korea",
    "coinmetrics-crypto",
}
FUND_STRATEGIES = {"technology", "globalGrowth", "manufacturing", "healthcare", "emergingMarkets"}
FUND_ESTIMATE_MODES = {"holdings", "official"}
FUND_BENCHMARK_COMPONENT_KINDS = {"market", "stable"}


def normalize_fund_benchmark(fund: dict[str, Any]) -> dict[str, Any] | None:
    benchmark = fund.get("benchmark")
    if not isinstance(benchmark, dict):
        return None
    components = benchmark.get("components")
    if not isinstance(components, list):
        source = str(benchmark.get("source") or "")
        symbol = str(benchmark.get("symbol") or "")
        currency = str(benchmark.get("currency") or "CNY")
        if source not in HISTORY_SOURCES or not HISTORY_SYMBOL_RE.fullmatch(symbol):
            return None
        if currency not in {"CNY", "USD", "EUR", "JPY", "KRW", "HKD"}:
            return None
        return {"source": source, "symbol": symbol, "currency": currency}

    normalized_components: list[dict[str, Any]] = []
    for component in components:
        if not isinstance(component, dict):
            return None
        kind = str(component.get("kind") or "market")
        try:
            weight = float(component.get("weight") or 0)
        except (TypeError, ValueError):
            return None
        if kind not in FUND_BENCHMARK_COMPONENT_KINDS or weight <= 0 or weight > 1:
            return None
        label = str(component.get("label") or "")
        if kind == "stable":
            normalized_components.append({
                "kind": kind,
                "symbol": str(component.get("symbol") or "STABLE"),
                "currency": "CNY",
                "weight": weight,
                "label": label,
            })
            continue
        source = str(component.get("source") or "")
        symbol = str(component.get("symbol") or "")
        currency = str(component.get("currency") or "CNY")
        sina_symbol = str(component.get("sinaSymbol") or "")
        if source not in HISTORY_SOURCES or not HISTORY_SYMBOL_RE.fullmatch(symbol):
            return None
        if currency not in {"CNY", "USD", "EUR", "JPY", "KRW", "HKD"}:
            return None
        if sina_symbol and not SINA_SYMBOL_RE.fullmatch(sina_symbol):
            return None
        normalized_components.append({
            "kind": kind,
            "source": source,
            "symbol": symbol,
            "sinaSymbol": sina_symbol,
            "currency": currency,
            "weight": weight,
            "label": label,
        })
    if not normalized_components or abs(sum(item["weight"] for item in normalized_components) - 1) > 1e-6:
        return None
    benchmark_id = str(benchmark.get("id") or "")
    if not HISTORY_SYMBOL_RE.fullmatch(benchmark_id):
        return None
    return {
        "source": "composite",
        "symbol": benchmark_id,
        "currency": "CNY",
        "name": str(benchmark.get("name") or "复合基准"),
        "components": normalized_components,
    }


def load_universe() -> dict[str, Any]:
    global _CACHE
    if _CACHE is not None:
        return _CACHE
    with _GUARD:
        if _CACHE is not None:
            return _CACHE
        with UNIVERSE_FILE.open(encoding="utf-8") as handle:
            payload = json.load(handle)
        if not isinstance(payload, dict) or payload.get("version") != 1:
            raise RuntimeError("Unsupported config/universe.json schema")
        for key in ("indices", "marketAssets", "etfAssets", "rankingIndices", "rankingSectorEtfs", "rankingIndexEtfs", "funds"):
            if not isinstance(payload.get(key), list):
                raise RuntimeError(f"Invalid universe collection: {key}")
        for key in ("indices", "marketAssets", "etfAssets", "rankingIndices", "rankingSectorEtfs", "rankingIndexEtfs"):
            symbols: set[str] = set()
            for item in payload[key]:
                symbol = str(item.get("symbol") or "") if isinstance(item, dict) else ""
                if not symbol or symbol in symbols:
                    raise RuntimeError(f"Invalid or duplicate symbol in universe collection: {key}")
                symbols.add(symbol)
        fund_codes: set[str] = set()
        for fund in payload["funds"]:
            code = str(fund.get("code") or "") if isinstance(fund, dict) else ""
            if not FUND_CODE_RE.fullmatch(code) or code in fund_codes:
                raise RuntimeError("Invalid or duplicate fund code in universe configuration")
            fund_codes.add(code)
            strategy = str(fund.get("strategy") or "")
            if strategy and strategy not in FUND_STRATEGIES:
                raise RuntimeError(f"Invalid strategy for fund {code}")
            estimate_mode = str(fund.get("estimateMode") or "holdings")
            if estimate_mode not in FUND_ESTIMATE_MODES:
                raise RuntimeError(f"Invalid estimate mode for fund {code}")
            if fund.get("benchmark") is not None and normalize_fund_benchmark(fund) is None:
                raise RuntimeError(f"Invalid benchmark for fund {code}")
            holdings = fund.get("holdings")
            if not isinstance(holdings, list):
                raise RuntimeError(f"Invalid holdings for fund {code}")
        _CACHE = payload
        return payload


def configured_fund_codes() -> list[str]:
    return list(dict.fromkeys(
        str(fund.get("code"))
        for fund in load_universe()["funds"]
        if isinstance(fund, dict) and FUND_CODE_RE.fullmatch(str(fund.get("code") or ""))
    ))


def fund_estimate_enabled(code: str) -> bool:
    for fund in load_universe()["funds"]:
        if isinstance(fund, dict) and str(fund.get("code") or "") == code:
            return str(fund.get("estimateMode") or "holdings") != "official"
    return True


def quote_supported_symbol(symbol: str, explicit: object = None) -> bool:
    """Return whether the configured quote provider supports this holding."""
    normalized = str(symbol or "").strip().lower()
    return explicit is not False and bool(SINA_SYMBOL_RE.fullmatch(normalized))


def configured_sina_symbols() -> list[str]:
    symbols: list[str] = []
    payload = load_universe()
    for key in ("indices", "marketAssets", "etfAssets", "rankingIndices", "rankingSectorEtfs", "rankingIndexEtfs"):
        for item in payload[key]:
            if not isinstance(item, dict):
                continue
            candidates = [item.get("sinaSymbol")]
            futures = item.get("futures")
            if isinstance(futures, dict):
                candidates.append(futures.get("sinaSymbol"))
            symbols.extend(str(value) for value in candidates if SINA_SYMBOL_RE.fullmatch(str(value or "")))
    for fund in payload["funds"]:
        if not isinstance(fund, dict):
            continue
        if not fund_estimate_enabled(str(fund.get("code") or "")):
            continue
        benchmark = normalize_fund_benchmark(fund)
        if benchmark:
            components = benchmark.get("components")
            candidates = components if isinstance(components, list) else [fund.get("benchmark")]
            for component in candidates:
                benchmark_quote_symbol = str(component.get("sinaSymbol") or "") if isinstance(component, dict) else ""
                if SINA_SYMBOL_RE.fullmatch(benchmark_quote_symbol):
                    symbols.append(benchmark_quote_symbol)
        for holding in fund.get("holdings", []):
            if not isinstance(holding, dict):
                continue
            symbol = str(holding.get("sinaSymbol") or "")
            if quote_supported_symbol(symbol, holding.get("quoteSupported")):
                symbols.append(symbol)
    return sorted(dict.fromkeys(symbols))


def configured_unsupported_quote_symbols() -> list[str]:
    symbols: list[str] = []
    for fund in load_universe()["funds"]:
        if not isinstance(fund, dict):
            continue
        if not fund_estimate_enabled(str(fund.get("code") or "")):
            continue
        for holding in fund.get("holdings", []):
            if not isinstance(holding, dict):
                continue
            symbol = str(holding.get("sinaSymbol") or "")
            if SINA_SYMBOL_RE.fullmatch(symbol) and not quote_supported_symbol(
                symbol,
                holding.get("quoteSupported"),
            ):
                symbols.append(symbol)
    return sorted(dict.fromkeys(symbols))


def configured_market_return_items() -> list[str]:
    items: list[str] = []
    payload = load_universe()
    for key in ("indices", "marketAssets", "etfAssets", "rankingIndices", "rankingSectorEtfs", "rankingIndexEtfs"):
        for item in payload[key]:
            history = item.get("history") if isinstance(item, dict) else None
            if not isinstance(history, dict):
                continue
            source = str(history.get("source") or "")
            symbol = str(history.get("symbol") or "")
            if source in HISTORY_SOURCES and HISTORY_SYMBOL_RE.fullmatch(symbol):
                items.append(f"{source}:{symbol}")
    for fund in payload["funds"]:
        benchmark = normalize_fund_benchmark(fund) if isinstance(fund, dict) else None
        if not benchmark:
            continue
        components = benchmark.get("components")
        candidates = components if isinstance(components, list) else [benchmark]
        for component in candidates:
            if not isinstance(component, dict) or component.get("kind") == "stable":
                continue
            source = str(component.get("source") or "")
            symbol = str(component.get("symbol") or "")
            if source in HISTORY_SOURCES and HISTORY_SYMBOL_RE.fullmatch(symbol):
                items.append(f"{source}:{symbol}")
    return sorted(dict.fromkeys(items))


def default_fund_holdings(code: str) -> list[dict[str, Any]]:
    for fund in load_universe()["funds"]:
        if not isinstance(fund, dict) or str(fund.get("code")) != code:
            continue
        profile = fund.get("profile") if isinstance(fund.get("profile"), dict) else {}
        report_date = str(profile.get("scaleDate") or "")
        rows: list[dict[str, Any]] = []
        for rank, holding in enumerate(fund.get("holdings", []), start=1):
            if not isinstance(holding, dict):
                continue
            symbol = str(holding.get("symbol") or "")
            sina_symbol = str(holding.get("sinaSymbol") or "")
            if not symbol or not SINA_SYMBOL_RE.fullmatch(sina_symbol):
                continue
            rows.append({
                "code": code,
                "reportDate": report_date,
                "rank": rank,
                "stockCode": symbol,
                "symbol": symbol,
                "name": str(holding.get("name") or symbol),
                "weight": float(holding.get("weight") or 0),
                "market": str(holding.get("market") or ""),
                "sinaSymbol": sina_symbol,
                "currency": str(holding.get("currency") or "CNY"),
                "quoteSupported": quote_supported_symbol(sina_symbol, holding.get("quoteSupported")),
            })
        return rows
    return []


def fund_benchmark(code: str) -> dict[str, Any] | None:
    for fund in load_universe()["funds"]:
        if not isinstance(fund, dict) or str(fund.get("code")) != code:
            continue
        return normalize_fund_benchmark(fund)
    return None
