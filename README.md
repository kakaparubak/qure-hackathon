# Qure!

WhatsApp triage assistant for Indonesian puskesmas. Patients chat; AI triages; emergencies jump the queue; nurses get structured records.

> Mobile JKN books the queue. Qure! triages, structures, and escalates the patient before they reach it.

**Joints X UGM hackathon - healthcare subtheme.** Team source of truth: Notion page "Joints X UGM".

## What works today

A patient's WhatsApp message is triaged and a Bahasa Indonesia reply is sent
back. The same pipeline is reachable over HTTP, so it can be demonstrated by
`curl` without a linked phone.

```
phone -> Baileys channel ─┐
                          ├─> orchestrator ─> L1 red-flag floor ─┬─ hit ─> playbook, no model call
POST /webhook/inbound ────┘                                     └─ miss ─> L2 decision model ─> L3/L4 flow
```

Both triage layers are live:

- **L1, the red-flag floor** - a plain pattern table, ten rule families, no
  network, no dependencies. On a hit the decision model is never called. It
  covers formal and colloquial Bahasa, and it is tuned for recall over
  precision: over-firing costs a nurse one extra glance, under-firing costs a
  life.
- **L2, the decision model** - one System One request asking six questions at
  once (urgency, clarity, red_flag, red_flag_informal, wants_human, category),
  against a chain of models with per-model cutoffs and urgency ceilings.

Escalations send an acknowledgement, a first-aid playbook chosen by rule
family, and a safety closer. None of that text is model-generated.

Not built yet: Postgres persistence, the nurse dashboard, the conversational
LLM rephrase turn (L3 currently asks a fixed follow-up), the queue engine, and
the FHIR mapper. See `docs/superpowers/specs/` for the design.

## Run it

```bash
cp .env.example .env      # fill in OPENROUTER_API_KEY; slugs and cutoffs are pre-filled
bun install
bun run dev
```

Boot fails loudly and names every missing variable rather than starting with a
half-configured process.

### Prove the emergency path with no working model at all

Leave `WA_ENABLED=false`, and leave `OPENROUTER_API_KEY` blank or wrong. In
another shell:

```bash
curl -s -X POST localhost:3000/webhook/inbound \
  -H 'content-type: application/json' \
  -d '{"phone":"628123456789","text":"dada saya kayak di tinju sejak tadi malam","providerMessageId":"curl-1","receivedAt":"2026-10-14T10:00:00.000Z","kind":"text"}'
```

That comes back with `"purpose": "playbook"` and the cardiac steps - "Duduk
atau setengah berbaring", with no aspirin anywhere in it. The floor answered
before the model was ever consulted, which is the property worth demonstrating
live.

Repeating the same `providerMessageId` returns `"reply": null` - that is
deduplication working, not a bug.

### Link a real number

Set `WA_ENABLED=true` and `WA_PAIRING_NUMBER` (E.164, digits only), restart,
and read the 8-digit code from the log. Enter it on that phone under **Linked
Devices**. Use a spare number - the transport is unofficial and demo-only.

`WA_AUTH_DIR` (default `.baileys/`) holds the linked session. It is gitignored
because those files are live credentials for the number.

## Safety properties

Each of these has a test behind it, and each is a property of the whole
pipeline rather than of one function.

- **Escalate-only.** Every layer can move a patient up the ladder and none can
  move them down. The decision model cannot override the floor, and nothing
  overrides an explicit request for a human. Concretely: the escalation branch
  is checked *before* ambiguity, so asking a clarifying question is unreachable
  once anything has fired.
- **The floor short-circuits the model.** On a red-flag hit the model is not
  called at all - asserted as `model.calls === 0`, not as "the reply looks
  right". A model that would have said "no emergency" does not get a vote.
- **A model failure escalates.** Timeout, provider error, or an unparseable
  body produces an escalation with the generic playbook. A missing `red_flag`
  answer is an error rather than a zero.
- **Cutoffs are per-model.** The threshold is looked up by the model that
  answered, and the requested slug is recorded rather than the dated id the
  provider echoes back. Using one model's cutoff on another's output silently
  changes who gets paged.
- **Playbook text is never generated.** Acknowledgement, first-aid steps, and
  the safety closer are fixed strings a clinician can read and correct. The
  cardiac playbook contains no aspirin advice, and an infant under three months
  gets "go now" with no home advice.
- **A message is answered at most once.** Re-delivery on reconnect is absorbed
  by a bounded seen-set, and a suppressed message never even reaches the model.
- **Non-text messages get no triage.** A voice note gets "tolong ketik ya" and
  no decision is recorded.

## Commands

```bash
bun run dev        # start the API
bun test           # all tests, no network required
bun run typecheck  # strict TS across all packages
```

Tests are colocated (`foo.test.ts` beside `foo.ts`) and run entirely against
fakes, so `bun test` needs no credentials.
