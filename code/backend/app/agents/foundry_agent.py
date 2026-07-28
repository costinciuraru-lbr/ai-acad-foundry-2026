"""The hosted agent — the same persona, living in Azure AI Foundry Agent Service.

Difference from local_agent.py, in one sentence: there, your process owns the
loop; here, Azure owns it. You create an *agent* (a stored definition), open a
*thread* (a conversation), add a message, and start a *run* — the platform
executes it, calls any tools the agent is allowed to use, and writes the answer
back into the thread.

We talk to the Agent Service over **plain REST**, with an Entra token, rather than
through an SDK. Two reasons, both deliberate:

  * it is exactly the protocol the session pages teach and the shell scripts in
    scripts/azure/ use — four HTTP calls, no hidden machinery;
  * the SDK surface for agents is still moving, and pinning our teaching material
    to a preview API shape would age badly.

Requires:  AZURE_AI_PROJECT_ENDPOINT   (Foundry portal → your project → Overview)
           AZURE_AI_AUTH=identity      (the Agent Service refuses API keys)
           an identity with the Azure AI User role on the project
"""
from __future__ import annotations

import time

import httpx

from ..config import settings
from .local_agent import AgentReply, build_user_prompt
from .persona import Persona

API_VERSION = "2025-05-01"
SCOPE = "https://ai.azure.com/.default"
TIMEOUT = 60.0


class FoundryUnavailable(Exception):
    """Raised with an instructive message when the hosted lane cannot be used."""


# --- plumbing -----------------------------------------------------------------

def _require_config() -> None:
    if not settings.azure_ai_project_endpoint:
        raise FoundryUnavailable(
            "AZURE_AI_PROJECT_ENDPOINT is not set. Copy it from the Foundry portal "
            "(your project → Overview → project endpoint) into .env. "
            "See the Session 4 page, 'Deploying the agent to Foundry'."
        )
    if settings.azure_ai_auth.lower() == "key":
        raise FoundryUnavailable(
            "The Agent Service requires Microsoft Entra authentication — API keys are "
            "not accepted. Two ways to provide an identity:\n"
            "  • running on your machine: set AZURE_AI_AUTH=identity and run `az login`;\n"
            "  • running in a container: give it a service principal — set "
            "AZURE_CLIENT_ID, AZURE_CLIENT_SECRET and AZURE_TENANT_ID in .env, plus "
            "DOCKER_AZURE_AI_AUTH=identity. DefaultAzureCredential picks those up first, "
            "so the same code works with no `az login` present.\n"
            "In Azure itself the container would use a managed identity and need no "
            "secret at all. See the backend README, 'Identity inside a container'."
        )


def _token() -> str:
    _require_config()
    try:
        from azure.identity import DefaultAzureCredential
    except ImportError as e:                     # pragma: no cover
        raise FoundryUnavailable("azure-identity is not installed — run: uv sync") from e
    try:
        return DefaultAzureCredential().get_token(SCOPE).token
    except Exception as e:
        raise FoundryUnavailable(
            f"Could not acquire an Entra token for the Agent Service: {e}. "
            f"Run `az login` in the terminal that started this app."
        ) from e


def _call(method: str, path: str, json: dict | None = None) -> dict:
    base = settings.azure_ai_project_endpoint.rstrip("/")
    url = f"{base}/{path.lstrip('/')}"
    headers = {"Authorization": f"Bearer {_token()}", "Content-Type": "application/json"}
    response = httpx.request(method, url, params={"api-version": API_VERSION},
                             headers=headers, json=json, timeout=TIMEOUT)
    if response.status_code >= 400:
        raise FoundryUnavailable(
            f"Agent Service returned HTTP {response.status_code} for {method} {path}: "
            f"{response.text[:300]}"
        )
    return response.json() if response.content else {}


# --- capability probe ----------------------------------------------------------

def availability() -> dict:
    """Can we ask Foundry anything at all? Distinguishes "no agents" from "cannot ask".

    The console needs exactly this: under key authentication the Agent Service
    refuses to answer, so hosted state is genuinely *unknown* — and reporting
    "not deployed" would be a guess.
    """
    try:
        _call("GET", "assistants")
        return {"available": True, "reason": None}
    except FoundryUnavailable as e:
        return {"available": False, "reason": str(e)}
    except Exception as e:                       # noqa: BLE001
        return {"available": False, "reason": f"{type(e).__name__}: {e}"}


# --- agent definitions ---------------------------------------------------------

