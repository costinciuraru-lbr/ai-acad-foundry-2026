"""RAG Teaching API — every response exposes the pipeline's intermediate steps.

Demo order:  /health -> /chunk -> /ingest -> /collection -> /search -> /ask
Swagger UI:  /docs        ReDoc: /redoc
"""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from . import chunking
from .agents import foundry_agent, local_agent
from .agents.persona import PersonaNotFound, available_names, load_persona, list_personas, PERSONA_DIR
from .config import settings
from .embeddings import get_embedder
from .llm import get_llm
from .schemas import (
    AgentInfo, AgentListResponse, AskRequest, AskResponse, AzureDeployment, AzureDeployments,
    AzureStatus, ChunkInfo, ChunkRequest, ChunkResponse, CollectionInfo, DocumentInfo,
    DocumentsResponse, FoundryAvailability, Health, HostedAgent, IngestRequest, IngestResponse,
    PersonaSummary, ScrapeRequest, ScrapeResponse, SearchHit, SearchRequest, SearchResponse,
    SpeakRequest, TranscribeResponse, Usage,
)
from .services import speech, web
from .vectorstore import DimensionMismatch, VectorStore

app = FastAPI(
    title="RAG Teaching API",
    description=(
        "A backend built to *show* Retrieval-Augmented Generation, step by step: "
        "chunk text (four strategies), embed and store in Qdrant, retrieve with "
        "similarity scores, and answer with or without augmentation — the exact "
        "final prompt is always returned. Libra Bank Academy · AI Engineering on Azure."
    ),
    version="0.1.0",
)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

store = VectorStore()

# Same corpus scripts/load_corpus.py ingests — repo_root/data, four levels up from this file.
DATA_DIR = Path(__file__).resolve().parents[3] / "data"
DOC_SKIP_FILES = {"readme.md", "questions.md"}
DOC_FRONTMATTER_KEYS = ("title", "product", "audience", "effective", "version")


def _parse_document(path: Path) -> tuple[str, dict]:
    """(body, metadata) from a '---\\nkey: value\\n...\\n---' header — same hand-rolled
    parser as load_corpus.py, kept in sync since both read the same five flat fields."""
    raw = path.read_text(encoding="utf-8")
    if not raw.startswith("---"):
        return raw.strip(), {}
    end = raw.find("\n---", 3)
    if end == -1:
        return raw.strip(), {}
    header, body = raw[3:end].strip(), raw[end + 4:].strip()
    metadata: dict = {}
    for line in header.splitlines():
        key, sep, value = line.partition(":")
        if sep and key.strip() in DOC_FRONTMATTER_KEYS:
            metadata[key.strip()] = value.strip()
    if isinstance(metadata.get("version"), str) and metadata["version"].isdigit():
        metadata["version"] = int(metadata["version"])
    return body, metadata


# --- helpers ------------------------------------------------------------------
def _chunk_params(req: ChunkRequest) -> dict:
    return {
        "strategy": (req.strategy or settings.chunk_strategy).lower(),
        "size": req.chunk_size or settings.chunk_size,
        "overlap": req.chunk_overlap if req.chunk_overlap is not None else settings.chunk_overlap,
        "per_chunk": req.sentences_per_chunk or settings.sentences_per_chunk,
        "threshold": req.semantic_threshold or settings.semantic_threshold,
    }


def _do_chunk(req: ChunkRequest, title: str | None = None) -> tuple[list[str], dict]:
    p = _chunk_params(req)
    embed_fn = None
    if p["strategy"] == "semantic":
        embed_fn = _embedder().embed
    try:
        pieces = chunking.chunk(
            req.text, p["strategy"], size=p["size"], overlap=p["overlap"],
            per_chunk=p["per_chunk"], threshold=p["threshold"], embed_fn=embed_fn,
            title=title,
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return pieces, p


def _chunk_infos(pieces: list[str]) -> list[ChunkInfo]:
    return [
        ChunkInfo(index=i, text=t, chars=len(t), approx_tokens=max(1, round(len(t) / 4)))
        for i, t in enumerate(pieces)
    ]


def _embedder():
    try:
        return get_embedder()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Embedding provider not usable: {e}")


def _embed(texts: list[str]) -> list[list[float]]:
    try:
        return _embedder().embed(texts)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"Embedding call failed ({settings.embedding_provider}): {e}",
        )


