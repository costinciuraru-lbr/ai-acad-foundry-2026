# NOTES — Assignment 3

Corpus: 18 fabricated documents on Libra Bank term deposits & savings accounts (`data/`,
mapping in `data/README.md`). Ingested via `code/backend/scripts/load_corpus.py`.

## Ingestion improvements (chose two, implemented four)

1. **Stable chunk ids** (`vectorstore.py::stable_id`) — point id is
   `uuid5(namespace, f"{source}:{index}")` instead of a random UUID. Re-ingesting a document
   overwrites its old chunks instead of duplicating them, and if the new chunking produces
   *fewer* chunks than before, `_delete_stale_tail()` removes the orphaned high-index chunks
   from the previous ingest.
2. **Real metadata** (`vectorstore.py`, `IngestRequest.metadata`, `load_corpus.py`) — every
   chunk's payload now carries `title`, `product`, `audience`, `effective`, `version` from the
   document's frontmatter, not just `source`/`strategy`/`index`. Nothing can be filtered by
   what was never stored (Part 5 depends on this).
3. **Heading-aware chunking**, a new `heading` strategy (`chunking.py::chunk_heading`) — splits
   on Markdown `#`/`##` lines first, then packs each section's content up to the size budget.
   Folded into it: **never split a table or a numbered list** — `_atomic_blocks()` detects a
   run of `|...|` table rows or `1. / 2. / -` list items and keeps it as one block even if it
   blows the size budget, on the theory that a mangled table is worse than an oversized chunk.
4. **Chunk context** — every `heading`-strategy chunk is prefixed with
   `"<document title> — <heading>"` (`build_context_prefix`), so a chunk retrieved on its own
   still carries the noun it refers to instead of starting mid-thought.

Chose #1 and #2 as the two required improvements because everything else — filtering, honest
"replace not duplicate" ingestion, citations that make sense — depends on them. #3 and #4 came
from testing #1/#2 against this corpus and finding chunking was still the weak link.

### Before / after, with real numbers

**Re-ingestion duplication (old code: `uuid.uuid4()` per chunk, no delete step).** Running
`load_corpus.py` twice against the fixed collection:

| | points after 1st run | points after 2nd run |
|---|---|---|
| Old (random ids) | 81 | would be 162 (verified by reading the old code path — every ingest call unconditionally created N new points) |
| New (stable ids) | 81 | **81**, confirmed live |

Separately tested the shrink case directly: ingested a synthetic 41-chunk document, then
re-ingested a 1-chunk version of it → response reported `"replaced": 40`, and the collection
count dropped by exactly 40 — the orphaned tail was cleaned up, not left behind.

**Table mangling, `interest-rate-table-2026.md`, chunk_size=220 (`/chunk`, no storage):**

- `dynamic` (old default): 7 chunks. The rate table is split mid-row — chunk #2 ends
  `"...| 12 months | 5.00% | 2.30% |"` and chunk #3 *starts* `"% | 1.90% | ..."`, a
  meaningless fragment, with the 6- and 12-month rows appearing garbled across the boundary.
- `heading` (new): 5 chunks. The entire 8-row table is one 303-character chunk — over budget,
  intact, every row readable.

**Procedure fragmentation, `opening-procedure.md` (8 numbered steps), chunk_size=400:**

- `dynamic`: 7 chunks, and the boundary between chunks #1/#2 falls inside step 3 — step 3's
  content is split from its own step number, sharing a chunk with the *end* of step 3 and the
  *start* of step 4.
- `heading`: 3 chunks — intro, then all 8 steps as one 1,756-character chunk, then the closing
  line. A question about "step 5" always retrieves every other step alongside it.

## Retrieval improvements (chose two, implemented three)

1. **Score threshold** (`SearchRequest.min_score` / `AskRequest.min_score`,
   `vectorstore.search()`) — hits below the threshold are dropped and counted in
   `dropped_below_threshold`, instead of `top_k` always returning *something*.
2. **Metadata filters** (`SearchRequest.filters` / `AskRequest.filters`) — exact-match payload
   filters (e.g. `{"source": "notice-period-policy-v2"}`) so a superseded document stops
   competing with the current one.
