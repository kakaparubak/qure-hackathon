# WhatsApp ↔ decision-model pipeline — design

Date: 2026-10-14
Status: approved (approach C)

## Goal

A real WhatsApp message sent to the Qure! number is triaged and gets a Bahasa
Indonesia reply sent back to the same phone. One process, one command.

## Non-goals (tonight)

- Postgres / Drizzle persistence. Sessions live in an in-memory `Map` keyed by
  phone.
- Nurse dashboard, SSE events, queue ordering, FHIR export.
- Conversational LLM (`llm.ts`) prose. Replies are templated, including the L3
  follow-up, which is a fixed question rather than a model-authored one.

Every one of these lands later without changing the loop's shape, because each
sits behind an interface the loop already talks to.

**Not on this list any more: the red-flag floor.** It was scoped out of the
first draft and then built, because it is cheap, it has no dependencies, and it
is what lets the emergency path keep working when the provider does not. See
"Changes made while implementing this spec".

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
  │  dedup → L1 floor ─┬─ hit ─> playbooks (reply/playbooks.ts)
  │                   └─ miss ─> L2 decision model ─> L4 ladder
  │  Decision → reply → OutboundMessage
  ▼
templates (packages/core/src/reply/templates.ts)   ← non-escalation branches
  │
  ▼
