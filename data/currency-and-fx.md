---
title: Multi-Currency Deposits and FX Conversion
product: deposits
audience: retail
effective: 2026-01-01
version: 1
---

Term deposits and notice savings accounts are available in RON, EUR and USD (see
`account-types.md`). This document covers currency conversion and cross-currency scenarios,
which are a frequent source of confusion.

## Funding in a different currency

If a customer wants to open a EUR deposit but only holds RON, the app will offer to convert
the funding amount at Libra Bank's current EUR/RON exchange rate, shown before confirmation.
This conversion carries no separate fee, but the exchange rate used already includes the
bank's spread — it is not the interbank rate.

## No cross-currency deposits

A deposit is always opened, held and paid out in a single currency. There is no product that
pays interest in a different currency from the principal, and currency cannot be changed after
opening — the deposit must be closed (see `closing-early-procedure.md` if before maturity) and
a new one opened in the desired currency.

## Maturity payout in a different currency

Payout at maturity is always in the deposit's own currency. Customers who want the payout
converted must request a manual conversion after the funds land in their current account; this
is not part of the automatic maturity process described in `auto-renewal-policy.md`.

## Rate table currencies

All three currencies (RON, EUR, USD) share the same term options and the same fee schedule;
only the interest rate differs by currency, as shown in `interest-rate-table-2026.md`.

Libra Bank does not offer deposits in currencies other than RON, EUR and USD.
