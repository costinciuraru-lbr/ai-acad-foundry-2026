"""Local tools the agent can call — no external API, just Python arithmetic.

Split in two so it scales: definitions.py is what the model sees (the JSON-schema
function specs); functions.py is what actually runs when it asks to call one.
Adding a tool touches exactly those two files — this module just wires them
together and dispatches by name.
"""
from __future__ import annotations

from .definitions import TOOLS, TOOLS_BY_NAME
from .functions import FUNCTIONS_BY_NAME


def run_tool(name: str, arguments: dict) -> dict:
    """Execute a tool call by name. Never raises — a bad call becomes a visible
    {"error": ...} result the model can read and recover from, same as a real API."""
    if name not in FUNCTIONS_BY_NAME:
        return {"error": f"unknown tool '{name}'"}
    try:
        return FUNCTIONS_BY_NAME[name](**arguments)
    except (TypeError, ValueError) as e:
        return {"error": str(e)}


__all__ = ["TOOLS", "TOOLS_BY_NAME", "run_tool"]
