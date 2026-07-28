"""Chunking strategies — the first decision of every RAG pipeline, made visible.

Five strategies, deliberately spanning the sophistication spectrum:

  static    fixed character windows; cheap, ignores meaning (splits mid-sentence)
  sentence  groups of N sentences; trivially readable boundaries
  dynamic   structure-aware packing: paragraphs -> sentences packed to a size
            budget with overlap; never cuts inside a sentence unless forced
  semantic  sentence embeddings; a new chunk starts where adjacent cosine
            similarity drops below a threshold — meaning-aware, costs embeddings
  heading   Markdown-structure aware: splits on '#' headings first, then packs
            paragraphs/tables/lists inside each section — a table row or a
            numbered-list item is never split across two chunks — and prefixes
            every chunk with "<document title> — <heading>" so a chunk retrieved
            on its own still carries the noun it refers to (see build_context_prefix)
"""
from __future__ import annotations

import math
import re
from typing import Callable

SENTENCE_END = re.compile(r"(?<=[.!?…])\s+")
PARAGRAPH_SPLIT = re.compile(r"\n\s*\n")
HEADING_LINE = re.compile(r"^(#{1,6})\s+(.*)$")
TABLE_ROW = re.compile(r"^\s*\|.*\|\s*$")
LIST_ITEM = re.compile(r"^\s*(?:\d+[.)]|[-*])\s+")

EmbedFn = Callable[[list[str]], list[list[float]]]


def split_sentences(text: str) -> list[str]:
    parts = [s.strip() for s in SENTENCE_END.split(text)]
    return [s for s in parts if s]


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


# --- strategies ---------------------------------------------------------------

def chunk_static(text: str, size: int, overlap: int) -> list[str]:
    """Fixed windows over raw characters. The baseline that cuts words in half."""
    step = max(1, size - overlap)
    return [text[i : i + size].strip() for i in range(0, len(text), step) if text[i : i + size].strip()]


def chunk_sentence(text: str, per_chunk: int) -> list[str]:
    """Every N sentences become a chunk."""
    sentences = split_sentences(text)
    n = max(1, per_chunk)
    return [" ".join(sentences[i : i + n]) for i in range(0, len(sentences), n)]


def chunk_dynamic(text: str, size: int, overlap: int) -> list[str]:
    """Structure-aware packing: respect paragraphs, pack whole sentences up to
    `size` characters, carry a sentence-tail of ~`overlap` characters forward."""
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0

    def flush() -> None:
        nonlocal current, current_len
        if current:
            chunks.append(" ".join(current))
            # overlap: keep trailing sentences up to `overlap` chars for continuity
            tail: list[str] = []
            tail_len = 0
            for s in reversed(current):
                if tail_len + len(s) > overlap:
                    break
                tail.insert(0, s)
                tail_len += len(s) + 1
            current = tail
            current_len = tail_len

    for paragraph in PARAGRAPH_SPLIT.split(text):
        paragraph = paragraph.strip()
        if not paragraph:
            continue
        for sentence in split_sentences(paragraph):
            # a single sentence larger than the budget: hard-split as last resort
            if len(sentence) > size:
                flush()
                chunks.extend(chunk_static(sentence, size, overlap))
                current, current_len = [], 0
                continue
            if current_len + len(sentence) + 1 > size:
                flush()
            current.append(sentence)
            current_len += len(sentence) + 1
        # paragraph boundary is a natural flush point when near budget
        if current_len > size * 0.7:
            flush()
    if current:
        chunks.append(" ".join(current))
    # drop overlap-only remnants duplicating the previous chunk's tail
    return [c for i, c in enumerate(chunks) if not (i > 0 and c and c in chunks[i - 1])]


