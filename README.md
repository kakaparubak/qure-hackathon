# Qure!

WhatsApp triage assistant for Indonesian puskesmas. Patients chat; AI triages; emergencies jump the queue; nurses get structured records.

> Mobile JKN books the queue. Qure! triages, structures, and escalates the patient before they reach it.

**Joints X UGM hackathon - healthcare subtheme.** Team source of truth: Notion page "Joints X UGM".

## What works today

A patient's WhatsApp message is triaged and a Bahasa Indonesia reply is sent
back. The same pipeline is reachable over HTTP, so it can be demonstrated by
`curl` without a linked phone.

Verified end to end on a real phone: an emergency message returned the cardiac
playbook with the decision model never called, an ambiguous message got the
follow-up question, and a routine request reached intake. Each is one line in
the log:

```
triage 6285190013636: source=red_flag_floor reason=red_flag_floor kind=escalation family=cardiac
triage 6285190013636: source=decision_model reason=none kind=follow_up
triage 6285190013636: source=decision_model reason=none kind=intake
```

That `source=` field is the audit trail. `red_flag_floor` means the model was
never consulted - the property the whole safety argument rests on, visible on a
live channel rather than only in tests.

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

Not built yet: the nurse dashboard, the queue engine, and
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

Set `WA_ENABLED=true`, pick a `WA_PAIRING_MODE`, restart. Use a spare number -
the transport is unofficial and demo-only, and WhatsApp can flag a number for
using it.

**`WA_PAIRING_MODE=qr`** (recommended) - the usual WhatsApp Web flow, printed to
stdout as ASCII. Not bound to any phone number, so it works even when
`WA_PAIRING_NUMBER` is wrong or unset. WhatsApp rotates the QR every ~20s and
only the newest scans, so stream it rather than reading a stale block:

```bash
tail -f <logfile>
```

Needs a terminal at least 63 columns wide in a monospace font, or the modules
misalign and nothing can read it.

**`WA_PAIRING_MODE=code`** - Baileys requests an 8-character code for
`WA_PAIRING_NUMBER` (E.164, digits only). Enter it on that phone under **Linked
Devices**. The code is bound to that number and expires in about two minutes; a
fresh one is minted automatically as the old one lapses. Renders anywhere,
including over SSH.

Either way the log prints `WhatsApp connected as <number>` once linked, and the
session is reused on later boots with no re-pairing.

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
- **A message is never dropped silently.** Inbound senders arrive as WhatsApp
  LIDs (`...@lid`) as often as phone numbers, and a LID that resolves to nobody
  is logged with its JID rather than skipped. A drop with no log line is
  indistinguishable from a message that never arrived, which is exactly how the
  LID gap hid during a live test.
- **Pairing retries are bounded.** A lapsed or rejected pairing backs off
  instead of retrying on a fixed timer, and stops after five attempts. A fixed
  2-second retry loop ran for nine minutes against WhatsApp's pairing endpoint
  before this was caught - that is how a number gets flagged.

## Commands

```bash
bun run dev        # start the API
bun test           # all tests, no network required
bun run typecheck  # strict TS across all packages
```

Tests are colocated (`foo.test.ts` beside `foo.ts`) and run entirely against
fakes, so `bun test` needs no credentials.

### Durable chat records

The running API requires `DATABASE_URL` in the root `.env` and the DB migrations
applied. WhatsApp and HTTP messages now persist patients, active visit sessions,
transcripts, decisions, and outbound reply intent. Escalation stays set on later
turns; duplicate provider IDs remain suppressed after a restart. Delivered
playbooks are logged after successful WhatsApp send. HTTP returns do not count as
WhatsApp delivery. See [database delivery semantics](packages/db/README.md).

### Conversational intake

Non-emergency text now goes through an intake extraction LLM after triage. It
understands answers in context and can capture several explicitly stated facts
from one message. The backend validates supporting text, persists progress in
`sessions.intake`, and asks one fixed Bahasa question at a time for name, age in
years, complaint, duration, allergies, and current medications. It never invents
a birth date from age or turns patient-reported medication text into advice.

Every reply re-enters L1. Medical escalation interrupts intake; `petugas` or
`bicara dengan petugas` requests immediate human handoff. After three consecutive
unresolved answers to the same pending field, intake stops and flags human
handoff. Successful answers reset that counter. Counters and fields survive a
restart and remain isolated per session.

`LLM_ENDPOINT` defaults to OpenRouter chat completions. `LLM_MODEL_ID` defaults
to `openrouter/auto` with its low cost tier; set a specific chat model slug to
pin it. The adapter reuses `OPENROUTER_API_KEY` and times out after six seconds.
Timeouts, invalid JSON, or unavailable providers fall back to scripted direct
answers. This is separate from the calibrated System One decision models.

Patient-facing intake questions and all medical guidance remain backend-owned;
the LLM only proposes extracted facts and a next-field hint. The backend owns
field order, completeness, and escalation. Completion acknowledges the record;
it does not issue a queue ticket or claim that a nurse has received an alert.
A nurse queue/dashboard remains a separate next task.

Try from a fresh visit: `Saya Budi, umur 62 tahun, batuk sudah 3 hari.` Then answer
the allergy and medication questions. Use another account to check isolation.
An already escalated session remains escalated; it will not restart routine
intake just because the next message is benign.
