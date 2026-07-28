#!/usr/bin/env python
"""Walk data/, parse each document's frontmatter, and POST it to /ingest.

    uv run python scripts/load_corpus.py
    uv run python scripts/load_corpus.py --strategy dynamic --chunk-size 400
    uv run python scripts/load_corpus.py --api http://localhost:7799

Replaces the "curl /ingest by hand, twenty times" step from Assignment 3, Part 4.
Re-running it is safe and cheap: stable chunk ids (see vectorstore.py) mean every
document's chunks are replaced in place on re-ingest, never duplicated.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import httpx

DATA_DIR = Path(__file__).resolve().parents[3] / "data"
DEFAULT_API = "http://localhost:7799"
FRONTMATTER_KEYS = ("title", "product", "audience", "effective", "version")
SKIP_FILES = {"readme.md", "questions.md"}


def parse_document(path: Path) -> tuple[str, dict]:
    """(body, metadata) from a '---\\nkey: value\\n...\\n---' header.

    The frontmatter here is five flat scalar fields — a hand-rolled parser is
    enough, and it avoids adding a YAML dependency for that.
    """
    raw = path.read_text(encoding="utf-8")
    if not raw.startswith("---"):
        return raw.strip(), {}
    end = raw.find("\n---", 3)
    if end == -1:
        return raw.strip(), {}
    header, body = raw[3:end].strip(), raw[end + 4:].strip()

    metadata: dict[str, str | int] = {}
    for line in header.splitlines():
        key, sep, value = line.partition(":")
        if sep and key.strip() in FRONTMATTER_KEYS:
            metadata[key.strip()] = value.strip()
    if isinstance(metadata.get("version"), str) and metadata["version"].isdigit():
        metadata["version"] = int(metadata["version"])
    return body, metadata


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--api", default=DEFAULT_API, help="Backend base URL")
    parser.add_argument("--strategy", default="heading",
                         choices=["static", "dynamic", "sentence", "semantic", "heading"])
    parser.add_argument("--chunk-size", type=int, default=450)
    parser.add_argument("--data-dir", default=str(DATA_DIR))
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    files = sorted(p for p in data_dir.glob("*.md") if p.name.lower() not in SKIP_FILES)
    if not files:
        print(f"x no .md files found in {data_dir}")
        return 1

    print(f"-> {len(files)} documents in {data_dir}, strategy={args.strategy}\n")
    ok = failed = 0
    total_chunks = 0
    with httpx.Client(base_url=args.api, timeout=60) as client:
        for path in files:
            source = path.stem
            body, metadata = parse_document(path)
            payload = {
                "text": body,
                "strategy": args.strategy,
                "chunk_size": args.chunk_size,
                "source": source,
                "metadata": metadata,
            }
            try:
                resp = client.post("/ingest", json=payload)
                resp.raise_for_status()
            except httpx.HTTPStatusError as e:
                print(f"x {source}: HTTP {e.response.status_code} - {e.response.text[:200]}")
                failed += 1
                continue
            except httpx.HTTPError as e:
                print(f"x {source}: {e}")
                failed += 1
                continue

            data = resp.json()
            total_chunks += data["count"]
            note = f", replaced {data['replaced']} stale" if data.get("replaced") else ""
            print(f"  {source:<32} {data['count']:>2} chunks{note}  ({metadata.get('title', '(no title)')})")
            ok += 1

    print(f"\n{ok} ingested, {failed} failed, {total_chunks} chunks total.")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
