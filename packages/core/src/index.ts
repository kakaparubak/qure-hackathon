// Qure! triage pipeline - four layers, escalate-only invariant.
// Layer 1: red-flag floor (deterministic, local)  -> packages/core/src/red-flag/
// Layer 2: decision model (pplx primary, jev fallback) -> packages/core/src/decision-model/
// Layer 3: selective routing (low confidence -> LLM turn)
// Layer 4: flow control (intake / follow-up / human queue)
//
// INVARIANT: every layer can only ESCALATE, never de-escalate. The decision
// model cannot override the red-flag floor, and nothing can override an
// explicit request for a human. Never refactor this property away.
//
// NOTE: ./channel/whatsapp is deliberately NOT re-exported here. It is the
// only module that imports Baileys, and keeping it out of the barrel is what
// allows the API to boot when Baileys is missing or broken. Import it directly
// as "@qure/core/channel/whatsapp", and only when WhatsApp is enabled.

export * from "./contracts";
export * from "./config";
export * from "./channel/fake";
export * from "./channel/rate-limit";
export * from "./decision-model/types";
export * from "./decision-model/client";
export * from "./decision-model/fake";
export * from "./reply/templates";
export * from "./triage/orchestrator";