def _require_qdrant() -> None:
    if not store.ping():
        raise HTTPException(
            status_code=503,
            detail=f"Qdrant is not reachable at {settings.qdrant_url} — "
                   f"start it with: docker compose up qdrant -d",
        )


# --- ops ----------------------------------------------------------------------
@app.get("/health", response_model=Health, tags=["ops"])
def health() -> Health:
    return Health(
        status="ok",
        qdrant="ok" if store.ping() else "unreachable",
        qdrant_url=settings.qdrant_url,
        llm={"provider": settings.llm_provider,
             "model": {"lmstudio": settings.lmstudio_model, "openai": settings.openai_model,
                       "anthropic": settings.anthropic_model,
                       "azure": settings.azure_ai_chat_deployment}.get(settings.llm_provider, "?")},
        embeddings={"provider": settings.embedding_provider,
                    "model": {"lmstudio": settings.lmstudio_embedding_model,
                              "openai": settings.openai_embedding_model,
                              "azure": settings.azure_ai_embedding_deployment}.get(
                                  settings.embedding_provider, "?")},
        agents={"mode": settings.agent_mode,
                "default_persona": settings.agent_persona,
                "available": available_names(),
                "foundry_agent_id": settings.foundry_agent_id or None},
        speech={"configured": bool(settings.azure_speech_key and
                                    (settings.azure_speech_region or settings.azure_speech_endpoint)),
                "region": settings.azure_speech_region or None,
                "endpoint": settings.azure_speech_endpoint or None,
                "voice": settings.azure_speech_voice},
    )


@app.get("/config", tags=["ops"])
def config() -> dict:
    def mask(v: str) -> str:
        return (v[:6] + "…" + v[-4:]) if len(v) > 12 else ("set" if v else "not set")

    return {
        "chunking": {"strategy": settings.chunk_strategy, "chunk_size": settings.chunk_size,
                     "chunk_overlap": settings.chunk_overlap,
                     "sentences_per_chunk": settings.sentences_per_chunk,
                     "semantic_threshold": settings.semantic_threshold},
        "retrieval": {"top_k": settings.top_k, "collection": settings.qdrant_collection,
                      "qdrant_url": settings.qdrant_url},
        "generation": {"provider": settings.llm_provider,
                       "temperature": settings.llm_temperature,
                       "max_tokens": settings.llm_max_tokens},
        "providers": {
            "lmstudio": {"base_url": settings.lmstudio_base_url, "model": settings.lmstudio_model,
                         "embedding_model": settings.lmstudio_embedding_model},
            "openai": {"api_key": mask(settings.openai_api_key), "model": settings.openai_model,
                       "embedding_model": settings.openai_embedding_model},
            "anthropic": {"api_key": mask(settings.anthropic_api_key),
                          "model": settings.anthropic_model},
            "azure": {"endpoint": settings.azure_ai_endpoint or "not set",
                      "auth": settings.azure_ai_auth,
                      "api_key": mask(settings.azure_ai_api_key),
                      "chat_deployment": settings.azure_ai_chat_deployment,
                      "embedding_deployment": settings.azure_ai_embedding_deployment},
        },
    }


