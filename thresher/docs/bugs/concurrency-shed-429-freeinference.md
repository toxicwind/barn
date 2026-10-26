# Concurrency-shed 429 for FreeInference (and unregistered upstreams) — behavior + guidance

> Filing (2026-10-22). Owner: awrawr-pc estate recon. Documents a **behavior of
> Thresher's concurrency shedder** observed against FreeInference, and how
> clients should consume the resulting 429. Keep this as the **diagnostic reference
> for the 429-origin**: the durable _fix_ for client stalls is a direct Tau/Kappa
> patch (client rides the shed through when opted in) — see cross-links.

## Symptom

Agents calling Thresher's REST tool-call surface against FreeInference saw
`HTTP 429` with `Retry-After: 1` and stalled, mistaking it for a FreeInference
"usage limit / maxConcurrency: 2 per key."

## Root cause (proven 2026-10-22)

- **Provider is not the limiter.** A keyed probe hit FreeInference
  (`freeinference.org/v1/models`) with 4 concurrent requests — **all `HTTP 200`**,
  TTFB 0.12–0.16s, no 429, no Retry-After, no x-ratelimit headers.
- **The 429 is emitted here** — `internal/httpapi/concurrency_shed.go`:
  - `defaultRetryAfterSeconds = 1`: used when a shedding scope reports
    `queue_timeout: 0`, i.e. a `queue_size: 0` scope sheds **instantly with no wait
    budget**.
  - `retryAfterSeconds()` rounds sub-second queue budgets **up to 1** so the header
    never says "retry now" (RFC 9110, spec 093 FR-011).
- **maxConcurrency:2 is a client knob** (`~/.config/kappa/kappa.jsonc:9`), not Pinax.

## The 429 the shedder emits is a concurrency-contained signal

A `429/1` from this surface means: "the local shedder is full, try again in ~1s."
It is **not** a provider rejection. Finite client retry ceilings (e.g. `RETRY_MAX_RETRIES`)
must not treat it as terminal.

## Guidance

1. **If an upstream should not be shed aggressively**, register it as a real
   Thresher upstream and give the scope a positive `queue_timeout` / queue size,
   or raise `MCPPROXY_MAX_CONCURRENT_REQUESTS/_QUEUE_SIZE/_QUEUE_TIMEOUT` so the
   limiter queues instead of sheds.
2. **Client consumption**: a concurrency-contained 429 should be retried
   indefinitely when the target provider opts in — a generic per-provider contract,
   e.g. `provider.<id>.options.unlimitedRetryOn429` (default off). Opt in only a
   provider whose 429 is a concurrency shed (short/local Retry-After, no real
   rate-limit headers).

## Where the durable fix lives (clients) — see the living per-product modules

| Client | Mitigation                                                                                                   | Commit(s) → status (in recon KB, authoritative)                   |
| ------ | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Kappa  | `provider.<id>.options.unlimitedRetryOn429` → `SessionRetry.policy` skips ceiling when `isConcurrencyShed()` | Kappa main: `771dda9ecb`, `40aa3c2c5a` → **live**                 |
| Tau    | equivalent config-gated handling                                                                             | Tau main → **see recon KB module, do not trust this table alone** |

> **Status authority:** the client-fix status lives and updates in the recon KB
> (it is versioned and pushable). Treat this doc as the **stable behavior/Messaging
> reference only**; never treat the client-fix column here as current after editing
> it once. Link out, don't duplicate.

## Cross-links (modular — each concern has one home)

- Behavior (this doc): the 429-origin + consumption guidance — stable.
- Client-fix status + live verdict (authoritative, updating):
  `estate-recon/muse-meta-hatch/docs/field-notes/kite-fleet-recon/` →
  [`HEADLINE-BUGS.md`](../index.md#429) and
  [`FIX-usage-limit-as-dev-env.md`](../index.md#429-verdict).
  (Paths are stable KB; resolve exact filenames under
  `kite-fleet-recon/`.)
