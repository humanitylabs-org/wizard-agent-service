# Interactive reserve and provider audit follow-up

Wizard admission protects a configurable number of slots from automatic helper/heavy continuations. Service-owned continuation metadata selects that lane; prompt text never does. Manual Continue remains interactive. Interactive queued requests are considered before automatic continuations, preserving order within each class. Existing active turns are never stopped or preempted.

`WIZARD_INTERACTIVE_RESERVED_SLOTS` defaults to two (bounded by capacity minus one for tiny deployments). Set zero for legacy FIFO. The reserve applies to Wizard's durable admission queue, **not** to every provider HTTP request: direct cron, subagents and auxiliary requests can bypass this service. Health exposes `queue.interactive_reserved`. An automatic continuation waits with `interactive_reserve`; provider backoff still takes precedence over execution when its scope is cooling down.

The deployment trial is eight total Wizard active turns with two reserved for interactive input. This aligns below the observed ten-turn runtime limit and reduces background contention. These are conservative trial values, not measured provider concurrency limits. Provider errors, quota exhaustion and host memory pressure require separate interpretation; no provider/account/model is changed by this configuration. The exact audited provider request denominator was unavailable, so an error percentage or proven optimal concurrency is not claimed.

The heavy queue releases conversation occupancy after durable submission. Its remote shared lock remains independent of interactive admission. Background model continuations can fill the remaining share while new interactive questions retain room; no claim of zero latency under exhausted provider quota is made.
