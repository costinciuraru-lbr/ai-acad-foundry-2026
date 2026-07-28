# Corpus — Libra Bank savings & term deposits

18 fabricated documents (no real customer data, no real employer documents) describing a
single, narrow product family: **term deposits and notice savings accounts**, in RON/EUR/USD,
for retail customers of the fictional "Libra Bank." Every document has a YAML header
(`title`, `product`, `audience`, `effective`, `version`) that the loader turns into Qdrant
payload metadata — see [`code/backend/scripts/load_corpus.py`](../code/backend/scripts/load_corpus.py).

## Documents

| File | What it covers |
|---|---|
| `00-overview.md` | Entry point: the three product types, and what Libra Bank does *not* offer |
| `account-types.md` | Standard / Young Savers / notice / instant-access accounts, minimums, eligibility |
| `interest-rate-table-2025.md` | Superseded 2025 rate table (RON/EUR/USD × 6 terms) |
| `interest-rate-table-2026.md` | Current 2026 rate table — higher across the board |
| `loyalty-rate-eligibility.md` | Eligibility + size of the Loyalty Rate bonus (0.30pp) |
| `early-withdrawal-policy.md` | Interest forfeiture + 25 RON admin fee for breaking a term deposit |
| `fee-schedule.md` | Full fee table (statements, certificates, wires, duplicates…) |
| `opening-procedure.md` | 8-step procedure to open a term deposit |
| `closing-early-procedure.md` | 6-step procedure to break a term deposit early |
| `auto-renewal-policy.md` | What happens at maturity: auto-renew, payout, third-party IBAN |
| `notice-period-policy-v1.md` | Superseded: 30-day notice period (until 2026-01-14) |
| `notice-period-policy-v2.md` | Current: 45-day notice period (from 2026-01-15) |
| `deposit-insurance-guarantee.md` | 100,000 EUR guarantee ceiling, per depositor per bank |
| `tax-on-interest.md` | 10% withholding tax on interest, with a worked example |
| `joint-account-rules.md` | Joint deposits: mandates, early withdrawal, death of a holder |
| `currency-and-fx.md` | Funding/paying out across RON/EUR/USD, conversion rules |
| `complaints-and-disputes.md` | Complaint channels, acknowledgement and resolution timelines |
| `onboarding-channels.md` | App vs online banking vs branch — who must use which |

## Which document covers which "breaks retrieval" case

| Case | Document(s) |
|---|---|
| **A precise number** | `early-withdrawal-policy.md` (25 RON fee, forfeits all accrued interest); `tax-on-interest.md` (10% withholding, worked example) |
| **Two documents that must be combined** | `loyalty-rate-eligibility.md` (who qualifies, +0.30pp) + `interest-rate-table-2026.md` (the base rate the bonus is added to) — neither document states the combined rate |
| **Near-duplicates that differ** | `interest-rate-table-2025.md` vs `interest-rate-table-2026.md` — same table shape, different numbers, both "about" term deposit rates |
| **A long procedure with steps** | `opening-procedure.md` (8 steps), `closing-early-procedure.md` (6 steps) |
| **A table** | `interest-rate-table-2026.md`, `fee-schedule.md` |
| **Contradiction across versions** | `notice-period-policy-v1.md` (30 days, superseded 2026-01-14) vs `notice-period-policy-v2.md` (45 days, current from 2026-01-15) |
| **Something deliberately absent** | Nothing in this corpus mentions student loans, mortgages, credit cards, or investment funds — `00-overview.md` explicitly states Libra Bank does not offer investment products. `data/questions.md` group C tests that the assistant refuses instead of inventing an answer. |

All seven cases are covered (the assignment asks for at least five).