def list_hosted() -> list[dict]:
    """Every agent in the project — whatever created it: our scripts, an SDK, or
    somebody clicking in the portal."""
    data = _call("GET", "assistants")
    out: list[dict] = []
    for a in data.get("data", []):
        instructions = a.get("instructions") or ""
        out.append({
            "agent_id": a.get("id"),
            "name": a.get("name") or a.get("id"),
            "model": a.get("model"),
            "description": a.get("description"),
            "created_at": a.get("created_at"),
            "instructions_preview": instructions[:300],
        })
    return out


def find_hosted(name: str) -> dict | None:
    for agent in list_hosted():
        if agent["name"] == name:
            return agent
    return None


def delete_hosted(agent_id: str) -> bool:
    _call("DELETE", f"assistants/{agent_id}")
    return True


def deploy(persona: Persona, model: str | None = None) -> dict:
    """Create (or update) the hosted agent from a persona file. Returns its id.

    Run this once per persona — or after editing the JSON — via
    `python scripts/deploy_agent.py <persona>`, POST /agents/{name}/deploy, or
    scripts/azure/03-create-agent.
    """
    model = model or settings.azure_ai_chat_deployment
    instructions = persona.system_prompt(grounded=True)
    body = {
        "model": model,
        "name": persona.name,
        "description": persona.description,
        "instructions": instructions,
    }

    existing = find_hosted(persona.name)
    if existing:
        agent = _call("POST", f"assistants/{existing['agent_id']}", body)
        action = "updated"
    else:
        agent = _call("POST", "assistants", body)
        action = "created"

    return {
        "action": action,
        "agent_id": agent.get("id"),
        "name": persona.name,
        "model": model,
        "instructions_preview": instructions[:280],
    }


# --- running -------------------------------------------------------------------

def run(
    persona: Persona,
    question: str,
    chunks: list[dict] | None = None,
    agent_id: str | None = None,
) -> AgentReply:
    """Invoke the hosted agent for this persona.

    Resolution order for the agent id: an explicit argument, then an agent in the
    project whose name matches the persona, then FOUNDRY_AGENT_ID from .env.
    """
    if not agent_id:
        match = find_hosted(persona.name)
        agent_id = match["agent_id"] if match else settings.foundry_agent_id
    if not agent_id:
        raise FoundryUnavailable(
            f"No hosted agent named '{persona.name}' exists in this project. "
            f"Deploy it first — POST /agents/{persona.name}/deploy, or "
            f"`python scripts/deploy_agent.py {persona.name}`."
        )
    return _run_thread(agent_id, persona.name, question, chunks or [])


def run_hosted(agent: dict, question: str, chunks: list[dict] | None = None) -> AgentReply:
    """Invoke a hosted agent that has no local persona file — its instructions
    live in Foundry, so there is nothing to compose on our side."""
    return _run_thread(agent["agent_id"], agent["name"], question, chunks or [])


def _run_thread(agent_id: str, persona_name: str, question: str, chunks: list[dict]) -> AgentReply:
    """The Agent Service protocol, in four calls."""
    user = build_user_prompt(question, chunks)

    thread = _call("POST", "threads", {})                                    # 1 open
    thread_id = thread["id"]
    _call("POST", f"threads/{thread_id}/messages",
          {"role": "user", "content": user})                                 # 2 ask
    run_obj = _call("POST", f"threads/{thread_id}/runs",
                    {"assistant_id": agent_id})                              # 3 execute

    deadline = time.time() + 180
    while run_obj.get("status") in ("queued", "in_progress", "requires_action"):
        if time.time() > deadline:
            raise FoundryUnavailable(
                f"The run was still '{run_obj.get('status')}' after 180 seconds. "
                f"The first call to a newly created agent is often slow; try again. "
                f"If it persists, check the run in the Foundry portal."
            )
        time.sleep(0.8)
        run_obj = _call("GET", f"threads/{thread_id}/runs/{run_obj['id']}")

    if run_obj.get("status") != "completed":
        raise FoundryUnavailable(
            f"The run ended as '{run_obj.get('status')}': {run_obj.get('last_error') or 'no detail'}"
        )

    messages = _call("GET", f"threads/{thread_id}/messages")                 # 4 read
    answer = ""
    for message in messages.get("data", []):
        if message.get("role") != "assistant":
            continue
        for part in message.get("content", []):
            text = (part.get("text") or {}).get("value")
            if text:
                answer = text
                break
        if answer:
            break

    usage = run_obj.get("usage") or {}
    return AgentReply(
        text=answer or "(the run produced no assistant message)",
        mode="foundry",
        persona=persona_name,
        system_prompt="(stored in Foundry with the agent definition)",
        prompt_sent=user,
        provider="azure-foundry-agent",
        model=run_obj.get("model") or settings.azure_ai_chat_deployment,
        prompt_tokens=usage.get("prompt_tokens"),
        completion_tokens=usage.get("completion_tokens"),
    )
