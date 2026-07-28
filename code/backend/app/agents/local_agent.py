"""The local agent — the persona runs in *your* process, against any provider.

This is the honest minimum of what an "agent" is when you strip the marketing:
a persona (instructions + rules), optional retrieved context, and a model call.
No platform required — it works with OpenAI, Anthropic, LM Studio or Foundry,
and it is what runs when AGENT_MODE=local.

Compare with foundry_agent.py, where the same persona is hosted by Azure and the
loop runs on Microsoft's side.
"""
from __future__ import annotations

from dataclasses import dataclass

from ..config import settings
from ..llm import get_llm
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


def build_user_prompt(question: str, chunks: list[dict] | None) -> str:
    """Question alone (RAG off), or question + retrieved passages (RAG on).

    `chunks is None` means retrieval was never attempted (use_rag=false). An
    empty list means retrieval WAS attempted and found nothing worth keeping
    (e.g. everything fell below the score threshold) — that must still say so
    explicitly, or the model silently answers from its own knowledge with no
    signal that grounding was expected. See vectorstore.search's min_score.
    """
    if chunks is None:
        return question
    if not chunks:
        context = "(no passage met the retrieval criteria for this question)"
    else:
        context = "\n\n".join(
            f"[{i + 1}] (score {c['score']}) {c['text']}" for i, c in enumerate(chunks)
        )
    return (
        "CONTEXT — retrieved passages, most similar first:\n"
        f"{context}\n\n"
        "QUESTION:\n"
        f"{question}"
    )


def run(
    persona: Persona,
    question: str,
    chunks: list[dict] | None = None,
    temperature: float | None = None,
) -> AgentReply:
    # None = RAG off entirely; [] = RAG on, retrieval just found nothing to keep.
    # Both need to be told apart from "RAG on with hits" — see build_user_prompt.
    system = persona.system_prompt(grounded=chunks is not None)
    user = build_user_prompt(question, chunks)

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
                      max_tokens=max_tokens, extras=extras)

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
    )
