# Libra Assist console

A small React console over the backend API. Swagger (`/docs`) stays the right tool for
debugging; this is the right tool for *showing* — one purpose-built screen per part of
the pipeline, each able to reveal its own raw JSON.

| Screen | Shows | Endpoints |
|---|---|---|
| **Chat** | The assistant: persona switch, RAG toggle, local/Foundry lane, retrieved passages with scores, and the exact prompt sent | `/ask` |
| **Knowledge** | Paste a document, compare the four chunking strategies, then embed and store | `/chunk`, `/ingest`, `/collection` |
| **Retrieval** | A query, its embedding, and the ranked hits with cosine scores | `/search` |
| **Agents** | Every agent and **where it can run**, the system prompt its JSON produces, deploy/remove in Foundry | `/agents`, `/agents/{name}/deploy`, `/agents/hosted` |
| **Tools** | The plain web scraper with its warnings; text-to-speech; speech-to-text | `/tools/*` |
| **Status** | Health, the Azure environment, live model deployments, configuration with secrets masked | `/health`, `/azure`, `/config` |

## Where an agent can run

The Agents screen answers this with a badge on every row:

| Badge | Meaning |
|---|---|
| **local only** | A JSON file in `app/agents/personas/`. Runs in the backend process, with any provider. |
| **local + Foundry** | The file exists here *and* a hosted agent of the same name exists in Azure. Either lane works. |
| **Foundry only** | Hosted in Azure with no local file — created in the portal, or its file was removed. Runs through the Foundry lane. |
| **Foundry: unknown** | The Agent Service could not be queried, so hosted state is genuinely unknown. Hover for the reason. |

That last state is not a bug. The Agent Service accepts **only** Microsoft Entra
authentication, and the Docker stack runs with an API key *by default* — so there the
answer is unknowable, and the console says so instead of guessing. Give the container a
service principal (see the [backend README](../backend/README.md#identity-inside-a-container))
and the badges resolve inside Docker too.

## Run it — option A: everything in Docker

```bash
cd code/backend
docker compose up --build
#   http://localhost:7800        the console
#   http://localhost:7799/docs   Swagger
#   http://localhost:7833/dashboard  Qdrant
```

Key authentication: self-contained, but hosted agents and the control plane are not visible.

## Run it — option B: locally, without Docker

This is the mode where **Foundry state is visible**, because your `az login` is available.

```bash
# terminal 1 — the backend
cd code/backend
docker compose up qdrant -d      # only the vector DB
uv sync                          # first time only
az login                         # what makes AZURE_AI_AUTH=identity work
uv run uvicorn app.main:app --reload --port 7799

# terminal 2 — this console
cd code/frontend
npm install                      # first time only
npm run dev                      # http://localhost:7800
```

Vite proxies every API route to `localhost:7799` (see `vite.config.js`), so there is no
CORS to configure. Both halves hot-reload.

Without Qdrant the RAG endpoints (`/ingest`, `/search`, grounded `/ask`) are unavailable;
`/chunk`, `/agents`, `/tools` and ungrounded `/ask` still work.

## Run it — option C: API on the host, Qdrant and console in Docker

The identity lane of option B without keeping a Node toolchain on your machine. Only the
API needs your `az login`; everything else is happier in a container.

```bash
# terminal 1 — the API, on your machine
cd code/backend
az login
uv run uvicorn app.main:app --reload --port 7799

# terminal 2 — Qdrant and the console, in Docker
cd code/backend
docker compose -f docker-compose.yml -f docker-compose.host-api.yml up
```

A container's `localhost` is its own loopback, not yours, so the console proxies to
`host.docker.internal` instead — "the machine running Docker". What that costs depends on
which Docker you have:

| | Docker Desktop (Windows, macOS) | Docker Engine on Linux |
|---|---|---|
| The name | built in | needs `extra_hosts: ["host.docker.internal:host-gateway"]`, already set on the console service |
| Points at | the host's loopback | the bridge gateway — a real interface |
| uvicorn bind | default `127.0.0.1` is fine | must add `--host 0.0.0.0`, or the connection is refused |

So on Docker Desktop the commands above are all of it. On Linux, start uvicorn with
`--host 0.0.0.0 --port 7799` as well — which also publishes the API to your local
network, worth a thought on open Wi-Fi.

The same thing as a bare `docker run`, where `extra_hosts` becomes `--add-host`:

```bash
docker run --rm -p 7800:7800 \
  --add-host=host.docker.internal:host-gateway \
  -e VITE_API_TARGET=http://host.docker.internal:7799 \
  rag-console
```

If the console cannot reach the API, split the problem in two:
`curl http://localhost:7799/health` on the host proves uvicorn is up, and
`docker compose exec console wget -qO- http://host.docker.internal:7799/health` proves
the container can get to it. A hang rather than a refusal usually means Windows Defender
Firewall is dropping the inbound connection to `python.exe`.

## The three lanes, side by side

| | A — all Docker | B — all local | C — API on host |
|---|---|---|---|
| Auth | API key | Microsoft Entra (`az login`) | Microsoft Entra (`az login`) |
| Agent Service | unavailable — key auth is refused | available | available |
| Control plane (deployments) | unavailable | available | available |
| Setup | one command | uv + npm + az login | uv + az login |
| Best for | handing students a working stack | demonstrating the Azure surface | the Azure surface, without Node on your machine |
