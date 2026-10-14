# WhatsApp ↔ decision-model pipeline — design

Date: 2026-10-14
Status: approved (approach C)

## Goal

A real WhatsApp message sent to the Qure! number reaches the decision model and
gets a Bahasa Indonesia reply sent back to the same phone. One process, one
command.

## Non-goals (tonight)

- Red-flag floor regex (layer 1). Not built. Its safety duty is covered by the
  model-failure rule below.
- Postgres / Drizzle persistence. Sessions live in an in-memory `Map` keyed by
  phone.
- Nurse dashboard, SSE events, queue ordering, FHIR export.
- Conversational LLM (`llm.ts`) prose. Replies are templated.

Every one of these lands later without changing the loop's shape, because each
sits behind an interface the loop already talks to.

## Architecture

One process. The pipeline is reachable two ways: through the Baileys adapter,
and through an HTTP route. Both call the same handler.

```
WhatsApp phone
  │
  ▼
BaileysChannel (packages/core/src/channel/whatsapp.ts)
  │  InboundMessage
  ▼
                  ┌──── same handler ────┐
POST /webhook/inbound (apps/api/src/routes/webhook.ts)   ← curl-testable
  │
  ▼
orchestrator (packages/core/src/triage/orchestrator.ts)
  │  dedup → decision model → Decision → template
  ▼
templates (packages/core/src/reply/templates.ts)
  │  OutboundMessage
  ▼
BaileysChannel.send()
```

The HTTP route exists so the LLM half is provable without a linked phone.
Baileys pairing is the highest-variance step tonight; the route decouples the
critical path from it.

### Components

**`channel/whatsapp.ts`** — Baileys implementation of the existing
`WhatsAppChannel` contract. Responsibilities: link the session, normalize JIDs
to E.164-without-`+`, emit `InboundMessage`, send `OutboundMessage`, ignore
noise, rate-limit outbound. Auth state written to `.baileys/`.

Linking uses Baileys' 8-digit pairing code, not a terminal QR: the adapter calls
`requestPairingCode(WA_PAIRING_NUMBER)` and logs the code, then the operator
enters it under Linked Devices on that phone. Chosen over QR because the code
has a longer window and renders cleanly over SSH and tmux, where terminal QRs
are unreliable.

Dependencies: `baileys`. Depends on nothing in `core` except the contracts.

**`decision-model/client.ts`** — HTTP client for the System One / OpenRouter
endpoint. Exposes one method, `decide(msg): Promise<Decision>`. It fills the six
contract fields — urgency, clarity, `redFlag`, `redFlagInformal`, `wantsHuman`,
category — and stamps `source: "decision_model"`, `model`, and the unmodified
provider body into `raw`. Provider response shape is the client's private
business; the orchestrator only sees `Decision`.

Dependencies: `fetch` (Bun built-in). No SDK.

**`triage/orchestrator.ts`** — the loop. Owns dedup, the timeout, the failure
rule, and the choice of template. Pure function of `(InboundMessage, deps)`.

Dependencies: `DecisionModel` and `WhatsAppChannel` interfaces only.

**`reply/templates.ts`** — maps a `Decision` to Bahasa Indonesia text. Keyed on
`(redFlag, urgency, category)`. Pure, no I/O. This is the file a domain expert
can read and correct without knowing any TypeScript.

`redFlag` arrives as a probability, so the orchestrator binarizes it against the
cutoff for the model that answered (`RED_FLAG_CUTOFF_PRIMARY` for the primary
slug, `..._FALLBACK` for the fallback) before selecting a template. The same
check runs on `wantsHuman`: a patient asking for a person is escalated
regardless of urgency score, because that is the one signal the system is not
allowed to talk itself out of.

**`apps/api/src/routes/webhook.ts`** — `POST /webhook/inbound`, accepts an
`InboundMessage`-shaped body, runs the same handler, responds with the reply it
produced (or `null` when suppressed).

**`apps/api/src/wiring.ts`** — composition root. Reads env, constructs the real
channel and client, registers the handler. The only file that knows which
implementations are live.

## Data flow

1. Baileys emits a `messages.upsert` event.
2. Adapter filters: skip groups, skip `fromMe`, skip status/broadcast, skip
   non-`notify`. Map `key.remoteJid` → phone, `key.id` → `providerMessageId`,
   message body → `text` and `kind`.
3. Adapter calls the registered handler.
4. Orchestrator checks `providerMessageId` against the seen-set. Duplicate →
   return `null`, send nothing. Baileys re-delivers on reconnect; without this
   the patient is answered twice.
5. Orchestrator calls `decisionModel.decide(msg)` under a timeout.
6. Decision → template → `OutboundMessage`.
7. `channel.send()` rate-limits and sends.

## Safety rules

