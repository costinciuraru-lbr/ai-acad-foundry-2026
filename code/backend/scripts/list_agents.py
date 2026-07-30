#!/usr/bin/env python
"""List every agent — local persona files and whatever's actually deployed in
Azure AI Foundry.

    uv run python scripts/list_agents.py

Same picture GET /agents gives the console, without needing the API running.
Querying Foundry needs Entra auth (`az login`) — a key alone can't ask the
Agent Service, so under key auth this just reports the local personas.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.agents import foundry_agent  # noqa: E402
from app.agents.persona import list_personas  # noqa: E402


def main() -> int:
    personas = list_personas()
    avail = foundry_agent.availability()
    hosted = foundry_agent.list_hosted() if avail["available"] else []
    hosted_names = {h["name"] for h in hosted}
    local_names = {p.name for p in personas}

    print(f"Local personas ({len(personas)}):")
    for p in personas:
        runs_on = "both (local + Foundry)" if p.name in hosted_names else "local only"
        temp = p.temperature if p.temperature is not None else "-"
        print(f"  {p.name:<16} {p.display_name:<22} temp={temp:<5} {runs_on}")

    print()
    if not avail["available"]:
        print(f"Foundry Agent Service: cannot query ({avail['reason']})")
        print("(needs `az login` — a key alone can't ask the Agent Service)")
        return 0

    hosted_only = [h for h in hosted if h["name"] not in local_names]
    print(f"Deployed in Foundry ({len(hosted)} total, {len(hosted_only)} with no local persona file):")
    if not hosted:
        print("  (none deployed yet — see scripts/deploy_agent.py <persona>)")
    for h in hosted:
        flag = "" if h["name"] in local_names else "  <- no local persona file"
        model = h["model"] or "-"
        print(f"  {h['agent_id']:<38} {h['name']:<16} {model:<16}{flag}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