def chunk_semantic(text: str, threshold: float, embed_fn: EmbedFn) -> list[str]:
    """Embed every sentence; start a new chunk where the cosine similarity
    between neighbouring sentences falls below `threshold`."""
    sentences = split_sentences(text)
    if len(sentences) <= 1:
        return sentences
    vectors = embed_fn(sentences)
    chunks: list[list[str]] = [[sentences[0]]]
    for i in range(1, len(sentences)):
        if cosine(vectors[i - 1], vectors[i]) < threshold:
            chunks.append([sentences[i]])       # topic shift detected -> new chunk
        else:
            chunks[-1].append(sentences[i])
    return [" ".join(c) for c in chunks]


def build_context_prefix(title: str | None, heading: str | None) -> str:
    """'<title> — <heading>' — what makes a chunk self-describing once it is
    retrieved on its own, away from the document it came from."""
    parts = [p for p in (title, heading) if p]
    return " — ".join(parts)


def _sections(text: str) -> list[tuple[str, str]]:
    """(heading, body) pairs, split on Markdown '#' lines. Body before the
    first heading is kept under heading ''."""
    sections: list[tuple[str, list[str]]] = [("", [])]
    for line in text.split("\n"):
        m = HEADING_LINE.match(line)
        if m:
            sections.append((m.group(2).strip(), []))
        else:
            sections[-1][1].append(line)
    return [(h, "\n".join(b).strip()) for h, b in sections if "\n".join(b).strip()]


def _atomic_blocks(body: str) -> list[str]:
    """Split a section body on blank lines, EXCEPT a run of table rows or a
    run of list items is kept as one block even though naive chunking would
    cut straight through it."""
    blocks: list[str] = []
    current: list[str] = []
    kind: str | None = None

    def flush() -> None:
        if current:
            blocks.append("\n".join(current).strip())
        current.clear()

    for line in body.split("\n"):
        if not line.strip():
            flush()
            kind = None
            continue
        if TABLE_ROW.match(line):
            new_kind = "table"
        elif LIST_ITEM.match(line) or kind == "list":
            new_kind = "list"
        else:
            new_kind = "text"
        if new_kind != kind:
            flush()
        kind = new_kind
        current.append(line)
    flush()
    return [b for b in blocks if b]


def chunk_heading(text: str, title: str | None, size: int) -> list[str]:
    """Split on Markdown headings, then pack each section's blocks (paragraphs,
    whole tables, whole lists) up to `size` characters. A block bigger than
    `size` is kept whole rather than cut — losing a table row is worse than a
    chunk running long. Every chunk is prefixed with its document/section
    context so it still makes sense once retrieved on its own."""
    chunks: list[str] = []
    for heading, body in _sections(text):
        prefix = build_context_prefix(title, heading)
        current: list[str] = []
        current_len = 0

        def flush() -> None:
            nonlocal current, current_len
            if current:
                body_text = "\n\n".join(current)
                chunks.append(f"{prefix}\n\n{body_text}" if prefix else body_text)
            current, current_len = [], 0

        for block in _atomic_blocks(body):
            if current and current_len + len(block) + 2 > size:
                flush()
            current.append(block)
            current_len += len(block) + 2
        flush()
    return chunks


# --- dispatcher ---------------------------------------------------------------

STRATEGIES = ("static", "dynamic", "sentence", "semantic", "heading")


def chunk(
    text: str,
    strategy: str,
    *,
    size: int,
    overlap: int,
    per_chunk: int,
    threshold: float,
    embed_fn: EmbedFn | None = None,
    title: str | None = None,
) -> list[str]:
    text = text.strip()
    if not text:
        return []
    if strategy == "static":
        return chunk_static(text, size, overlap)
    if strategy == "sentence":
        return chunk_sentence(text, per_chunk)
    if strategy == "dynamic":
        return chunk_dynamic(text, size, overlap)
    if strategy == "semantic":
        if embed_fn is None:
            raise ValueError("semantic chunking requires an embedding function")
        return chunk_semantic(text, threshold, embed_fn)
    if strategy == "heading":
        return chunk_heading(text, title, size)
    raise ValueError(f"unknown strategy '{strategy}' — expected one of {STRATEGIES}")