@app.get("/azure", response_model=AzureStatus, tags=["ops"])
def azure_status() -> AzureStatus:
    """The Azure environment this app is pointed at, plus its live deployments.

    Deployment data comes from the control plane (Azure Resource Manager), which
    needs an Entra token — so under key authentication the list is unavailable and
    says so, rather than appearing empty.
    """
    resource = settings.azure_foundry_resource
    project = settings.azure_foundry_project
    identity = settings.azure_ai_auth.lower() == "identity"

    foundry_url = portal_url = None
    if resource:
        foundry_url = "https://ai.azure.com/"
        if settings.azure_resource_group and project:
            portal_url = (
                "https://portal.azure.com/#@/resource/subscriptions//resourceGroups/"
                f"{settings.azure_resource_group}/providers/Microsoft.CognitiveServices/"
                f"accounts/{resource}/overview"
            )

    deployments = AzureDeployments(
        available=False,
        reason=None if identity else (
            "Listing deployments reads the Azure control plane, which requires Microsoft "
            "Entra authentication. This app is running with AZURE_AI_AUTH=key (the Docker "
            "default). Run it locally after `az login` to see them."
        ),
    )
    subscription_id = None

    if identity and resource and settings.azure_resource_group:
        try:
            import httpx
            from azure.identity import DefaultAzureCredential

            token = DefaultAzureCredential().get_token("https://management.azure.com/.default")
            headers = {"Authorization": f"Bearer {token.token}"}
            subs = httpx.get("https://management.azure.com/subscriptions",
                             params={"api-version": "2022-12-01"},
                             headers=headers, timeout=20).json().get("value", [])
            if subs:
                subscription_id = subs[0]["subscriptionId"]
                url = (f"https://management.azure.com/subscriptions/{subscription_id}"
                       f"/resourceGroups/{settings.azure_resource_group}"
                       f"/providers/Microsoft.CognitiveServices/accounts/{resource}/deployments")
                data = httpx.get(url, params={"api-version": "2023-05-01"},
                                 headers=headers, timeout=20).json()
                items = []
                for d in data.get("value", []):
                    props, sku = d.get("properties", {}), d.get("sku", {})
                    items.append(AzureDeployment(
                        name=d.get("name"), model=(props.get("model") or {}).get("name"),
                        version=(props.get("model") or {}).get("version"),
                        sku=sku.get("name"), capacity=sku.get("capacity"),
                        state=props.get("provisioningState"),
                    ))
                deployments = AzureDeployments(available=True, items=items)
        except Exception as e:                    # noqa: BLE001 - report, never crash the panel
            deployments = AzureDeployments(available=False, reason=f"{type(e).__name__}: {e}")

    return AzureStatus(
        configured=bool(settings.azure_ai_endpoint),
        auth=settings.azure_ai_auth,
        auth_note=None if identity else
        "Key authentication: the Agent Service and the control plane are unavailable. "
        "This is expected inside Docker, where there is no `az login` to borrow.",
        resource=resource or None,
        resource_group=settings.azure_resource_group or None,
        project=project or None,
        location=settings.azure_location or None,
        subscription_id=subscription_id,
        inference_endpoint=settings.azure_ai_endpoint or None,
        project_endpoint=settings.azure_ai_project_endpoint or None,
        openai_endpoint=settings.azure_openai_endpoint or None,
        chat_deployment=settings.azure_ai_chat_deployment,
        embedding_deployment=settings.azure_ai_embedding_deployment,
        foundry_url=foundry_url,
        portal_url=portal_url,
        deployments=deployments,
    )


# --- chunking (no storage) ----------------------------------------------------
@app.post("/chunk", response_model=ChunkResponse, tags=["1 · chunking"])
def chunk_only(req: ChunkRequest) -> ChunkResponse:
    """Split text and LOOK at the result — nothing is stored. Try the same text
    with all four strategies and compare the boundaries."""
    pieces, p = _do_chunk(req)
    return ChunkResponse(strategy=p["strategy"], params_used=p, count=len(pieces),
                         chunks=_chunk_infos(pieces))


# --- ingestion ----------------------------------------------------------------
@app.post("/ingest", response_model=IngestResponse, tags=["2 · ingestion"])
def ingest(req: IngestRequest) -> IngestResponse:
    """Chunk -> embed -> store in Qdrant. The response shows the chunks, the
    vector dimension, and a peek at the first embedding."""
    _require_qdrant()
    title = (req.metadata or {}).get("title") or req.source
    pieces, p = _do_chunk(req, title=title)
    if not pieces:
        raise HTTPException(status_code=422, detail="No chunks produced — is the text empty?")
    vectors = _embed(pieces)
    dim = len(vectors[0])
    try:
        store.ensure_collection(dim)
    except DimensionMismatch as e:
        raise HTTPException(status_code=409, detail=str(e))
    ids, replaced = store.upsert(pieces, vectors, p["strategy"], req.source, metadata=req.metadata)
    return IngestResponse(
        strategy=p["strategy"], count=len(pieces), vector_dimension=dim,
        embedding_preview=[round(x, 5) for x in vectors[0][:8]],
        embedding_model=_embedder().describe(), point_ids=ids, chunks=_chunk_infos(pieces),
        replaced=replaced,
    )


@app.get("/documents", response_model=DocumentsResponse, tags=["2 · ingestion"])
def list_documents() -> DocumentsResponse:
    """The corpus on disk — same files `scripts/load_corpus.py` ingests. This reads the
    source .md files directly, not Qdrant, so it reflects what's *available* to ingest,
    not necessarily what's currently in the collection (see /collection for that)."""
    if not DATA_DIR.exists():
        return DocumentsResponse(count=0, documents=[])
    docs = []
    for path in sorted(DATA_DIR.glob("*.md")):
        if path.name.lower() in DOC_SKIP_FILES:
            continue
        body, metadata = _parse_document(path)
        docs.append(DocumentInfo(
            source=path.stem, filename=path.name,
            title=metadata.get("title", path.stem), metadata=metadata,
            text=body, chars=len(body),
        ))
    return DocumentsResponse(count=len(docs), documents=docs)


