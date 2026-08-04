"""Card-type identification from a photo — one vision call, nothing persisted.

The customer's photo and the two reference card photos are read into memory,
sent once to a vision-capable model, and the answer text comes back. Nothing
here writes to disk, logs the image, or stores anything in Qdrant — the raw
bytes go out of scope the moment `identify()` returns. The /tools/identify-card
endpoint in main.py never saves the upload either; the frontend never keeps the
photo in chat state or localStorage — see reference_cards/README.md for what to
drop in that folder, and Chat.jsx for how the upload is handled client-side.
"""
from __future__ import annotations

from pathlib import Path

from ..llm import get_llm

REFERENCE_DIR = Path(__file__).parent / "reference_cards"
REFERENCE_CARDS = {"basic": "Libra Basic", "premium": "Libra Premium"}
_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp")
_CONTENT_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}

SYSTEM_PROMPT = (
    "You are a bank teller's assistant identifying a customer's debit card from a photo. "
    "You are shown reference photos, each preceded by its label ('Libra Basic' or "
    "'Libra Premium' — sometimes more than one photo per label, e.g. different angles or "
    "design variants of the same tier), followed by the customer's photo, labeled "
    "'Customer's card'. Compare the customer's card against the references — color, logo, "
    "trim, any printed text — and state plainly which tier it matches. Then give a short, "
    "friendly summary of that card's cashback rate and its one or two standout benefits, "
    "using only the facts given to you below — never invent a number, exactly as you would "
    "refuse to invent a fee or rate in a text answer. If the photo is unclear, cropped, or "
    "doesn't resemble any reference, say so plainly instead of guessing which one it is."
)


class ReferenceImagesMissing(Exception):
    """Raised with the exact missing filename — see reference_cards/README.md."""


def _find_references(name: str) -> list[Path]:
    """One or more photos for a card type: `<name>.<ext>` for a single reference, or
    `<name>1.<ext>`, `<name>2.<ext>`, ... for several (extra angles, or several design
    variants of the same tier) — any mix of the supported extensions."""
    matches: list[Path] = []
    for ext in _EXTENSIONS:
        exact = REFERENCE_DIR / f"{name}{ext}"
        if exact.exists():
            matches.append(exact)
        matches.extend(sorted(REFERENCE_DIR.glob(f"{name}[0-9]*{ext}")))
    if not matches:
        raise ReferenceImagesMissing(
            f"No reference image for '{name}' — drop a photo named '{name}.jpg' (a single "
            f"reference), or '{name}1.jpg', '{name}2.jpg', ... (several); .jpeg/.png/.webp "
            f"also work; into {REFERENCE_DIR}"
        )
    return matches


def list_reference_photos() -> list[tuple[str, Path]]:
    """(label, path) for every reference photo actually present on disk — for admin/listing
    UIs (see main.py's /tools/reference-cards). Skips a card type with no photo at all
    instead of raising, so the listing still shows whichever ones do exist."""
    result: list[tuple[str, Path]] = []
    for name, label in REFERENCE_CARDS.items():
        try:
            paths = _find_references(name)
        except ReferenceImagesMissing:
            continue
        for i, path in enumerate(paths, start=1):
            tag = f"{label} ({i}/{len(paths)})" if len(paths) > 1 else label
            result.append((tag, path))
    return result


def identify(customer_photo: bytes, customer_content_type: str, card_facts: str) -> str:
    """(customer's photo bytes, its content-type, grounding facts from the knowledge base)
    -> the model's identification + benefits summary."""
    images: list[tuple[str, bytes, str]] = []
    for name, label in REFERENCE_CARDS.items():
        paths = _find_references(name)
        for i, path in enumerate(paths, start=1):
            tag = f"{label} (reference photo {i} of {len(paths)})" if len(paths) > 1 else label
            images.append((tag, path.read_bytes(), _CONTENT_TYPES.get(path.suffix.lower(), "image/jpeg")))
    images.append(("Customer's card", customer_photo, customer_content_type or "image/jpeg"))

    text = f"Reference facts — ground your answer in these only, never invent a number:\n{card_facts}"
    # No reasoning_effort override here, deliberately: tested low vs default on the same
    # photo/references, and low made the model skip a careful visual comparison and default
    # to "Premium" regardless of what was actually in the picture — wrong, not just lazy.
    # Comparing several images is worth the extra reasoning; max_tokens is generous (a
    # reasoning model spends part of the budget on hidden reasoning either way) so a
    # thorough comparison still has room left to write the visible answer.
    result = get_llm().chat_vision(system=SYSTEM_PROMPT, text=text, images=images,
                                    temperature=0.2, max_tokens=1200)
    return result.text
