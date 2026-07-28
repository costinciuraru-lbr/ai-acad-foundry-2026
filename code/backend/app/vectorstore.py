"""Qdrant wrapper — collection lifecycle, upsert, similarity search.

The collection is created lazily with the dimension of the first embedding that
arrives. If a later embedding model produces a different dimension, we refuse
loudly: vectors from different models live in different spaces and comparing
them is meaningless — reset the collection and re-ingest instead.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from difflib import SequenceMatcher

from qdrant_client import QdrantClient, models

from .config import settings

# Fixed namespace so the same (source, index) always hashes to the same point id —
# re-ingesting a document overwrites its old chunks instead of piling up duplicates.
_ID_NAMESPACE = uuid.UUID("c9b1a1f0-6e29-4b6a-9f0b-9b7a6e2f1a3c")


def stable_id(source: str, index: int) -> str:
    return str(uuid.uuid5(_ID_NAMESPACE, f"{source}:{index}"))


def _near_duplicate(a: str, b: str, threshold: float = 0.9) -> bool:
    """Cheap near-duplicate check for dedupe — two chunks that say almost the
    same thing in almost the same words, not just an exact repeat."""
    na, nb = " ".join(a.split()).lower(), " ".join(b.split()).lower()
    if not na or not nb:
        return na == nb
    return SequenceMatcher(None, na, nb).ratio() >= threshold


class DimensionMismatch(Exception):
    def __init__(self, existing: int, incoming: int) -> None:
        self.existing = existing
        self.incoming = incoming
        super().__init__(
            f"Collection stores {existing}-dimensional vectors but the current embedding "
            f"model produces {incoming} dimensions. Vectors from different embedding models "
            f"are not comparable — DELETE /collection and re-ingest."
        )


class VectorStore:
    def __init__(self) -> None:
        self.client = QdrantClient(url=settings.qdrant_url, timeout=10)
        self.collection = settings.qdrant_collection

    # --- lifecycle -----------------------------------------------------------
    def ensure_collection(self, dim: int) -> None:
        if not self.client.collection_exists(self.collection):
            self.client.create_collection(
                collection_name=self.collection,
                vectors_config=models.VectorParams(size=dim, distance=models.Distance.COSINE),
            )
            return
        existing = self._vector_size()
        if existing != dim:
            raise DimensionMismatch(existing, dim)

    def reset(self) -> bool:
        if self.client.collection_exists(self.collection):
            self.client.delete_collection(self.collection)
            return True
        return False

    # --- data ----------------------------------------------------------------
    def upsert(self, chunks: list[str], vectors: list[list[float]], strategy: str,
               source: str | None, metadata: dict | None = None) -> tuple[list[str], int]:
        """Store the chunks of ONE document. `source` drives two things at once:

        * the point id is derived from (source, index) instead of a random UUID,
          so re-ingesting the same source overwrites its old chunks in place;
        * if this ingest produced fewer chunks than the previous one (a smaller
          re-chunk of the same document), the leftover higher-index chunks from
          last time are deleted — otherwise they would linger as orphans forever.

        Ingests with no `source` (ad-hoc text pasted into the console) keep the
        old random-UUID behaviour: there is nothing to key a replacement on.
        """
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        ids = [stable_id(source, i) for i in range(len(chunks))] if source \
            else [str(uuid.uuid4()) for _ in chunks]
        self.client.upsert(
            collection_name=self.collection,
            points=[
                models.PointStruct(
                    id=pid,
                    vector=vec,
                    payload={
                        "text": text,
                        "index": i,
                        "strategy": strategy,
                        "source": source or "adhoc",
                        "ingested_at": now,
                        "metadata": metadata or {},
                    },
                )
                for i, (pid, text, vec) in enumerate(zip(ids, chunks, vectors))
            ],
        )
        replaced = self._delete_stale_tail(source, len(chunks)) if source else 0
        return ids, replaced

    def _delete_stale_tail(self, source: str, kept_count: int) -> int:
        stale = models.Filter(must=[
            models.FieldCondition(key="source", match=models.MatchValue(value=source)),
            models.FieldCondition(key="index", range=models.Range(gte=kept_count)),
        ])
        count = self.client.count(collection_name=self.collection, count_filter=stale).count
        if count:
            self.client.delete(collection_name=self.collection, points_selector=models.FilterSelector(filter=stale))
        return count

    def search(self, vector: list[float], top_k: int, *, min_score: float | None = None,
               filters: dict[str, str] | None = None, dedupe: bool = True) -> tuple[list[dict], int]:
        """Nearest chunks by cosine similarity, plus two things naive top-k skips:

        * `min_score` drops weak hits instead of always returning `top_k` results —
          `dropped_below_threshold` reports how many were cut so the caller can show it;
        * `dedupe` drops hits whose text nearly repeats one already kept (near-duplicate
          passages that would otherwise waste context budget without adding information).

        `filters` restricts to payload fields with exact matches, e.g. {"source": "..."} —
        the current version of a document no longer has to compete with a superseded one.
        """
        qdrant_filter = models.Filter(must=[
            models.FieldCondition(key=k, match=models.MatchValue(value=v)) for k, v in filters.items()
        ]) if filters else None
        fetch_limit = max(top_k * 4, 20) if (dedupe or min_score is not None) else top_k
        hits = self.client.query_points(
            collection_name=self.collection, query=vector, limit=fetch_limit,
            query_filter=qdrant_filter, with_payload=True,
        ).points

        kept: list[dict] = []
        seen_texts: list[str] = []
        dropped = 0
        for h in hits:
            score = round(float(h.score), 4)
            if min_score is not None and score < min_score:
                dropped += 1
                continue
            payload = h.payload or {}
            text = payload.get("text", "")
            if dedupe and any(_near_duplicate(text, t) for t in seen_texts):
                continue
            seen_texts.append(text)
            kept.append({
                "id": str(h.id),
                "score": score,
                "text": text,
                "index": payload.get("index"),
                "strategy": payload.get("strategy"),
                "source": payload.get("source"),
                "metadata": payload.get("metadata", {}),
            })
            if len(kept) >= top_k:
                break
        return kept, dropped

    # --- introspection --------------------------------------------------------
    def info(self) -> dict:
        if not self.client.collection_exists(self.collection):
            return {"exists": False, "name": self.collection, "points_count": 0,
                    "vector_dimension": None, "distance": None}
        c = self.client.get_collection(self.collection)
        return {
            "exists": True,
            "name": self.collection,
            "points_count": c.points_count or 0,
            "vector_dimension": self._vector_size(),
            "distance": "cosine",
        }

    def ping(self) -> bool:
        try:
            self.client.get_collections()
            return True
        except Exception:
            return False

    def _vector_size(self) -> int:
        cfg = self.client.get_collection(self.collection).config.params.vectors
        return cfg.size if hasattr(cfg, "size") else next(iter(cfg.values())).size