@app.get("/collection", response_model=CollectionInfo, tags=["2 · ingestion"])
def collection_info() -> CollectionInfo:
    _require_qdrant()
    return CollectionInfo(**store.info())


@app.delete("/collection", tags=["2 · ingestion"])
def collection_reset() -> dict:
    """Wipe everything — the clean slate between demos."""
    _require_qdrant()
    return {"deleted": store.reset(), "collection": settings.qdrant_collection}


# --- retrieval ----------------------------------------------------------------
@app.post("/search", response_model=SearchResponse, tags=["3 · retrieval"])
def search(req: SearchRequest) -> SearchResponse:
    """Embed the query, return the nearest chunks with their cosine similarity
    scores — retrieval with the curtain open."""
    _require_qdrant()
    if not store.info()["exists"]:
        raise HTTPException(status_code=404, detail="Collection is empty — POST /ingest first.")
    top_k = req.top_k or settings.top_k
    qvec = _embed([req.query])[0]
    hits, dropped = store.search(qvec, top_k, min_score=req.min_score, filters=req.filters, dedupe=req.dedupe)
    return SearchResponse(
        query=req.query, top_k=top_k, embedding_model=_embedder().describe(),
        query_embedding_preview=[round(x, 5) for x in qvec[:8]],
        hits=[SearchHit(**h) for h in hits], dropped_below_threshold=dropped,
    )


def _content_filtered_reply(question: str, chunks, persona, hosted_only, mode: str, error: Exception):
    """Azure's own Responsible AI content filter (hate/violence/self-harm/jailbreak)
    blocked the request before the model produced anything — a guardrail outside this
    app's code entirely. Surface it as an in-character refusal instead of the raw
    provider exception, so the chat shows the assistant declining, not the app crashing.
    """
    system_prompt = (
        persona.system_prompt(grounded=bool(chunks)) if persona is not None
        else "(hosted agent — instructions live in Foundry, not available locally)"
    )
    prompt_sent, injection_notes = local_agent.build_user_prompt(question, chunks)
    return local_agent.AgentReply(
        text="I can't help with that request — it was flagged by the platform's content "
             "safety system before it reached me. Feel free to rephrase, or ask something else.",
        mode=mode,
        persona=persona.name if persona is not None else hosted_only["name"],
        system_prompt=system_prompt,
        prompt_sent=prompt_sent,
        provider=settings.llm_provider,
        model="(blocked before generation)",
        security_notes=injection_notes + [f"blocked by provider content filter: {error}"],
    )


