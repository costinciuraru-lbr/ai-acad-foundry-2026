"""Pure-Python implementations of each tool — no external API. See definitions.py
for the JSON-schema the model is shown to decide when and how to call these.
"""
from __future__ import annotations


def loan_calculator(principal: float, annual_rate_percent: float, term_months: int) -> dict:
    if principal <= 0 or term_months <= 0:
        raise ValueError("principal and term_months must be positive")
    r = annual_rate_percent / 100 / 12
    n = term_months
    payment = principal / n if r == 0 else principal * r / (1 - (1 + r) ** -n)
    total_paid = payment * n
    return {
        "monthly_payment": round(payment, 2),
        "total_paid": round(total_paid, 2),
        "total_interest": round(total_paid - principal, 2),
    }


def deposit_calculator(principal: float, annual_rate_percent: float, term_months: int) -> dict:
    if principal <= 0 or term_months <= 0:
        raise ValueError("principal and term_months must be positive")
    interest = principal * (annual_rate_percent / 100) * (term_months / 12)
    return {
        "interest_earned": round(interest, 2),
        "maturity_value": round(principal + interest, 2),
    }


FUNCTIONS_BY_NAME = {
    "loan_calculator": loan_calculator,
    "deposit_calculator": deposit_calculator,
}
