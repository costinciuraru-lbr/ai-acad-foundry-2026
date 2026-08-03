"""JSON-schema tool definitions — what the model sees when deciding whether
and how to call a tool. See functions.py for what actually runs when it does.

Adding a tool: append its schema here, add the matching function in
functions.py, and it's immediately callable — no other file needs to change.
"""
from __future__ import annotations

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "loan_calculator",
            "description": (
                "Compute the exact monthly payment, total repaid and total interest for a "
                "fixed-rate amortizing loan. Use this whenever the user asks for a concrete "
                "payment or interest figure on a loan or mortgage — never estimate it by hand."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "principal": {"type": "number", "description": "Loan amount, in the account's currency."},
                    "annual_rate_percent": {"type": "number", "description": "Nominal annual interest rate as a percentage, e.g. 6.5 for 6.5%."},
                    "term_months": {"type": "integer", "description": "Loan term in months."},
                },
                "required": ["principal", "annual_rate_percent", "term_months"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "deposit_calculator",
            "description": (
                "Compute the maturity value and interest earned on a fixed-term deposit, using "
                "simple interest — the standard for retail term deposits, paid once at maturity "
                "rather than compounded. Use this whenever the user asks what a deposit will be "
                "worth or how much interest it earns."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "principal": {"type": "number", "description": "Amount deposited."},
                    "annual_rate_percent": {"type": "number", "description": "Nominal annual interest rate as a percentage."},
                    "term_months": {"type": "integer", "description": "Deposit term in months."},
                },
                "required": ["principal", "annual_rate_percent", "term_months"],
            },
        },
    },
]

TOOLS_BY_NAME = {t["function"]["name"]: t for t in TOOLS}
