# RAG Teaching API

A backend built to *show* Retrieval-Augmented Generation, endpoint by endpoint:
chunk text with four selectable strategies, embed and store in **Qdrant**, retrieve
with visible **similarity scores**, and answer questions **with or without
augmentation** — every response exposes the pipeline's intermediate artifacts,
including the exact final prompt sent to the model.

```
text ─► POST /chunk ─► POST /ingest ─► Qdrant ─► POST /search ─► POST /ask
        (strategies)   (embeddings)              (scores)        (± augmentation)
```

- **API:** FastAPI + uvicorn (live reload), port **7799**
- **Vector DB:** Qdrant in Docker, ports **7833** (HTTP/dashboard) / **7834** (gRPC)
- **Swagger UI:** http://localhost:7799/docs · ReDoc: `/redoc`
- **Postman:** import `postman/rag-teaching-api.postman_collection.json`
- **Deps:** managed with [uv](https://docs.astral.sh/uv/) (`pyproject.toml` + `uv.lock`)

## Python setup on Windows — uv, or a plain virtual environment

`uv` is a fast replacement for `python -m venv` + `pip`. It is what the project is
locked with, but **it is not required** — a plain virtual environment works too.

### Option 1 — install uv (recommended)

```powershell
# PowerShell, no admin rights needed
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"

# or, if you have either of these
winget install --id=astral-sh.uv -e
pip install uv
```

The installer puts `uv.exe` in `%USERPROFILE%\.local\bin` and adds it to your `PATH`.
**Close the terminal and open a new one** — a terminal reads `PATH` when it starts, so
an already-open one will still say "uv is not recognized". Then:

```powershell
uv --version
cd code\backend
uv sync                                   # creates .venv and installs from uv.lock
uv run uvicorn app.main:app --reload --port 7799
```

`uv run` uses `code/backend/.venv` automatically — you never activate anything.

### Option 2 — plain venv + pip, no uv at all

```powershell
cd code\backend
py -3.12 -m venv .venv                    # `py` is the Windows Python launcher
.\.venv\Scripts\Activate.ps1              # your prompt now shows (.venv)
python -m pip install --upgrade pip
pip install -r requirements.txt
uvicorn app.main:app --reload --port 7799
```

`requirements.txt` is generated from `uv.lock`, so both paths install exactly the same
versions. Regenerate it after changing dependencies:

```powershell
uv export --format requirements-txt --no-hashes --no-dev -o requirements.txt
```

If `Activate.ps1` is blocked by execution policy:

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
# or sidestep activation entirely — call the interpreter directly:
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 7799
```

### When `uv run` misbehaves

| Symptom | Cause | Fix |
|---|---|---|
| `uv : The term 'uv' is not recognized` | Terminal opened before installation | Close every terminal, open a new one |
| `warning: VIRTUAL_ENV=…\venv does not match the project environment path .venv` | **Another virtual environment is active** — often one at the repository root | Harmless: uv ignores it and uses `.venv`. To silence it, run `deactivate`, or add `--active` to use the active one instead |
| `No such file or directory: pyproject.toml` | You are in the wrong folder | `uv run` must be run from `code/backend` |
| `ModuleNotFoundError: fastapi` | Dependencies not installed | `uv sync` (or `pip install -r requirements.txt`) |
| `Address already in use` on 7799 | The Docker API container is still running | `docker compose stop api`, or use `--port 7801` |
| `python` points somewhere unexpected | A stale venv is activated in this shell | `deactivate`, then check with `where.exe python` |

Everything below assumes one of the two setups above is done.

---

## Run it — option A: locally, without Docker (recommended for teaching)

Only the vector database runs in a container; the API runs on your machine, where it can
borrow your `az login`. **This is the mode where hosted Foundry agents and the model
deployments are visible**, because the Agent Service and the control plane both require
Microsoft Entra authentication.

```bash
cd code/backend
cp .env.example .env               # then edit — see Credentials below
docker compose up qdrant -d        # just the vector DB
uv sync                            # create .venv from uv.lock
az login                           # what makes AZURE_AI_AUTH=identity work
uv run uvicorn app.main:app --reload --port 7799

# without uv, the same thing:
#   .\.venv\Scripts\Activate.ps1 && uvicorn app.main:app --reload --port 7799
```

Add the console in a second terminal:

```bash
cd code/frontend
npm install                        # first time only
npm run dev                        # http://localhost:7800, proxies to :7799
```

Skipping Qdrant entirely is fine for a quick look — `/chunk`, `/agents`, `/tools` and
ungrounded `/ask` all work without it; only `/ingest`, `/search` and grounded `/ask` need it.

## Run it — option B: everything in Docker

```bash
cd code/backend
docker compose up --build
#   :7800 console · :7799/docs Swagger · :7833/dashboard Qdrant
```

Self-contained and one command. By default the API container authenticates with a
**key**, because it cannot borrow your `az login` — and keys are enough for chat and
embeddings but *not* for the Agent Service or the control plane, which require
Microsoft Entra. The console reports that honestly rather than showing an empty list.

### Identity inside a container

That default is a convenience, not a limit — a container can absolutely hold an Entra
identity. Give it a **service principal**: an application identity with its own id and
secret, which `DefaultAzureCredential` picks up from the environment *before* it ever
looks for the Azure CLI.

```bash
# create one, scoped to your Foundry resource only
RES=$(az cognitiveservices account show --name <resource> --resource-group <rg> --query id -o tsv)
az ad sp create-for-rbac --name sp-libra-console --role "Azure AI User" --scopes "$RES"
```

Paste the three values it prints into `.env` and flip the compose override:

```ini
DOCKER_AZURE_AI_AUTH=identity
AZURE_CLIENT_ID=<appId>
AZURE_CLIENT_SECRET=<password>
AZURE_TENANT_ID=<tenant>
```

`docker compose up -d` and the container now has a real identity: hosted agents,
deployments and the Agent Service all work inside Docker. Treat the secret like any
other — it lives in the git-ignored `.env`, and it expires, so rotate it.

**In production you would use neither.** A container running in Azure gets a *managed
identity* — same `DefaultAzureCredential`, same code, no secret to store or rotate at
all. The three lanes, in order of preference: managed identity → service principal →
key.

The app container overrides `QDRANT_URL` automatically and bind-mounts `./app`,
so **live reload works inside the container too** — edit a file, watch it restart.
Note for Docker + Azure keyless auth: `az login` doesn't exist inside the container,
so either use `AZURE_AI_AUTH=key` there, or run the API locally (option A) for the
identity lane.

Qdrant has a visual dashboard: http://localhost:7833/dashboard — great on a shared screen.

## Run it — option C: API on the host, everything else in Docker

Option A's identity lane without needing Node installed: the API — the only part that
wants your `az login` — runs on your machine, while Qdrant and the console stay in
containers.

```bash
# terminal 1 — the API, on your machine
az login
uv run uvicorn app.main:app --reload --port 7799

# terminal 2
docker compose -f docker-compose.yml -f docker-compose.host-api.yml up
```

The override file swaps the console's proxy target to `host.docker.internal` and leaves
the `api` service out, so it does not fight your local uvicorn for port 7799.

`host.docker.internal` is how a container names the machine running Docker — its own
`localhost` is just its own loopback. How much that costs you depends on which Docker
you are running:

| | Docker Desktop (Windows, macOS) | Docker Engine on Linux |
|---|---|---|
| The name | built in, no configuration | created by `extra_hosts: ["host.docker.internal:host-gateway"]` — already set on the console service, the compose form of `--add-host` |
| Points at | the host's loopback | the bridge gateway, a real network interface |
| uvicorn bind | the default `127.0.0.1` is reachable | must add `--host 0.0.0.0`, otherwise the connection is refused |

So the commands above are complete on Docker Desktop. On Linux, add
`--host 0.0.0.0` — which also publishes the API to your local network.

When it does fail, split the problem: `curl http://localhost:7799/health` on the host
proves uvicorn is up, and
`docker compose exec console wget -qO- http://host.docker.internal:7799/health` proves
the container can reach it. A hang instead of a refusal is usually Windows Defender
Firewall dropping the inbound connection to `python.exe`.

## The demo, in order

| Step | Call | What to look at |
|---|---|---|
| 1 | `GET /health` | Everything green, which providers are active |
| 2 | `POST /chunk` ×4 strategies | Same text, different boundaries — static cuts mid-sentence, semantic follows meaning |
| 3 | `POST /ingest` | Chunks became vectors: dimension, first 8 numbers of an embedding |
| 4 | `GET /collection` | What Qdrant now holds |
| 5 | `POST /search` | Paraphrased query still finds the right chunk — cosine scores, descending |
| 6 | `POST /ask` `use_rag=false` | The model guesses (or refuses) — inspect `prompt_sent` |
| 7 | `POST /ask` `use_rag=true` | Grounded answer with [1] [2] citations — compare `prompt_sent` now |
| 8 | `GET /agents` | Four personas, loaded from JSON files on disk |
| 9 | `POST /ask` `agent=default` → `agent=lyrical` | Same facts, same citations, completely different voice |
| 10 | Edit `personas/lyrical.json`, save, ask again | Behaviour changes with **no restart** — behaviour is data |
| 11 | `DELETE /collection` | Clean slate for the next group |

## Agents

Every file in `app/agents/personas/*.json` is one agent. The JSON is re-read whenever
it changes on disk, so editing a persona mid-demo changes the next answer.

```bash
GET  /agents              # list personas (name, rules, temperature)
GET  /agents/{name}       # one persona + the EXACT system prompt its JSON produces
POST /ask                 # {"question": "...", "agent": "lyrical", "agent_mode": "local"}
POST /agents/{name}/deploy  # publish it to Azure AI Foundry Agent Service
```

Two execution lanes, switched by `AGENT_MODE` (or per request via `agent_mode`):

| Lane | Where the loop runs | Works with | Needs |
|---|---|---|---|
| `local` | inside this app | any provider (openai, anthropic, lmstudio, azure) | nothing extra |
| `foundry` | Azure AI Foundry Agent Service | Azure only | `AZURE_AI_PROJECT_ENDPOINT`, Entra auth (`az login`), *Azure AI User* role |

```bash
# publish a persona to Foundry and get its agent id
uv run python scripts/deploy_agent.py lyrical

# call the hosted agent directly, without FastAPI in the way
uv run python scripts/invoke_agent.py "What fee applies to early repayment?" --persona lyrical
```

API keys are **not accepted** by the Agent Service — it is Entra-only. Set
`AZURE_AI_AUTH=identity` and `az login` for that lane.

## Tools (specialist services)

```bash
POST /tools/web-fetch    # a deliberately plain scraper — read its `warnings` array
POST /tools/speak        # text → WAV (Azure AI Speech; needs AZURE_SPEECH_KEY/REGION)
POST /tools/transcribe   # upload a WAV → text
```

`/tools/web-fetch` exists to be honest about scraping: it reports what the naive
approach could not do (JavaScript rendering, bot walls, consent banners, non-HTML
formats). That list is the argument for managed grounding.

Chunking strategies (`strategy` in the request body): `static` (fixed windows),
`sentence` (N sentences per chunk), `dynamic` (paragraph/sentence-aware packing with
overlap), `semantic` (sentence embeddings; new chunk where adjacent cosine similarity
drops below `semantic_threshold` — needs the embedding provider configured).

## Choosing providers

Two `.env` lines switch everything; restart (or let reload pick it up):

```
LLM_PROVIDER=lmstudio | openai | anthropic | azure
EMBEDDING_PROVIDER=lmstudio | openai | azure      # Anthropic has no embeddings API
```

Chat and embeddings are independent — Claude can answer while Azure embeds.
**Embedding dimensions are a commitment**: if you switch embedding models after
ingesting, `/ingest` will refuse with a 409 (different models → incomparable
vector spaces). `DELETE /collection` and re-ingest.

## Credentials — step by step

### Azure Foundry (the course lane)

1. You need a Foundry resource with two deployments (`gpt-5.1`,
   `text-embedding-3-small`). Full click-by-click from an empty account:
   `docs/topics/ref-foundry.html` in this repo (or the course session pages).
2. Find the **endpoint**: Foundry portal ([ai.azure.com](https://ai.azure.com)) →
   your project → **Overview** → copy the endpoint that looks like
   `https://<resource>.services.ai.azure.com/models` → put it in `AZURE_AI_ENDPOINT`.
3. **Auth, keyless (recommended, local runs):** keep `AZURE_AI_AUTH=identity`, then
   `az login` once in your terminal ([install the CLI](https://learn.microsoft.com/cli/azure/install-azure-cli)
   if needed). Your identity needs the *Cognitive Services User* (or *Azure AI User*)
   role on the resource.
4. **Auth, key (for Docker):** portal → your Foundry resource → **Keys and
   Endpoint** → copy Key 1 → `AZURE_AI_AUTH=key` and `AZURE_AI_API_KEY=...`.
   Treat the key like a password; it is why `.env` is gitignored.
5. `AZURE_AI_CHAT_DEPLOYMENT` / `AZURE_AI_EMBEDDING_DEPLOYMENT` must equal your
   **deployment names** (not model names) — ours match: `gpt-5.1`,
   `text-embedding-3-small`.

### OpenAI

1. Create an account at [platform.openai.com](https://platform.openai.com).
2. **Settings → Billing** → add a payment method or a small prepaid credit
   ($5 is plenty for a workshop).
3. **API keys** ([platform.openai.com/api-keys](https://platform.openai.com/api-keys)) →
   *Create new secret key* → copy it **now** (it is shown once) → `OPENAI_API_KEY=sk-...`.
4. Models: `OPENAI_MODEL` (chat) and `OPENAI_EMBEDDING_MODEL` — the defaults are
   sensible; any current chat model works.

### Anthropic (Claude — chat only)

1. Create an account at [console.anthropic.com](https://console.anthropic.com).
2. **Billing** → add credit. 3. **API keys** → *Create key* → copy → `ANTHROPIC_API_KEY=sk-ant-...`.
4. `ANTHROPIC_MODEL=claude-sonnet-5` is the current default; remember Anthropic
   provides **no embeddings API** — pair it with `EMBEDDING_PROVIDER=lmstudio|openai|azure`.

### LM Studio (local gemma — free, no account, works offline)

1. Download LM Studio from [lmstudio.ai](https://lmstudio.ai) and install.
2. In-app **Discover** tab → search `gemma` → download a size your machine handles
   (the 4B class runs on most laptops).
3. Also download an **embedding model** — search `nomic-embed-text`.
4. **Developer / Local Server** tab → start the server (default port **1234**).
5. Copy the exact model identifiers shown by LM Studio into `LMSTUDIO_MODEL` and
   `LMSTUDIO_EMBEDDING_MODEL`; set both providers to `lmstudio`.
6. Docker note: from inside the container the host's LM Studio is
   `http://host.docker.internal:1234/v1` (see the commented line in docker-compose.yml).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `503 Qdrant is not reachable` | `docker compose up qdrant -d`; check `QDRANT_URL` (local = `http://localhost:7833`) |
| `409` on `/ingest` (dimension mismatch) | You changed embedding models — `DELETE /collection`, re-ingest |
| `502 Embedding/LLM call failed … 401` | Wrong/expired key, or (azure identity) run `az login`; check the role |
| `502 … Connection refused` on lmstudio | LM Studio server not started, or wrong base URL from Docker |
| Azure works locally, fails in Docker | Identity lane needs `az login` — use `AZURE_AI_AUTH=key` in containers |
| Port already in use | All ports are configurable: `API_PORT`, compose port mappings |
