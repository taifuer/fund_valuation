import unittest

from backend.holding_identity import classify_holding_symbol, valid_isin


class HoldingIdentityTests(unittest.TestCase):
    def test_market_collisions_require_evidence(self):
        cases = [
            ("4004", "Resonac Holdings Corp", ("jp", "jp4004", "JPY")),
            ("4004", "Unknown issuer", ("unknown", "", "")),
            ("5801", "古河电气工业", ("jp", "jp5801", "JPY")),
            ("3037", "欣兴", ("tw", "", "TWD")),
            ("6981", "村田制作所", ("jp", "jp6981", "JPY")),
            ("6525 JT", "KOKUSAI", ("jp", "jp6525", "JPY")),
            ("6871JP", "MICRONICS", ("jp", "jp6871", "JPY")),
            ("KR7009150004", "三星电机", ("kr", "kr009150", "KRW")),
            ("JP3914400001", "MURATA", ("jp", "jp6981", "JPY")),
            ("AIXAGR", "AIXTRON", ("unknown", "", "")),
        ]
        for code, name, expected in cases:
            with self.subTest(code=code, name=name):
                self.assertEqual(classify_holding_symbol(code, "", name), expected)

    def test_explicit_exchange_wins_and_invalid_isin_not_guessed(self):
        self.assertEqual(classify_holding_symbol("000660", "/unify/r/0.000660", "A"), ("cn", "sz000660", "CNY"))
        self.assertTrue(valid_isin("KR7009150004"))
        self.assertFalse(valid_isin("KR7009150005"))
        self.assertEqual(classify_holding_symbol("KR7009150005", "", "三星"), ("unknown", "", ""))
