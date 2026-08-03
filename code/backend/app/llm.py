"""Provider-agnostic chat: lmstudio | openai | anthropic | azure.

One interface, four backends — switching is two lines in .env. The returned
ChatResult always carries the token usage when the provider reports it.

Tool-calling: when `tools` is passed, each provider runs its own request/execute/
respond loop (the wire format for tool calls differs per provider — OpenAI-style
`tool_calls` vs Anthropic's `tool_use` content blocks) but the *tools themselves*
are provider-agnostic Python in app/tools.py. MAX_TOOL_ROUNDS caps the loop so a
model that keeps calling tools without ever answering fails loudly instead of
spinning forever.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from functools import lru_cache

from .config import settings
from .tools import run_tool

MAX_TOOL_ROUNDS = 4


@dataclass
class ChatResult:
    text: str
    provider: str
    model: str
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    tool_calls: list[dict] = field(default_factory=list)


class LLM:
    def __init__(self, provider: str, model: str, client) -> None:
        self.provider = provider
        self.model = model
        self._client = client

    def chat(self, system: str, user: str, temperature: float, max_tokens: int,
             extras: dict | None = None, tools: list[dict] | None = None) -> ChatResult:
        extras = extras or {}
        if self.provider in ("lmstudio", "openai"):
            return self._chat_openai_style(system, user, temperature, max_tokens, extras, tools)
        if self.provider == "anthropic":
            return self._chat_anthropic(system, user, temperature, max_tokens, tools)
        return self._chat_azure(system, user, temperature, max_tokens, extras, tools)

    # -- lmstudio / openai — both speak the OpenAI SDK's tool-call shape --------
    def _chat_openai_style(self, system, user, temperature, max_tokens, extras, tools) -> ChatResult:
        messages: list[dict] = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]
        kwargs: dict = {"model": self.model, "temperature": temperature}
        # OpenAI's gpt-5.x family renamed the cap; LM Studio still speaks the classic name
        if self.provider == "openai":
            kwargs["max_completion_tokens"] = max_tokens
        else:
            kwargs["max_tokens"] = max_tokens
        kwargs.update(extras)
        if tools:
            kwargs["tools"] = tools

        tool_log: list[dict] = []
        for _ in range(MAX_TOOL_ROUNDS):
            r = self._client.chat.completions.create(messages=messages, **kwargs)
            msg = r.choices[0].message
            if not msg.tool_calls:
                u = getattr(r, "usage", None)
                return ChatResult(
                    text=msg.content or "", provider=self.provider, model=self.model,
                    prompt_tokens=getattr(u, "prompt_tokens", None),
                    completion_tokens=getattr(u, "completion_tokens", None),
                    tool_calls=tool_log,
                )
            messages.append({
                "role": "assistant", "content": msg.content,
                "tool_calls": [
                    {"id": tc.id, "type": "function",
                     "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
                    for tc in msg.tool_calls
                ],
            })
            for tc in msg.tool_calls:
                args = json.loads(tc.function.arguments or "{}")
                result = run_tool(tc.function.name, args)
                tool_log.append({"name": tc.function.name, "arguments": args, "result": result})
                messages.append({"role": "tool", "tool_call_id": tc.id, "content": json.dumps(result)})
        raise RuntimeError(f"Tool-calling loop did not converge after {MAX_TOOL_ROUNDS} rounds")

    # -- anthropic — tool_use content blocks, not a separate tool_calls field ---
    def _chat_anthropic(self, system, user, temperature, max_tokens, tools) -> ChatResult:
        messages: list[dict] = [{"role": "user", "content": user}]
        kwargs: dict = {"model": self.model, "system": system, "max_tokens": max_tokens, "temperature": temperature}
        if tools:
            kwargs["tools"] = [
                {"name": t["function"]["name"], "description": t["function"]["description"],
                 "input_schema": t["function"]["parameters"]}
                for t in tools
            ]

        tool_log: list[dict] = []
        for _ in range(MAX_TOOL_ROUNDS):
            r = self._client.messages.create(messages=messages, **kwargs)
            tool_uses = [b for b in r.content if b.type == "tool_use"]
            if not tool_uses:
                text = "".join(b.text for b in r.content if b.type == "text")
                return ChatResult(
                    text=text, provider=self.provider, model=self.model,
                    prompt_tokens=r.usage.input_tokens, completion_tokens=r.usage.output_tokens,
                    tool_calls=tool_log,
                )
            messages.append({"role": "assistant", "content": r.content})
            results = []
            for tu in tool_uses:
                result = run_tool(tu.name, tu.input)
                tool_log.append({"name": tu.name, "arguments": tu.input, "result": result})
                results.append({"type": "tool_result", "tool_use_id": tu.id, "content": json.dumps(result)})
            messages.append({"role": "user", "content": results})
        raise RuntimeError(f"Tool-calling loop did not converge after {MAX_TOOL_ROUNDS} rounds")

    # -- azure — azure-ai-inference ChatCompletionsClient, OpenAI-shaped tool calls
    def _chat_azure(self, system, user, temperature, max_tokens, extras, tools) -> ChatResult:
        messages: list[dict] = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]

        def _complete(msgs: list[dict]):
            kwargs: dict = {"model": self.model, "messages": msgs}
            if tools:
                kwargs["tools"] = tools
            try:
                return self._client.complete(
                    temperature=temperature, max_tokens=max_tokens,
                    **({"model_extras": extras} if extras else {}), **kwargs,
                )
            except Exception as e:
                # The gpt-5 family renamed the output cap. Retry with the new name
                # rather than making every caller know which generation they are on.
                if "max_completion_tokens" not in str(e):
                    raise
                return self._client.complete(
                    model_extras={"max_completion_tokens": max_tokens, **extras}, **kwargs,
                )

        tool_log: list[dict] = []
        for _ in range(MAX_TOOL_ROUNDS):
            r = _complete(messages)
            msg = r.choices[0].message
            if not msg.tool_calls:
                u = getattr(r, "usage", None)
                return ChatResult(
                    text=msg.content or "", provider=self.provider, model=self.model,
                    prompt_tokens=getattr(u, "prompt_tokens", None),
                    completion_tokens=getattr(u, "completion_tokens", None),
                    tool_calls=tool_log,
                )
            messages.append({
                "role": "assistant", "content": msg.content,
                "tool_calls": [
                    {"id": tc.id, "type": "function",
                     "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
                    for tc in msg.tool_calls
                ],
            })
            for tc in msg.tool_calls:
                args = json.loads(tc.function.arguments or "{}")
                result = run_tool(tc.function.name, args)
                tool_log.append({"name": tc.function.name, "arguments": args, "result": result})
                messages.append({"role": "tool", "tool_call_id": tc.id, "content": json.dumps(result)})
        raise RuntimeError(f"Tool-calling loop did not converge after {MAX_TOOL_ROUNDS} rounds")

    def describe(self) -> dict:
        return {"provider": self.provider, "model": self.model}


@lru_cache(maxsize=1)
def get_llm() -> LLM:
    provider = settings.llm_provider.lower()

    if provider == "lmstudio":
        from openai import OpenAI

        return LLM(provider, settings.lmstudio_model,
                   OpenAI(base_url=settings.lmstudio_base_url, api_key="lm-studio"))

    if provider == "openai":
        from openai import OpenAI

        return LLM(provider, settings.openai_model, OpenAI(api_key=settings.openai_api_key))

    if provider == "anthropic":
        from anthropic import Anthropic

        return LLM(provider, settings.anthropic_model,
                   Anthropic(api_key=settings.anthropic_api_key))

    if provider == "azure":
        if not settings.azure_ai_endpoint:
            raise ValueError(
                "AZURE_AI_ENDPOINT is not set — put your Foundry endpoint in .env "
                "(README § Credentials · Azure Foundry)"
            )
        from azure.ai.inference import ChatCompletionsClient

        client = ChatCompletionsClient(
            endpoint=settings.azure_ai_endpoint,
            credential=_azure_credential(),
            credential_scopes=["https://cognitiveservices.azure.com/.default"],
        )
        return LLM(provider, settings.azure_ai_chat_deployment, client)

    raise ValueError(
        f"LLM_PROVIDER='{provider}' is not supported — use lmstudio, openai, anthropic or azure"
    )


def _azure_credential():
    if settings.azure_ai_auth.lower() == "key":
        from azure.core.credentials import AzureKeyCredential

        return AzureKeyCredential(settings.azure_ai_api_key)
    from azure.identity import DefaultAzureCredential

    return DefaultAzureCredential()
