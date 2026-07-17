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
HISTORY_SOURCES = {"sina-cn", "sina-us", "sina-futures", "tencent-hk", "twse-official"}


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
        for holding in fund.get("holdings", []):
            if isinstance(holding, dict) and SINA_SYMBOL_RE.fullmatch(str(holding.get("sinaSymbol") or "")):
                symbols.append(str(holding["sinaSymbol"]))
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
            })
        return rows
    return []
