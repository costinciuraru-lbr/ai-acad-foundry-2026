# Reference card photos

Drop photos in this folder — no code changes needed. Two naming patterns work, and you
can mix them per card type:

- **One photo**: `basic.jpg`, `premium.jpg`
- **Several photos** (extra angles, or several design variants of the same tier):
  `basic1.jpg`, `basic2.jpg`, ... / `premium1.jpg`, `premium2.jpg`, `premium3.jpg`, ...

`.jpeg`, `.png` and `.webp` all work too, and extensions can be mixed freely (e.g.
`premium1.png` + `premium2.jpg` is fine) — only the `basic`/`premium` prefix matters.
Every matching photo for a given prefix is sent to the model, labeled so it knows they're
all the same tier (e.g. "Libra Premium (reference photo 2 of 3)").

These files are read into memory on every `/tools/identify-card` request and sent straight
to the model alongside the customer's photo — they are never modified, logged, or sent
anywhere else. They **are** committed to the repo (unlike a customer's photo, which this
feature never persists at all — see `app/services/card_vision.py`), so use real photos of
your own cards here, not ones containing anyone's personal data.

If a card type has no matching photo at all, `/tools/identify-card` returns a clear 503
error naming exactly which prefix is missing — nothing silently falls back to a guess.
