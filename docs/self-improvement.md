# Governed self-improvement

Self-improvement is an observable lifecycle, not automatic prompt mutation.

1. **Observe:** durable runs, source outcomes, captures, selection, evidence status, feedback, source/model latency, provider-reported token usage, known cost, unknown-cost counts, and failures.
2. **Diagnose:** `improve diagnose` analyzes a bounded time window and cites metric records. Formal runs invoke the same evaluator at most once every seven days over a 30-day window.
3. **Propose:** findings create non-active source, policy/prompt, provider/model-contract, deduplication, or output/selection proposals with hypothesis, evidence, candidate, and rollback condition.
4. **Evaluate:** a policy experiment freezes at least 50 reviewed items over 14 days and replays baseline and candidate.
5. **Approve and activate:** human-only, digest-bound transitions.
6. **Monitor and rollback:** the active candidate remains linked to its frozen baseline and explicit rollback operation.

The normal approval gate requires a strict improvement in labeled utility while positive retention, negative selection, and confirmed-primary evidence guardrails do not regress. Eligibility is not improvement. A large but harmful, unchanged, or unlabelled experiment cannot be approved.

Source cadence has its own proposals, cold-start windows, human locks, and explicit approve/reject commands. Neither diagnosis nor an AI model can silently activate a policy, source, cadence, output, or knowledge change.

Cadence scoring follows the production weights exactly: update activity 40%, selected-item yield 25%, source authority 15%, domain coverage gap 10%, and fetch reliability 10%. Evaluation starts only after 14 days and five successful observations. Downshifts additionally require 30 days, ten successful observations, zero selected items, and three consecutive weekly recommendations; ordinary upshifts require two cycles, while repeated updates or selections can trigger the first adjacent-level proposal immediately. Approved changes move only one level at a time and human locks always win.

The executable experiment path currently changes selection policy because that can be replayed deterministically over frozen, reviewed items without recontacting sources or spending a user's model budget. Provider, prompt, output, source, and deduplication findings remain non-active proposals until a human supplies a reviewable candidate; they are not mislabeled as evaluated experiments. This is a deliberate safety boundary, not autonomous prompt rewriting.
