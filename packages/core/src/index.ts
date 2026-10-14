// Qure! triage pipeline - four layers, escalate-only invariant.
// Layer 1: red-flag floor (deterministic, local)  -> packages/core/src/red-flag/
// Layer 2: decision model (pplx primary, jev fallback) -> packages/core/src/decision-model/
// Layer 3: selective routing (low confidence -> LLM turn)
// Layer 4: flow control (intake / follow-up / human queue)
export {};
