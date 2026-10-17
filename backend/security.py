"""Fail-closed configuration shared by the API and deployment checks."""
import os

TOKEN_NAMES = ('FUND_VALUATION_DIAGNOSTICS_TOKEN', 'FUND_VALUATION_FUND_MANAGEMENT_TOKEN')
PLACEHOLDERS = {'replace-with-a-random-token', 'replace-with-another-random-token', 'changeme'}


def configured_token(name: str) -> str:
    token = os.environ.get(name, '').strip()
    return '' if token.lower() in PLACEHOLDERS else token


def validate_security_configuration() -> None:
    for name in TOKEN_NAMES:
        if os.environ.get(name, '').strip().lower() in PLACEHOLDERS:
            raise RuntimeError(f'{name} contains a placeholder; generate a token or leave it empty')