# --- generation ---------------------------------------------------------------
@app.post("/ask", response_model=AskResponse, tags=["4 · generation"])
def ask(req: AskRequest) -> AskResponse:
    """The finale: an **agent** answers, with or without retrieval.

    Three dials to demonstrate, one at a time:
      * `use_rag`      — false = the model alone; true = retrieve, then augment.
      * `agent`        — which persona shapes the answer (edit its JSON and re-ask!).
      * `agent_mode`   — `local` runs the loop here; `foundry` calls the hosted agent.

    `system_prompt` and `prompt_sent` always show exactly what went to the model.
    """
    retrieved: list[SearchHit] = []
    dropped_below_threshold = 0

    # ---- which persona, and does it need to be local? ------------------------
    persona_name = req.agent or settings.agent_persona
    mode_requested = (req.agent_mode or settings.agent_mode).lower()
    persona = None
    hosted_only = None
    try:
        persona = load_persona(persona_name)
    except PersonaNotFound as e:
        # In foundry mode the instructions may live in Azure rather than on disk —
        # an agent created in the portal has no local file, and should still work.
        if mode_requested != "foundry":
            raise HTTPException(status_code=404, detail=str(e))
        try:
            hosted_only = foundry_agent.find_hosted(persona_name)
        except foundry_agent.FoundryUnavailable as fe:
            raise HTTPException(status_code=503, detail=str(fe))
        if not hosted_only:
            raise HTTPException(status_code=404, detail=str(e))

    # ---- retrieval (unchanged behaviour, now feeding the agent) -------------
    if req.use_rag:
        _require_qdrant()
        if not store.info()["exists"]:
            raise HTTPException(status_code=404,
                                detail="use_rag=true but the collection is empty — POST /ingest first, "
                                       "or set use_rag=false for a plain LLM answer.")
        top_k = req.top_k or settings.top_k
        # Retrieval embeds the raw new question when the caller sends one separately —
        # `question` itself may have chat history folded in, which blurs the search vector.
        qvec = _embed([req.retrieval_query or req.question])[0]
        hits, dropped_below_threshold = store.search(
            qvec, top_k, min_score=req.min_score, filters=req.filters,
        )
        retrieved = [SearchHit(**h) for h in hits]

    # None = RAG off entirely; [] = RAG on, nothing survived retrieval — the
    # agent must tell those apart (see local_agent.build_user_prompt).
    chunks = [h.model_dump() for h in retrieved] if req.use_rag else None
    mode = mode_requested

    # ---- run the agent ------------------------------------------------------
    try:
        if hosted_only is not None:
            reply = foundry_agent.run_hosted(hosted_only, req.question, chunks)
        elif mode == "foundry":
            reply = foundry_agent.run(persona, req.question, chunks)
        else:
            reply = local_agent.run(persona, req.question, chunks, temperature=req.temperature)
    except foundry_agent.FoundryUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        if "content_filter" in str(e).lower():
            reply = _content_filtered_reply(req.question, chunks, persona, hosted_only, mode, e)
        else:
            raise HTTPException(status_code=502,
                                detail=f"Agent run failed (mode={mode}, provider={settings.llm_provider}): {e}")

    info = AgentInfo(
        name=persona.name, display_name=persona.display_name,
        description=persona.description, mode=reply.mode,
        temperature=persona.temperature, style_rules=persona.style_rules,
    ) if persona is not None else AgentInfo(
        name=hosted_only["name"], display_name=hosted_only["name"],
        description=hosted_only.get("description") or "Hosted in Foundry — no local persona file.",
        mode=reply.mode,
    )

    return AskResponse(
        answer=reply.text,
        augmented=req.use_rag,
        provider=reply.provider,
        model=reply.model,
        agent=info,
        system_prompt=reply.system_prompt,
        prompt_sent=reply.prompt_sent,
        retrieved=retrieved,
        dropped_below_threshold=dropped_below_threshold,
        usage=Usage(prompt_tokens=reply.prompt_tokens, completion_tokens=reply.completion_tokens),
        security_notes=reply.security_notes,
        tool_calls=reply.tool_calls,
    )


# --- agents -------------------------------------------------------------------
@app.get("/agents", response_model=AgentListResponse, tags=["5 · agents"])
def agents_list() -> AgentListResponse:
    """Every agent, and **where each one can run**.

    * `local`   — a JSON file exists here; runs in this process with any provider
    * `both`    — the file exists *and* a hosted agent of the same name is in Foundry
    * `foundry` — hosted only: it exists in Foundry with no local file (made in the portal)
    * `unknown` — we could not ask Foundry (key auth cannot query the Agent Service)

    The last state is deliberate: under `AZURE_AI_AUTH=key` the answer is genuinely
    unknown, and reporting "not deployed" would be a guess.
    """
    personas = list_personas()
    availability = foundry_agent.availability()

    hosted_by_name: dict[str, dict] = {}
    if availability["available"]:
        try:
            hosted_by_name = {a["name"]: a for a in foundry_agent.list_hosted()}
        except Exception as e:                    # noqa: BLE001 - degrade, never guess
            availability = {"available": False, "reason": f"{type(e).__name__}: {e}"}

    summaries: list[PersonaSummary] = []
    for p in personas:
        hosted = hosted_by_name.get(p.name)
        runs_on = "unknown" if not availability["available"] else ("both" if hosted else "local")
        summaries.append(PersonaSummary(**p.summary(), runs_on=runs_on,
                                        hosted=HostedAgent(**hosted) if hosted else None))

    local_names = {p.name for p in personas}
    hosted_only = [
        PersonaSummary(
            name=a["name"], display_name=a["name"],
            description=a.get("description") or "Created in Foundry — no local persona file.",
            runs_on="foundry", hosted=HostedAgent(**a),
        )
        for name, a in hosted_by_name.items() if name not in local_names
    ]

    return AgentListResponse(
        active_mode=settings.agent_mode,
        default_persona=settings.agent_persona,
        personas_dir=str(PERSONA_DIR),
        count=len(summaries),
        personas=summaries,
        foundry=FoundryAvailability(**availability),
        hosted_only=hosted_only,
    )


