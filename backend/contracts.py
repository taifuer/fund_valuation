from __future__ import annotations

from typing import Any


API_SCHEMA_VERSION = 1
DASHBOARD_SCHEMA_VERSION = 1


def validate_dashboard_payload(payload: dict[str, Any]) -> dict[str, Any]:
    if payload.get("schemaVersion") != DASHBOARD_SCHEMA_VERSION:
        raise ValueError("Unsupported dashboard schema version")
    if not isinstance(payload.get("quotesText"), str) or not isinstance(payload.get("fxText"), str):
        raise ValueError("Dashboard compatibility fields must be strings")
    if not isinstance(payload.get("marketStates"), dict) or not isinstance(payload.get("quotes"), dict):
        raise ValueError("Dashboard structured fields must be objects")
    required_quote_fields = ("symbol", "price", "previousClose", "changePercent", "fetchedAt")
    for symbol, quote in payload["quotes"].items():
        if not isinstance(symbol, str) or not isinstance(quote, dict):
            raise ValueError("Invalid structured quote entry")
        if any(field not in quote for field in required_quote_fields):
            raise ValueError(f"Structured quote is missing required fields: {symbol}")
    return payload