3. *(bonus)* **Dedup** (`SearchRequest.dedupe`, default on) — drops a hit whose text is a
   near-duplicate (`SequenceMatcher` ratio ≥ 0.9) of one already kept.

### Before / after, with real numbers

**The contradiction case** — query *"how many days notice do I need to withdraw from a notice
savings account"*, `top_k=4`:

| | rank 1 | rank 2 | rank 3 | rank 4 |
|---|---|---|---|---|
| No filter | **v1 (superseded, 30 days)** score 0.748 | v2 (current, 45 days) 0.706 | v2 0.678 | v1 0.674 |
| `filters={"source": "notice-period-policy-v2"}` | v2 0.706 | v2 0.678 | v2 0.670 | v2 0.651 |

Without a filter, the *wrong* (superseded) document outranks the current one — a naive RAG
answer here would confidently say "30 days," which has been incorrect since 2026-01-15. The
filter fixes it completely.

**The threshold case** — query *"what is the interest rate on your student loans"* (nothing in
the corpus covers this), `top_k=3`:

| | hits returned | top score |
|---|---|---|
| No threshold | 3 (all deposit-rate chunks — plausible-looking but off-topic) | 0.429 |
| `min_score=0.5` | **0** | — (`dropped_below_threshold`: 20 of 20 candidates) |

### A bug the threshold work exposed and fixed

Before this change, `retrieved` being an empty list meant either "RAG is off" or "RAG is on
but nothing scored well enough" — the agent code (`local_agent.py`) couldn't tell them apart,
so an empty result silently fell back to the *ungrounded* prompt and system message. Tested
live: asking the student-loan question with `min_score=0.5` (0 hits) produced a fully
hallucinated, confident-sounding answer about "private vs. bank-branded student loans" with no
acknowledgement that retrieval had even run.

Fixed by threading `chunks: list | None` through instead of `list`: `None` means RAG was never
attempted, `[]` means it was attempted and found nothing — and the prompt now says so
explicitly (`"(no passage met the retrieval criteria for this question)"`). Re-tested: the same
question now gets *"I don't have any of the bank's documents available for this
question—the retrieval returned no passages—so I can't state a student-loan interest rate."*

## 15-question results (`data/questions.md`)

| Group | Correct | Safe-but-incomplete | Wrong/invented |
|---|---|---|---|
| A — simple retrieval | 7 / 7 | 0 | 0 |
| B — multi-step | 2 / 5 | 3 / 5 | 0 |
| C — must refuse | 2 / 3 | 1 / 3 | 0 |

Zero hallucinations across all 15 — every miss was the model saying "not in what I was given"
rather than inventing an answer. All four B/C misses shared one root cause: the right *fact*
existed in a chunk that `top_k=4` didn't surface once other documents' chunks were competing
for the same 4 slots (e.g. `auto-renewal-policy.md`'s "defaults to auto-renew" sentence lost
out to `loyalty-rate-eligibility.md` and `interest-rate-table-2026.md` chunks for question B5).

## What is still wrong, and what's next

- **Retrieval depth on multi-hop questions.** `top_k=4` is tuned for single-fact lookups; three
  of five group-B questions needed a fact from a 5th-or-lower-ranked chunk. Raising `top_k` for
  `use_rag` specifically, or re-ranking a larger candidate set down to the best few (Part 5,
  improvement #6), would likely fix this without touching the corpus.
- **C1 is honest but under-confident.** The assistant correctly refused to invent a student-loan
  rate, but couldn't assert "Libra Bank doesn't cover lending products in what I have access
  to" because no single chunk says that outright. A short "what this assistant does and doesn't
  cover" document, always included regardless of retrieval score, would close this gap cheaply.
- **This is exactly Session 6's territory.** Every group-B miss is a case where one retrieval
  pass wasn't enough — an agent that noticed a low top score or an incomplete answer and could
  decide to search again (with a narrower query, or a `filters` value pulled from the first
  result) would resolve all three without any corpus or chunking change. The question set was
  designed with that comparison in mind.
- **`min_score` and `filters` are not auto-tuned.** Right now a caller has to know to pass them.
  A sensible next step is picking a default threshold from a calibration run (e.g. the 10th
  percentile of on-topic scores) instead of leaving it opt-in.