@app.get("/agents/hosted", tags=["5 · agents"])
def agents_hosted() -> dict:
    """What actually exists in the Foundry Agent Service right now — whatever
    created it: our scripts, the SDK, or somebody clicking in the portal."""
    availability = foundry_agent.availability()
    if not availability["available"]:
        raise HTTPException(status_code=503, detail=availability["reason"])
    try:
        return {"count": len(items := foundry_agent.list_hosted()), "agents": items}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Could not list hosted agents: {e}")


@app.delete("/agents/hosted/{agent_id}", tags=["5 · agents"])
def agent_hosted_delete(agent_id: str) -> dict:
    """Remove an agent from Foundry. The local JSON file is untouched — the
    persona keeps working in local mode."""
    try:
        foundry_agent.delete_hosted(agent_id)
    except foundry_agent.FoundryUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Could not delete agent: {e}")
    return {"deleted": True, "agent_id": agent_id}


@app.get("/agents/{name}", tags=["5 · agents"])
def agent_detail(name: str) -> dict:
    """One persona, including **the exact system prompt** its JSON produces —
    grounded and ungrounded. The clearest way to see JSON become behaviour."""
    try:
        persona = load_persona(name)
    except PersonaNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {
        **persona.summary(),
        "system_prompt_plain": persona.system_prompt(grounded=False),
        "system_prompt_grounded": persona.system_prompt(grounded=True),
        "file": str(PERSONA_DIR / f"{name}.json"),
    }


@app.post("/agents/{name}/deploy", tags=["5 · agents"])
def agent_deploy(name: str) -> dict:
    """Publish this persona to the Azure AI Foundry **Agent Service**.

    The same thing `python scripts/deploy_agent.py <name>` does — exposed here so
    it can be demonstrated from Swagger. Requires AZURE_AI_PROJECT_ENDPOINT and
    an Entra identity with the Azure AI User role on the project.
    """
    try:
        persona = load_persona(name)
    except PersonaNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    try:
        result = foundry_agent.deploy(persona)
    except foundry_agent.FoundryUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Deployment to Foundry failed: {e}")
    result["next_step"] = (
        f"Put FOUNDRY_AGENT_ID={result['agent_id']} in .env, then call /ask with "
        f'"agent_mode": "foundry".'
    )
    return result


# --- tools / specialist services ----------------------------------------------
@app.post("/tools/web-fetch", response_model=ScrapeResponse, tags=["6 · tools"])
def web_fetch(req: ScrapeRequest) -> ScrapeResponse:
    """Fetch a page and strip it to text — **the do-it-yourself lane**.

    Read the `warnings` array: it lists everything this naive approach could not
    handle (JavaScript rendering, bot walls, consent banners, non-HTML formats).
    That list is the argument for a managed grounding tool.
    """
    try:
        result = web.scrape(req.url, max_chars=req.max_chars or 20000)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Fetch failed: {e}")
    return ScrapeResponse(**result.__dict__)


@app.post("/tools/speak", tags=["6 · tools"],
          responses={200: {"content": {"audio/wav": {}}, "description": "WAV audio"}})
def speak(req: SpeakRequest):
    """Text → speech (Azure AI Speech). Returns a WAV file you can play or download."""
    try:
        audio = speech.synthesize(req.text, req.voice)
    except speech.SpeechUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Speech synthesis failed: {e}")
    return Response(content=audio, media_type="audio/wav",
                    headers={"Content-Disposition": 'inline; filename="libra-assist.wav"'})


@app.post("/tools/transcribe", response_model=TranscribeResponse, tags=["6 · tools"])
async def transcribe(file: UploadFile = File(..., description="WAV, 16 kHz mono, under ~60 s")):
    """Speech → text (Azure AI Speech). Upload the WAV you just generated and
    watch it come back as text — the round trip in two calls."""
    audio = await file.read()
    if not audio:
        raise HTTPException(status_code=422, detail="The uploaded file is empty.")
    try:
        result = speech.transcribe(audio, content_type=file.content_type or "audio/wav")
    except speech.SpeechUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Transcription failed: {e}")
    return TranscribeResponse(**result)