**Model failure escalates, never passes.** Timeout, non-2xx, unparseable body,
or a `Decision` that fails the contract check ⇒ synthesize an escalation
`Decision` and send the emergency template. It must never fall through to a
"low urgency" reply. With the red-flag floor unbuilt, this is the stand-in for
the escalate-only invariant, and it is the single most important behaviour in
this document.

**Dedup is bounded.** The seen-set is capped (ring buffer, ~500 ids). Unbounded
growth is a memory leak in a process meant to run all night.

**Ignore self, groups, status.** A bot that replies to its own messages loops
forever and risks the number.

**`.baileys/` is gitignored before first pair.** Those files are live
credentials for the linked number. Committing them hands your WhatsApp account
to anyone with repo access. Add the entry in the same commit as the adapter.

**Secrets stay in `.env`.** No key, base URL, or phone number in source. Env is
validated once at startup in `wiring.ts`, which fails fast with a named error
rather than a `undefined` propagating into a fetch.

## Configuration

| Variable | Purpose |
|---|---|
| `OPENROUTER_ENDPOINT` | **full** chat-completions URL, path included |
| `OPENROUTER_API_KEY` | bearer token |
| `MODEL_PRIMARY_ID` | pplx-decider slug |
| `MODEL_FALLBACK_ID` | jev slug |
| `RED_FLAG_CUTOFF_PRIMARY` | `0.15` per CLAUDE.md |
| `RED_FLAG_CUTOFF_FALLBACK` | `0.31` per CLAUDE.md |
| `WA_ENABLED` | `true` to link a phone; otherwise webhook-only |
| `WA_PAIRING_NUMBER` | E.164 number the pairing code is requested for |
| `WA_AUTH_DIR` | where pairing credentials go; defaults to `.baileys` |
| `PORT` | defaults to 3000 |

Cutoffs are env-driven rather than constants so the values can be retuned
during judging without a rebuild.

Two changes from the first draft of this spec, both made while implementing:

`OPENROUTER_BASE_URL` became `OPENROUTER_ENDPOINT` holding the **full** URL.
Guessing a path suffix (`/chat/completions`) would have been a coin flip
against a provider whose shape is not yet confirmed; a full URL is correct
either way.

`WA_ENABLED` was added. Without a gate, the process would load and connect
Baileys unconditionally, so a broken Baileys install or an unreachable WhatsApp
server would stop the API from booting — which contradicts this document's own
risk mitigation that the webhook route keeps the pipeline provable.
`WA_AUTH_DIR` came with it.

## Error handling

| Failure | Behaviour |
|---|---|
| Model timeout / 5xx / bad JSON | escalate, send emergency template, log the raw body |
| Model returns contract-invalid Decision | same as above |
| Baileys send fails | log, do not retry in a loop; next message is unaffected |
| Baileys disconnect | log and reconnect; dedup set absorbs re-delivered messages |
| Unknown inbound payload kind | `kind: "other"`, escalate, do not crash |

## Testing

Colocated, per CLAUDE.md. TDD: tests first.

- `reply/templates.test.ts` — every `(redFlag, urgency, category)` branch
  produces non-empty Bahasa text; escalation text is never chosen for a
  low-urgency, no-red-flag decision.
- `triage/orchestrator.test.ts` — driven by `FakeDecisionModel` and
  `FakeChannel`. Cases: happy path emits a reply; duplicate
  `providerMessageId` emits nothing; model rejection emits the escalation
  template; model timeout emits the escalation template.
- `decision-model/client.test.ts` — mapping a recorded provider response to
  `Decision`; malformed body rejects.
- `apps/api/src/app.test.ts` — extends the existing health test with
  `POST /webhook/inbound` via `app.inject()`, asserting a reply comes back with
  both fakes wired.

The orchestrator never touches the network or WhatsApp in tests. Any test that
does is a bug in the test.

## Manual verification

1. `curl -X POST localhost:3000/webhook/inbound` with a Bahasa complaint ⇒
   reply text in the response. Proves the LLM half.
2. Send the same text from a real phone ⇒ same reply arrives on WhatsApp.
   Proves the channel half.

Step 1 passing is the definition of "alive" for tonight.

## Risks

| Risk | Mitigation |
|---|---|
| Baileys pairing eats the evening | HTTP route already proves the pipeline; pairing attaches whenever it lands |
| Number gets flagged | Baileys is demo-only and the adapter rate-limits; use a spare number, not a personal one |
| Provider JSON shape differs from assumption | mapper is isolated and tested against a recorded response; re-record and it is a one-file fix |
| Slugs or base URL differ from CLAUDE.md | everything above is env-driven |

## Next after tonight

Postgres behind a repository interface, then the red-flag floor, then the
conversational LLM for ambiguous cases. Each replaces a fake the loop already
accepts.
