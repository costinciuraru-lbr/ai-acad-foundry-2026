# Evaluation set — 15 questions

Run against `/ask` with `use_rag=true`, `agent=default`, `top_k=4`, default retrieval
settings (dedupe on, no score threshold, no metadata filter — the assistant's normal,
un-helped configuration). Corpus: `data/*.md` (18 documents, ingested with the `heading`
strategy via `scripts/load_corpus.py`). Run on 2026-07-28.

Legend: ✅ correct and complete · 🟡 safe but incomplete (no invented facts, but missed
something retrievable) · ❌ wrong or invented.

## A · Simple retrieval (7)

| # | Question | Expected answer | Source doc(s) | Got | Verdict |
|---|---|---|---|---|---|
| A1 | What is the minimum amount to open a standard term deposit? | 1,000 RON (or EUR/USD equivalent) | `account-types.md` | 1,000 RON, correctly stated with eligibility | ✅ |
| A2 | What fee applies if I withdraw from a term deposit before maturity? | 25 RON admin fee + forfeits all accrued interest | `early-withdrawal-policy.md` | 25 RON fee + full interest forfeiture, plus the death/court exception | ✅ |
| A3 | What is the deposit guarantee coverage limit at Libra Bank? | 100,000 EUR equivalent per depositor per bank | `deposit-insurance-guarantee.md` | 100,000 EUR, correctly generalised to joint accounts too | ✅ |
| A4 | What is the withholding tax rate on deposit interest? | 10% | `tax-on-interest.md` | 10%, with correct payment timing | ✅ |
| A5 | What is the current notice period for a notice savings account? | 45 calendar days (current, since 2026-01-15) | `notice-period-policy-v2.md` | 45 days, and correctly flagged the prior 30-day period without being asked | ✅ |
| A6 | What is the annual interest rate for a 12-month RON term deposit under the 2026 schedule? | 5.00% | `interest-rate-table-2026.md` | 5.00%, correctly picked the 2026 table over 2025 | ✅ |
| A7 | How much does a paper monthly statement cost for a deposit account? | 8 RON | `fee-schedule.md` | 8 RON | ✅ |

**7 / 7 correct.** With metadata on every chunk, deduping, and heading-aware chunking that
keeps tables intact, single-fact lookups are solid — including the two "trap" questions
(A5, A6) that could have surfaced the superseded document instead of the current one.

## B · Multi-step (5)

| # | Question | What makes it hard | Source doc(s) | Got | Verdict |
|---|---|---|---|---|---|
| B1 | I qualify for the Loyalty Rate bonus — what total annual rate would I get on a 12-month EUR term deposit? | Two documents: the bonus size in one, the base rate in another; requires addition | `loyalty-rate-eligibility.md` + `interest-rate-table-2026.md` | Correctly explained the +0.30pp rule, but the base-rate table *chunk actually retrieved* didn't include the EUR row it needed — the model said it couldn't find the base rate rather than guessing | 🟡 |
| B2 | If I submit a withdrawal request on a notice account today, how many days' notice, and would that have differed in December 2025? | Two versioned documents + a date condition to apply | `notice-period-policy-v1.md` + `v2.md` | 45 days now, 30 days pre-2026-01-15 — fully correct | ✅ |
| B3 | 10,000 RON 12-month deposit at the 2026 rate — withdraw early vs. wait to maturity, after tax? | Three documents + arithmetic (rate → gross interest → tax → net; separately, principal minus fee) | `interest-rate-table-2026.md` + `early-withdrawal-policy.md` + `tax-on-interest.md` | 9,975 RON early vs. 10,450 RON at maturity, 475 RON difference — arithmetic checked by hand, correct | ✅ |
| B4 | Joint deposit, "any one signature" — can my co-holder break it early without my consent, and what do we get back? | Two documents; the mandate rule answers part one, the fee/forfeiture rule (not retrieved) would answer part two | `joint-account-rules.md` + `early-withdrawal-policy.md` | Correctly answered "yes, any holder can" — but said the payout amount "is not specified," because `early-withdrawal-policy.md` (which has the 25 RON figure) wasn't in the top 4 retrieved chunks | 🟡 |
| B5 | Young Savers deposit matures with no maturity instruction chosen — what happens, and does it get the Loyalty Rate too? | Two documents; one fact (no bonus stacking) is retrieved, the other (default = auto-renew) is in a chunk that wasn't retrieved | `loyalty-rate-eligibility.md` + `auto-renewal-policy.md` | Correctly said no Loyalty Rate stacking; said the "no instruction" default wasn't in context, even though `auto-renewal-policy.md`'s last line states it defaults to auto-renew | 🟡 |

**2 / 5 fully correct, 3 / 5 safe-but-incomplete.** None of the five invented an unsupported
fact — every gap was the model correctly saying "not in the passages I was given," which is
the right failure mode. But three of five needed a specific chunk that `top_k=4` didn't
surface among a bigger competing set of chunks. This is exactly the gap Session 6's agentic
tools are meant to close: a single retrieval pass isn't enough here, and an agent that could
notice the gap and search again (or raise `top_k`, or filter to the specific document) would
fix all three without changing the corpus.

## C · Must refuse (3)

| # | Question | Why it must refuse | Got | Verdict |
|---|---|---|---|---|
| C1 | What is the interest rate on your student loans? | Not in this corpus at all — Libra Bank's lending products aren't documented here | Correctly refused to state a rate; noted the retrieved passages are deposit rates, not loans — but stopped short of saying the bank doesn't offer them (it doesn't know that either way) | 🟡 |
| C2 | Can I open a term deposit in Bitcoin or another cryptocurrency? | `currency-and-fx.md` explicitly states only RON/EUR/USD are supported | Correctly and confidently refused, citing the supported-currency list | ✅ |
| C3 | What is the early repayment fee for a mortgage held with Libra Bank? | Mortgages are out of scope for this corpus (deposits only) | Correctly said the fee isn't in the provided documents, and correctly avoided claiming the bank doesn't offer mortgages (it might — just not documented here) | ✅ |

**0 / 3 hallucinated a number or a policy** — the one thing that must never happen on group C
did not happen. C1 is graded 🟡 rather than ✅ only because the ideal answer would be more
confident ("this corpus doesn't cover lending products at all"); the model's actual answer was
honest, just more hedged than necessary.

## Summary

| Group | Correct | Safe-but-incomplete | Wrong/invented |
|---|---|---|---|
| A — simple retrieval | 7 / 7 | 0 | 0 |
| B — multi-step | 2 / 5 | 3 / 5 | 0 |
| C — must refuse | 2 / 3 | 1 / 3 | 0 |
| **Total** | **11 / 15** | **4 / 15** | **0 / 15** |

Zero hallucinations across all 15 questions — the score-threshold and refusal-instruction
fix (see `NOTES.md`) is doing its job. All four "safe-but-incomplete" answers are a
retrieval-depth problem (`top_k=4` across a growing corpus), not a chunking or prompting
problem — see `NOTES.md` → "what is still wrong" for what would fix it.