BaileysChannel.send()
```

The HTTP route exists so the pipeline is provable without a linked phone.
Baileys pairing is the highest-variance step tonight; the route decouples the
critical path from it.

### Components

**`channel/whatsapp.ts`** — Baileys implementation of the existing
`WhatsAppChannel` contract. Responsibilities: link the session, normalize JIDs
to E.164-without-`+`, emit `InboundMessage`, send `OutboundMessage`, ignore
noise, rate-limit outbound. Auth state written to `.baileys/`.

Two pairing modes, `WA_PAIRING_MODE`:

- **`qr`** — the usual WhatsApp Web flow, rendered as ASCII to stdout. Not bound
  to a phone number, so a wrong or unreachable `WA_PAIRING_NUMBER` cannot break
  it. Needs a terminal wide enough that the modules don't wrap.
- **`code`** — `requestPairingCode(WA_PAIRING_NUMBER)`, entered under Linked
  Devices. Renders anywhere including over SSH, but the code is bound to that
  one number and expires in about two minutes.

This document originally chose the code flow on the grounds that it "has a
longer window" than a QR. That was backwards: the code window is roughly two
minutes against a QR that is reissued every ~20s, and the code's number binding
means a mismatch fails with WhatsApp's generic "check the phone number is
correct" rather than anything diagnosable. QR is the recommendation now; both
remain because the code flow is the only one that works over SSH.

Three behaviours here exist because live testing broke the simpler versions:

- **Linked-ness is `creds.me`, never `creds.registered`.** Baileys sets
  `registered` in exactly one place, the pairing-*code* branch. A QR pairing
  sets `creds.me` and leaves `registered` false forever, so gating on it
  re-pairs a live session on every restart. Baileys itself branches on
  `creds.me`, and `isPaired()` does the same.
- **Inbound senders are resolved through LIDs.** WhatsApp is migrating accounts
  to LIDs, so `remoteJid` is frequently `...@lid`. Resolution order is
  `remoteJidAlt`, then `remoteJid`, then the mapping store via `getPNForLID`.
  A sender that resolves to nobody is logged with its JID - never dropped in
  silence.
- **Reconnects back off and pairing attempts are capped.** A lapsed pairing
  closes with 408/428 and an unregistered socket answers 401; the first version
  retried on a fixed 2s timer, which hammered WhatsApp for nine minutes.

Dependencies: `baileys`, `qrcode-terminal` (ASCII rendering only). Depends on
nothing in `core` except the contracts.

**`decision-model/`** — `schema.ts` owns the wire format: the request builder
(six typed questions against one shared state) and the response parser, kept
together so the questions asked cannot drift from the answers expected.
`client.ts` walks the configured slots in order and returns the first answer.
Exposes one method, `decide(msg): Promise<Decision>`, filling the six contract
fields — urgency, clarity, `redFlag`, `redFlagInformal`, `wantsHuman`, category
— and stamping `source: "decision_model"`, the requested `model` slug, and the
unmodified provider body into `raw`.

Dependencies: `fetch` (Bun built-in). No SDK.

**`red-flag/`** — the floor. `patterns.ts` is a plain table of ten rule families
wired to a tier (`P1`/`P2`) and a playbook id; `floor.ts` normalises a message
and returns the first matching rule. No network, no dependencies, no model.
Tuned for recall over precision. Negation is tolerated by design - see the file
headers for why.

**`triage/orchestrator.ts`** — the loop. Owns dedup, the floor-first order, the
timeout, the failure rule, and the L4 ladder. Pure function of
`(InboundMessage, deps)`.

Dependencies: `DecisionModel` and `WhatsAppChannel` interfaces, the floor, and
the reply tables. Nothing else.

**`reply/templates.ts`** — the four non-escalation branches of Bahasa Indonesia
text: intake, follow-up, text-only, and the family-less escalation. Pure, no
I/O. This is the file a domain expert can read and correct without knowing any
TypeScript.

**`reply/playbooks.ts`** — while-you-wait first aid, one entry per rule family,
plus an acknowledgement and a safety closer. Every escalation is all three
parts, unconditionally. The text is never model-generated: a language model
improvising first aid for someone who may be having a heart attack is not a
risk worth taking, and this is the one file in the repo that has to be readable
line by line by a clinician. Two omissions are deliberate and have tests: the
cardiac playbook carries no aspirin step, and an infant under three months
overrides every family with "go now".

`redFlag` arrives as a probability, so the orchestrator binarizes it against the
cutoff for the model that answered (`RED_FLAG_CUTOFF_PRIMARY` for the primary
slug, `..._FALLBACK` for the fallback, `..._TERTIARY` for the third slot) before
selecting a reply. The same check runs on `wantsHuman`: a patient asking for a
person is escalated regardless of urgency score, because that is the one signal
the system is not allowed to talk itself out of.

**`apps/api/src/routes/webhook.ts`** — `POST /webhook/inbound`, accepts an
`InboundMessage`-shaped body, runs the same handler, responds with the reply it
produced (or `null` when suppressed).

**`apps/api/src/wiring.ts`** — composition root. Reads env, constructs the real
channel and client, registers the handler. The only file that knows which
implementations are live.

## Data flow

1. Baileys emits a `messages.upsert` event.
2. Adapter filters: skip groups, skip `fromMe`, skip status/broadcast, skip
   non-`notify`. Resolve the sender to a phone through `remoteJidAlt`, then
   `remoteJid`, then the LID mapping store; map `key.id` →
   `providerMessageId`, message body → `text` and `kind`. A sender that resolves
   to nobody is logged with its JID and dropped.
3. Adapter calls the registered handler.
4. Orchestrator checks `providerMessageId` against the seen-set. Duplicate →
   return `null`, send nothing. Baileys re-delivers on reconnect; without this
   the patient is answered twice.
5. Non-text payloads stop here: "tolong ketik ya", no triage decision.
6. **L1.** `scan(text)` runs the red-flag floor. On a hit, the decision model is
   never called at all, and the reply is the playbook for the family that fired.
7. Otherwise **L2.** Orchestrator calls `decisionModel.decide(msg)` under a
   timeout.
8. **L4.** Decision → reply → `OutboundMessage`.
9. `channel.send()` rate-limits and sends.

## Safety rules

**Model failure escalates, never passes.** Timeout, non-2xx, unparseable body,
a `Decision` that fails the contract check, or a missing safety-critical answer
⇒ synthesize an escalation `Decision` and send the generic playbook. It must
never fall through to a "low urgency" reply. This is the single most important
behaviour in this document.

The synthetic decision carries `redFlag: 1` by construction, which makes
"escalate on failure" a property of the data rather than a special case in the
ladder - there is no branch to forget to write.

**The floor runs first, and a hit skips the model.** Not an optimisation: the
floor is the layer that cannot be talked out of an emergency by a confident
sentence. Calling the model afterwards for a second opinion would make its
verdict advisory, and the invariant says the model cannot override the floor.
Asserted as `model.calls === 0` rather than by inspecting the reply.

**Escalation is checked before ambiguity.** Asking a clarifying question is a
de-escalation, so it must be unreachable once anything has fired. Two tests pin
it: `ambiguous` + `redFlag: 0.9` and `gibberish` + `urgency: 4` both escalate.

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
| `OPENROUTER_ENDPOINT` | **full** System One URL, path included |
| `OPENROUTER_API_KEY` | bearer token |
| `MODEL_PRIMARY_ID` | `perplexity/pplx-decider-v1.1-27b` |
| `MODEL_FALLBACK_ID` | `typesafe/jev-1.13` |
| `MODEL_TERTIARY_ID` | optional third slot; requires its cutoff |
| `RED_FLAG_CUTOFF_PRIMARY` | `0.15` |
| `RED_FLAG_CUTOFF_FALLBACK` | `0.31` |
| `RED_FLAG_CUTOFF_TERTIARY` | `0.11` |
| `MODEL_*_URGENCY_CEILING` | optional; defaults to 4 / 3 / 2 by position |
| `WA_ENABLED` | `true` to link a phone; otherwise webhook-only |
| `WA_PAIRING_MODE` | `qr` (recommended) or `code`; defaults to `code` |
| `WA_PAIRING_NUMBER` | E.164 number the pairing code is requested for; required in `code` mode, unused by `qr` |
| `WA_AUTH_DIR` | where pairing credentials go; defaults to `.baileys` |
| `PORT` | defaults to 3000 |

Cutoffs are env-driven rather than constants so the values can be retuned
during judging without a rebuild.

Two of these deserve their reasoning stated, because they are the kind of
number that gets "cleaned up" by someone who has not read this document:

**Cutoffs are per-model and not portable.** 0.15 / 0.31 / 0.11 were each
measured against their own model's score distribution. Reusing one model's
cutoff on another's output silently changes who gets paged. A model version
change invalidates them.

**Urgency ceilings differ by slot.** A model asked for a 0-4 score will use 4.
The ceiling is clamped at parse time, so a small model sitting later in the
chain cannot claim emergency authority it has not earned.

`cloudflare/clef-flash` (9B) is deliberately absent: no clean cutoff exists for
it, because a true emergency scored 0.061 - inside its negative distribution.

Changes made while implementing this spec:

`OPENROUTER_BASE_URL` became `OPENROUTER_ENDPOINT` holding the **full** URL.
Guessing a path suffix would have been a coin flip against a provider whose
shape was not yet confirmed; a full URL is correct either way.

`WA_ENABLED` was added. Without a gate, the process would load and connect
Baileys unconditionally, so a broken Baileys install or an unreachable WhatsApp
server would stop the API from booting — which contradicts this document's own
risk mitigation that the webhook route keeps the pipeline provable.
`WA_AUTH_DIR` came with it.

**The decision-model client was written against the wrong wire format.** It
assumed chat completions (a `messages` array, JSON in `choices[0]`). The real
endpoint is `POST /api/v1/systemone`, taking `{ model, state, questions }` and
answering with a keyed `answers` object where each answer carries its own `type`
discriminant. That was a guess in this document, made before the format was
confirmed, and every assumption about it was wrong. Corrected in
`decision-model/schema.ts`.

**`urgency >= 3` did not escalate.** The L4 table in the PRD says it should, but
the ladder fell through to an "urgent" template that told the patient to come in
without paging a nurse, which contradicts the point of the tier. Removed.

**Escalation text was invented.** The first version had one generic emergency
message. The PRD specifies a three-part escalation and a family playbook that is
never model-generated, so `reply/playbooks.ts` now owns that text and
`templates.ts` is left with only the non-escalation branches.

**The floor did not exist.** Implemented before the model layer, per the PRD's
build order. A smoke test against the live process then caught a real gap in it:
"dada saya kayak di tinju" matched nothing, because every cardiac pattern bound
`dada` directly to the next word and Bahasa inserts possessives freely. Fixed by
dropping noise words in `normalize()` and running the pattern table through the
same function, so a pattern is written the way a patient speaks it.

**`bun run dev` did not load the environment.** `--filter @qure/api` runs the
package script with cwd `apps/api`, so Bun loaded `apps/api/.env`, which does
not exist, and the process died naming six missing variables. Both scripts now
pass `--env-file` explicitly. The README's documented command had never worked.

**QR pairing was added after the code flow failed on a real phone.** See the
`channel/whatsapp.ts` section: the code is number-bound and short-lived, and its
failure mode is WhatsApp's generic "check the phone number is correct" message,
which sent the investigation after the wrong problem for several rounds while
the actual cause was a lapsed code.

**`requestPairingCode` was called before the socket was up.** It threw
`Connection Closed`. It now fires on the first `qr` frame, which is the signal
that the noise handshake completed.

**Three pairing/connection behaviours were wrong, all found live.** Gating on
`creds.registered` (false forever after a QR pairing) would have re-paired a
live session on every restart; a fixed 2s reconnect timer hammered WhatsApp for
nine minutes during a failed pairing; and the `loggedOut` branch returned early
for an *unregistered* socket, which is also what a rejected pairing looks like,
stranding the process with no code and no retry.

**Inbound messages were dropped in silence when the sender was a LID.** Three
messages arrived during the first live test and produced no log output, no
reply, and no trace - `phoneFromJid` returns null for anything that is not
`@s.whatsapp.net`, and the handler skipped on null. The auth dir already held
694 `lid-mapping-*_reverse.json` files, so the mapping existed and was being
ignored. Now resolved through `remoteJidAlt`, `remoteJid`, then the mapping
store, and every drop logs its JID.

**The orchestrator logged nothing.** Which layer decided, and why, was only
provable in tests; on a live channel the safety property was invisible. One
`logger` line per triaged message now names `source`, `reason`, `kind`, and
`family`, which is what makes step 3 above checkable.

## Error handling

| Failure | Behaviour |
|---|---|
| Model timeout / 5xx / bad JSON | escalate, send the generic playbook, log the raw body |
| Model returns contract-invalid Decision | same as above |
| Model omits a safety-critical answer | same as above - an absent `red_flag` is not a zero |
| Primary slot fails | try the next slot; only after all of them fail does it escalate |
| Baileys send fails | log, do not retry in a loop; next message is unaffected |
| Baileys disconnect | log and reconnect; dedup set absorbs re-delivered messages |
| Non-text payload (voice note, image) | reply "tolong ketik ya"; no triage, no model call |
| Sender JID resolves to nobody (LID absent from the store) | log the JID and drop; never silent |
| Pairing code lapses or is rejected | back off, mint a new code, stop after five attempts rather than retrying on a timer |
| LID mapping lookup throws | treat as unresolvable; the message is logged, not lost to an exception |

## Testing

Colocated, per CLAUDE.md. 227 tests, no network, no credentials.

- `red-flag/floor.test.ts` — per-family hits in formal and colloquial Bahasa;
  negation firing by design; the miss cases; P1-over-P2 precedence; and table
  invariants (ten families, no duplicates, P1 listed first, every normalised
  pattern non-empty and already normalised).
- `reply/playbooks.test.ts` — every family resolves to a playbook that exists;
  the infant override; and the clinical invariants: no playbook mentions
  aspirin, none prescribes a dose, stroke forbids food and drink, bleeding says
  not to lift the dressing, seizure forbids restraint and objects in the mouth.
- `reply/templates.test.ts` — the four branches; every escalation carries the
  acknowledgement and the safety closer; no English leaks into patient text.
- `triage/orchestrator.test.ts` — driven by `FakeDecisionModel` and
  `FakeChannel`. The load-bearing ones: a floor hit leaves `model.calls === 0`;
  the cutoff applied is the answering model's; escalation outranks ambiguity;
  model failure and timeout escalate; non-text never reaches the model; a
  duplicate never reaches it twice.
- `decision-model/schema.test.ts` — request shape (six questions, three types)
  and the response parser: the dated model id is ignored, urgency is clamped to
  the slot ceiling, a missing `red_flag` throws rather than defaulting to zero.
- `decision-model/client.test.ts` — slot walking, bearer token, malformed body
  falls through to the next slot, and a chat-completions body must not parse.
- `apps/api/src/app.test.ts` — `POST /webhook/inbound` via `app.inject()`.
- `channel/whatsapp.test.ts` — JID parsing, message-kind mapping, and the two
  behaviours live testing broke: `isPaired` treating a QR session (`me` set,
  `registered` false) as linked, and `resolvePhone` handling the LID-only key
  shape, the `remoteJidAlt` shortcut, an absent mapping, and a mapping store
  that throws.
- `config.test.ts` — pairing mode parsing, including that `qr` mode boots with
  no pairing number and that an unknown mode is rejected.

The orchestrator never touches the network or WhatsApp in tests. Any test that
does is a bug in the test.

## Manual verification

All three steps have been run.

1. `curl -X POST localhost:3000/webhook/inbound` with a Bahasa complaint ⇒
   reply text in the response. Proves the LLM half.
2. The same, with a deliberately dead `OPENROUTER_ENDPOINT` and a chest-pain
   message ⇒ the cardiac playbook, because the floor answered before the model
   was consulted. Proves the safety half, and it is the demo that survives a
   provider outage.
3. From a real phone, three messages, each producing one audit line ⇒ the whole
   ladder on a live channel:

   ```
   source=red_flag_floor  reason=red_flag_floor  kind=escalation  family=cardiac
   source=decision_model  reason=none            kind=follow_up
   source=decision_model  reason=none            kind=intake
   ```

   The emergency returned the cardiac playbook ("Duduk atau setengah berbaring",
   no aspirin) with the model never called; the ambiguous message got the
   follow-up question; the routine one reached intake. Proves the channel half
   and the escalate-only ladder at once.

## Risks

| Risk | Mitigation |
|---|---|
| Baileys pairing eats the evening | it did, mostly over the code flow's number binding and short window; QR pairing now exists as the fallback, and the HTTP route keeps the pipeline provable meanwhile |
| A LID-only sender is silently unresolvable | resolution walks `remoteJidAlt` → `remoteJid` → the mapping store, and every unresolvable drop is logged with its JID |
| Number gets flagged | Baileys is demo-only and the adapter rate-limits; use a spare number, not a personal one |
| Provider JSON shape differs from assumption | it did, and it was corrected; the mapper is isolated in one file, so the next change is too |
| A cutoffs or slug revision behind a model alias invalidates the thresholds | cutoffs are env-driven and documented next to the measurement that produced them; re-tune, do not reuse |
| The floor misses a phrasing nobody wrote down | it did once already ("dada saya kayak di tinju"); the noise-word step handles inserted filler, and L2's `red_flag_informal` is the backstop for everything else |

## Next after tonight

Postgres behind a repository interface, then the conversational LLM for
ambiguous cases. Each replaces a fake the loop already accepts. The red-flag
floor is no longer on this list - it is built and verified live.
