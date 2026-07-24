# Reliability backlog — deferred hardening (round-2 audit, 2026-07-20)

Money-loss & correctness findings from the round-2 audit are fixed in
PR #31 (backend) / #19 (app) and a separate C1 branch. The items below are
**deliberately deferred** — each has a real reason, recorded here so they are
not lost.

## Deferred (need a decision or infra, not a straight bugfix)

### Rate-limiting on `redeem` / `cancel` / `reconcile` / `user-sync`
- **Why deferred:** needs shared infra. In-memory counters don't work on
  serverless (each instance is isolated), so this requires a shared store
  (e.g. Upstash Redis via the Vercel integration). That's a new infra
  decision, not a code-only change.
- **Risk if left:** griefing/DoS — a script can spam redeem/cancel/reconcile.
  Not a money-loss (every path is idempotent + chain-verified), but it can
  waste RPC budget and flood the review queue.
- **Next step:** decide on Upstash (free tier) → add a small rate-limit
  middleware keyed by user+route.

### Unpaid PENDING holds a slot for 30 min
- **Why deferred:** this is a **product/design** decision, not a bug. The slot
  is reserved during payment so we can't oversell; shortening the window trades
  griefing-resistance for a higher oversell/contention risk.
- **Risk if left:** a user (or script) starting many redeems they never pay can
  temporarily exhaust a voucher's stock for up to 30 min.
- **Next step:** product decides the hold duration (e.g. 5 min) — then it's a
  one-line constant change (`STALE_PENDING_EXPIRY_MS`) plus a faster sweep.

## Also tracked (pre-existing, separate)

### C1 — `reconcileRedemptionById` confirms without verifying the tx
Being fixed on a **separate branch** (pre-existing in `main`, not introduced by
PR #31). `reconcile` confirms on `receipt.status === "success"` alone — any
successful txHash a user submits gets a voucher for free. Fix mirrors the
webhook: verify the tx is a $WEALTH transfer to the treasury for the right
amount before confirming. Also covers the 30s auto-reconcile on GET.
