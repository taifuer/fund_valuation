from __future__ import annotations

import calendar
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from .config import configured_fund_codes, configured_market_return_items, load_universe
from .fx_history import ECB_CURRENCIES, fx_history_summary
from .storage import get_conn


def expected_holding_periods(*, years: int = 3, as_of: date | None = None) -> list[dict[str, Any]]:
    current = as_of or datetime.now(ZoneInfo("Asia/Shanghai")).date()
    earliest = current - timedelta(days=max(years, 1) * 366)
    periods: list[dict[str, Any]] = []
    for year in range(earliest.year, current.year + 1):
        for quarter, month in enumerate((3, 6, 9, 12), start=1):
            report_date = date(year, month, calendar.monthrange(year, month)[1])
            available_date = report_date + timedelta(days=45)
            if report_date < earliest or available_date > current:
                continue
            periods.append({
                "year": year,
                "quarter": quarter,
                "reportDate": report_date.isoformat(),
                "availableDate": available_date.isoformat(),
            })
    return periods


def missing_holding_requests(*, years: int = 3, as_of: date | None = None) -> list[dict[str, Any]]:
    periods = expected_holding_periods(years=years, as_of=as_of)
    codes = configured_fund_codes()
    inception_dates = fund_inception_dates()
    with get_conn() as conn:
        existing = {
            (str(code), str(report_date))
            for code, report_date in conn.execute(
                "SELECT DISTINCT code, report_date FROM fund_holdings WHERE code IN ({})".format(
                    ",".join("?" for _ in codes)
                ),
                codes,
            ).fetchall()
        } if codes else set()
    return [
        {"code": code, **period}
        for period in reversed(periods)
        for code in codes
        if str(period["reportDate"]) >= inception_dates.get(code, "0000-00-00")
        if (code, str(period["reportDate"])) not in existing
    ]


def fund_inception_dates() -> dict[str, str]:
    results: dict[str, str] = {}
    for fund in load_universe()["funds"]:
        if not isinstance(fund, dict):
            continue
        profile = fund.get("profile") if isinstance(fund.get("profile"), dict) else {}
        results[str(fund.get("code") or "")] = str(profile.get("inceptionDate") or "")
    return results


def historical_data_coverage(*, years: int = 3, as_of: date | None = None) -> dict[str, Any]:
    codes = configured_fund_codes()
    market_items = configured_market_return_items()
    periods = expected_holding_periods(years=years, as_of=as_of)
    all_expected_dates = {str(period["reportDate"]) for period in periods}
    inception_dates = fund_inception_dates()

    with get_conn() as conn:
        nav_rows = conn.execute(
            "SELECT code, MIN(date), MAX(date), COUNT(*) FROM fund_nav_history GROUP BY code"
        ).fetchall()
        holding_rows = conn.execute(
            "SELECT code, report_date FROM fund_holdings GROUP BY code, report_date"
        ).fetchall()
        market_rows = conn.execute(
            "SELECT source, symbol, MIN(date), MAX(date), COUNT(*) FROM market_history GROUP BY source, symbol"
        ).fetchall()

    nav_by_code = {
        str(code): {"startDate": str(start), "endDate": str(end), "count": int(count)}
        for code, start, end, count in nav_rows
    }
    holdings_by_code: dict[str, set[str]] = {}
    for code, report_date in holding_rows:
        holdings_by_code.setdefault(str(code), set()).add(str(report_date))
    market_by_item = {
        f"{source}:{symbol}": {"startDate": str(start), "endDate": str(end), "count": int(count)}
        for source, symbol, start, end, count in market_rows
    }

    funds: list[dict[str, Any]] = []
    for code in codes:
        expected_dates = {
            report_date for report_date in all_expected_dates
            if report_date >= inception_dates.get(code, "0000-00-00")
        }
        available_periods = holdings_by_code.get(code, set())
        missing_periods = sorted(expected_dates - available_periods, reverse=True)
        funds.append({
            "code": code,
            "nav": nav_by_code.get(code, {"startDate": "", "endDate": "", "count": 0}),
            "holdingPeriodCount": len(available_periods & expected_dates),
            "expectedHoldingPeriodCount": len(expected_dates),
            "latestHoldingDate": max(available_periods) if available_periods else "",
            "missingHoldingPeriods": missing_periods,
        })

    markets = [
        {"item": item, **market_by_item.get(item, {"startDate": "", "endDate": "", "count": 0})}
        for item in market_items
    ]
    fx = fx_history_summary()
    summary = {
        "fundCount": len(funds),
        "fundsWithoutNav": sum(1 for item in funds if int(item["nav"]["count"]) == 0),
        "expectedHoldingPeriods": len(all_expected_dates),
        "fundsWithHoldingGaps": sum(1 for item in funds if item["missingHoldingPeriods"]),
        "missingHoldingPeriods": sum(len(item["missingHoldingPeriods"]) for item in funds),
        "marketCount": len(markets),
        "marketsWithoutHistory": sum(1 for item in markets if int(item["count"]) == 0),
        "fxCurrenciesMissing": sum(1 for currency in ECB_CURRENCIES if currency not in fx),
    }
    return {
        "status": "ok" if all(summary[key] == 0 for key in (
            "fundsWithoutNav", "fundsWithHoldingGaps", "marketsWithoutHistory", "fxCurrenciesMissing"
        )) else "incomplete",
        "years": years,
        "summary": summary,
        "funds": funds,
        "markets": markets,
        "fx": fx,
    }
