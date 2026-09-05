"""Conservative identifiers for disclosure rows without an exchange link."""
from __future__ import annotations

import re


# Numeric codes can collide across exchanges: require an issuer name as well.
# Issuer stock-information references are recorded in docs/VALUATION_QUALITY.md.
JAPAN_ISSUERS = {
    "285A": ("KIOXIA", "铠侠"), "6857": ("ADVANTEST", "爱德万"),
    "3110": ("NITTO BOSEKI", "日东纺"), "4004": ("RESONAC", "昭和电工"),
    "5801": ("FURUKAWA", "古河电"), "5802": ("SUMITOMO ELECTRIC", "住友电"),
    "5706": ("MITSUI MINING", "MITSUI KINZOKU", "三井金属"),
    "6594": ("NIDEC", "尼得科", "日本电产"), "6981": ("MURATA", "村田"),
    "4062": ("IBIDEN", "揖斐电"), "8035": ("TOKYO ELECTRON", "东京电子"),
    "5332": ("TOTO", "东陶"), "6976": ("TAIYO YUDEN", "太阳诱电"),
    "5803": ("FUJIKURA", "藤仓"), "6368": ("ORGANO", "奥加诺"),
}
JAPAN_ISINS = {
    "JP3236330001": "285A", "JP3684400009": "3110",
    "JP3914400001": "6981", "JP3452000007": "6976", "JP3811000003": "5803",
}
TAIWAN_ISSUERS = {
    "2330": ("TSMC", "TAIWAN SEMICONDUCTOR", "台积电"),
    "2383": ("ELITE MATERIAL", "台光电"), "3037": ("UNIMICRON", "欣兴"),
    "2317": ("HON HAI", "FOXCONN", "鸿海"), "3711": ("ASE", "日月光"),
}


def valid_isin(code: str) -> bool:
    if not re.fullmatch(r"[A-Z]{2}[A-Z0-9]{9}\d", code):
        return False
    digits = "".join(str(ord(char) - 55) if char.isalpha() else char for char in code)
    return sum(sum(divmod(int(char) * (2 if index % 2 else 1), 10))
               for index, char in enumerate(reversed(digits))) % 10 == 0


def classify_holding_symbol(stock_code: str, href: str, stock_name: str) -> tuple[str, str, str]:
    code = stock_code.strip().upper()
    name = stock_name.upper()
    match = re.search(r"/unify/r/(\d+)\.([A-Za-z0-9.]+)", href)
    if match:
        market_id, symbol = match.groups()
        if market_id in {"105", "106"}:
            return "us", f"gb_{symbol.lower()}", "USD"
        if market_id == "116" and re.fullmatch(r"\d{1,5}", symbol):
            return "hk", f"hk{symbol.zfill(5)}", "HKD"
        if market_id in {"0", "1"} and re.fullmatch(r"\d{6}", symbol):
            return "cn", f"{'sz' if market_id == '0' else 'sh'}{symbol}", "CNY"
    if code in JAPAN_ISINS:
        return "jp", f"jp{JAPAN_ISINS[code]}", "JPY"
    if valid_isin(code):
        if code.startswith("KR7") and code[3:9].isdigit():
            return "kr", f"kr{code[3:9]}", "KRW"
        return {"JP": ("jp", "", "JPY"), "TW": ("tw", "", "TWD")}.get(code[:2], ("unknown", "", ""))
    match = re.fullmatch(r"([0-9]{4}|[0-9]{3}[A-Z])(?:\.?T|\s?JP|\s?JT)", code)
    if match:
        return "jp", f"jp{match[1]}", "JPY"
    match = re.fullmatch(r"(\d{6})(?:\.K[QS]|\s?KS|\s?KQ)", code)
    if match:
        return "kr", f"kr{match[1]}", "KRW"
    if re.fullmatch(r"\d{6}", code) and (code in {"005930", "000660", "009150"} or name.startswith(("三星", "SAMSUNG", "SK "))):
        return "kr", f"kr{code}", "KRW"
    if re.fullmatch(r"\d{5}", code):
        return "hk", f"hk{code}", "HKD"
    if re.fullmatch(r"(00|30|60|68)\d{4}", code):
        return "cn", f"{'sz' if code.startswith(('00', '30')) else 'sh'}{code}", "CNY"
    if any(alias in name for alias in JAPAN_ISSUERS.get(code, ())):
        return "jp", f"jp{code}", "JPY"
    if any(alias in name for alias in TAIWAN_ISSUERS.get(code, ())):
        return "tw", "", "TWD"
    # Unknown ISINs and four-digit codes are not evidence of a listing market.
    return "unknown", "", ""
