"""The local agent — the persona runs in *your* process, against any provider.

This is the honest minimum of what an "agent" is when you strip the marketing:
a persona (instructions + rules), optional retrieved context, and a model call.
No platform required — it works with OpenAI, Anthropic, LM Studio or Foundry,
and it is what runs when AGENT_MODE=local.

Compare with foundry_agent.py, where the same persona is hosted by Azure and the
loop runs on Microsoft's side.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from ..config import settings
from ..llm import get_llm
from ..security import sanitize
from ..tools import TOOLS_BY_NAME
from .persona import Persona


@dataclass
class AgentReply:
    text: str
    mode: str                       # "local" | "foundry"
    persona: str
    system_prompt: str              # exactly what was sent as the system message
    prompt_sent: str                # exactly what was sent as the user message
    provider: str
    model: str
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    security_notes: list[str] = field(default_factory=list)   # injection patterns redacted, if any
    tool_calls: list[dict] = field(default_factory=list)       # each tool invocation the model made, with its result


def _resolve_tools(names: list[str]) -> list[dict] | None:
    """Persona.tools names -> OpenAI-style tool definitions from app/tools.py.
    'calculator' is a shorthand for both financial-calculator functions."""
    resolved: list[dict] = []
    for name in names:
        if name == "calculator":
            resolved.extend(TOOLS_BY_NAME[n] for n in ("loan_calculator", "deposit_calculator"))
        elif name in TOOLS_BY_NAME:
            resolved.append(TOOLS_BY_NAME[name])
    return resolved or None


def build_user_prompt(question: str, chunks: list[dict] | None) -> tuple[str, list[str]]:
    """(prompt, security notes). Question alone (RAG off, or RAG on but nothing
    survived retrieval), or question + retrieved passages — each passage
    sanitized against prompt injection first (see security.py).

    `chunks is None` means retrieval was never attempted (use_rag=false). An
    empty list means retrieval WAS attempted but nothing cleared top_k/min_score
    (e.g. the question is unrelated to the ingested documents) — that is treated
    exactly like RAG being off: the model gets a plain question instead of a
    "no passage matched" ritual, so an off-topic question just gets answered
    normally. `retrieved`/`dropped_below_threshold` on the response still tell
    the caller retrieval was attempted and came up empty.
    """
    if not chunks:
        return question, []
    pieces = []
    notes: list[str] = []
    for i, c in enumerate(chunks):
        text, matched = sanitize(c["text"])
        if matched:
            notes.append(f"passage [{i + 1}] ({c.get('source', '?')}): {len(matched)} pattern(s) redacted")
        pieces.append(f"[{i + 1}] (score {c['score']}) {text}")
    context = "\n\n".join(pieces)
    prompt = (
        "CONTEXT — retrieved passages, most similar first:\n"
        f"{context}\n\n"
        "QUESTION:\n"
        f"{question}"
    )
    return prompt, notes


def run(
    persona: Persona,
    question: str,
    chunks: list[dict] | None = None,
    temperature: float | None = None,
) -> AgentReply:
    # Grounded only when retrieval actually surfaced something to ground on —
    # an empty list (nothing survived top_k/min_score) behaves like RAG being
    # off, so an off-topic question gets answered plainly instead of triggering
    # the "cite your sources / say so if unsupported" instructions for no reason.
    system = persona.system_prompt(grounded=bool(chunks))
    user, security_notes = build_user_prompt(question, chunks)

    # precedence: explicit request value > persona file > .env default
    temp = temperature if temperature is not None else (
        persona.temperature if persona.temperature is not None else settings.llm_temperature
    )
    max_tokens = persona.max_tokens or settings.llm_max_tokens

    # Reasoning models (the gpt-5 family) spend part of the completion budget thinking
    # before they write. A persona can cap that so short, stylistic answers are not
    # starved of visible output tokens.
    extras = {"reasoning_effort": persona.reasoning_effort} if persona.reasoning_effort else {}

    llm = get_llm()
    result = llm.chat(system=system, user=user, temperature=temp,
                      max_tokens=max_tokens, extras=extras, tools=_resolve_tools(persona.tools))

    return AgentReply(
        text=result.text,
        mode="local",
        persona=persona.name,
        system_prompt=system,
        prompt_sent=user,
        provider=result.provider,
        model=result.model,
        prompt_tokens=result.prompt_tokens,
        completion_tokens=result.completion_tokens,
        security_notes=security_notes,
        tool_calls=result.tool_calls,
    )
