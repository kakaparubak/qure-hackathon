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
  Urgency ≥ 3 escalates independently. A red-flag cutoff crossing also requires
  urgency ≥ 2 or informal red-flag probability ≥ 0.5. Floor hits bypass this
  gate. Ambiguous/gibberish clarity triggers follow-up after escalation checks;
  urgency confidence is recorded but does not control routing.

Escalations send an acknowledgement, a first-aid playbook chosen by rule
family, and an immediate 119 safety closer. None of that text is model-generated.
Follow-up emergency text uses a separate LLM to select relevant, fixed first-aid
support and one focused question while staff have not taken over. The model cannot
diagnose, prescribe, author treatment, or clear the emergency. See
[emergency conversation](packages/core/src/emergency/README.md) for scope and sources.

The API now persists chat records and intake, issues daily queue tickets, and
serves a nurse dashboard with queue updates, patient threads, triage history,
allergy flags, nurse messaging, and a mark-served action. Basic positions and
optional ETAs are derived from active queue entries. The Cloud API adapter remains unimplemented. The Docker VPS scaffold is implemented; container build verification and actual VPS deployment remain operator steps. Local FHIR export is implemented. Surge mode and opt-in callback scheduling are implemented. `docs/superpowers/specs/` records the original
pipeline design; the source code and current behavior below describe progress.

## Run it

```bash
cp .env.example .env      # fill in OPENROUTER_API_KEY; slugs and cutoffs are pre-filled
bun install
bun run dev
```

Boot fails loudly and names every missing variable rather than starting with a
half-configured process.

### Prove the emergency path with no working model at all

Set `WA_ENABLED=false` and use a nonempty invalid `OPENROUTER_API_KEY` (boot
validation requires a value). Keep `DATABASE_URL` configured and migrations
applied. In another shell:

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
bun run test       # API/core/DB tests; SSE test binds a local port
bun run test:dashboard # dashboard tests via Vitest
bun run typecheck  # strict TS across all packages
```

Tests are colocated (`foo.test.ts` beside `foo.ts`) and use fakes and isolated
PGlite databases, so they need no service credentials or external network. The
SSE integration test opens a local HTTP listener.

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
`sessions.intake`, and controls field order for name, age in years, complaint,
duration, allergies, and current medications. The LLM can write a conversational
question; backend reply validation and fixed Bahasa questions provide fallback. It never invents
a birth date from age or turns patient-reported medication text into advice.

Every reply re-enters L1. Medical escalation interrupts intake; `petugas` or
`bicara dengan petugas` requests immediate human handoff. After three consecutive
unresolved answers to the same pending field, intake stops and flags human
handoff. Successful answers reset that counter. Counters and fields survive a
restart and remain isolated per session.

When `ZAI_API_KEY` is set, z.ai is the primary intake provider (defaults:
`glm-5.3-flash` and its chat-completions endpoint). OpenRouter is the fallback:
`LLM_ENDPOINT` defaults to OpenRouter chat completions and `LLM_MODEL_ID` to
`openrouter/auto` with its low cost tier, using `OPENROUTER_API_KEY`. Provider
requests time out after six seconds each. Extraction retries once per provider;
if both providers fail, scripted direct-answer extraction takes over. A separate
reply-generation call also fails over, then uses the fixed question. The total
turn can therefore exceed six seconds. These providers are separate from the
calibrated System One decision models.

Extraction accepts both field maps and validated arrays of field updates.
Evidence checks recognize Indonesian repeated-word shorthand (`kacang2an` →
`kacang-kacangan`) while retaining the original patient message. Scripted
extraction does not disable conversational reply generation. Invalid or
truncated provider replies try the next provider before a fixed question is
used; medication-history questions are allowed, medication instructions are
rejected. Replies must ask about the backend's pending field.

Provider fallback logs contain only the operation, provider slot, and failure
category. Outbound intake metadata separates extraction fallback (`usedFallback`)
from `replyFallbackReason` (`unavailable`, `provider_failure`, `invalid_reply`,
or null), so a scripted question can be diagnosed without logging patient text.
`replyProviderFailures` records safe provider-slot/reason pairs, distinguishing
rejected wording from timeouts and malformed responses. `extractionRecovery`
records rejected/recovered field names and whether patient history was used.

When extraction omits a clear symptom statement, the backend preserves the
patient's literal wording (including details such as "kena paku") rather than
re-asking the complaint or accepting an unsupported medical paraphrase. Recovery
uses only patient messages from the current visit, never assistant examples.
Literal onset phrases such as "dari kemaren" stay literal. Additional complaint
details retain the earlier complaint and count as progress, so an unrelated
pending identity question does not turn useful symptom answers into failed
attempts. Truly unresolved answers remain bounded and hand off as before.


Medical escalation guidance remains static. The backend owns field order,
completeness, and escalation; the intake LLM proposes evidenced facts and can
write the non-emergency question. Completing intake creates a normal-lane queue
entry and returns its stable daily ticket number and current lane position.
Escalations join the priority lane. The first alert is static; follow-up emergency
replies select from a bounded support catalog using persisted emergency context,
with local fallback if providers fail. Every reply urges immediate external help. The dashboard
shows new P1 alerts; `nursePagedAt` records priority placement, not proof of an
external notification or nurse acknowledgement.

Try from a fresh visit: `Saya Budi, umur 62 tahun, batuk sudah 3 hari.` Then answer
the allergy and medication questions. Use another account to check isolation.
An already escalated session remains escalated; it will not restart routine
intake just because the next message is benign.


### Nurse dashboard

Run `VITE_USE_MOCK=false bun run build`, then start the API and open
`http://localhost:3000/dashboard/`. Mock data is enabled by default unless
`VITE_USE_MOCK` is exactly `false` at build time. The built dashboard and API
share an origin. `GET /api/events` polls the queue every three seconds and emits
`queue_updated` events; disconnected clients also poll REST. Session details
refresh every two seconds, including incoming patient replies during staff care.

Nurses can inspect threads, send WhatsApp messages, and mark sessions served.
Sending a staff message claims the visit before delivery and pauses model triage,
LLM intake, and automatic chat replies until the visit ends. Patient messages
continue to persist and appear in the open thread. Local deterministic red-flag
screening still raises priority and records its finding, without sending another
bot playbook into the staff conversation. The assignment persists across server
restarts; older visits with nurse messages also pause automation on their next
patient turn. A new visit after serving starts with automation enabled. A failed
staff send leaves takeover active so the bot does not interrupt while staff retry.
The transcript labels staff, patient, and assistant messages separately.
With `WA_ENABLED=false`, nurse sends return HTTP 503 and do not record a sent
message. Live sends are recorded after the transport accepts them; a later DB
failure can still leave an unrecorded delivery.

Allergy flags combine active patient-condition records with this visit's
patient-reported intake allergies. Details label intake allergies as
patient-reported; displaying them does not create or confirm a clinical
Condition. Explicit none/unknown answers do not create positive allergy flags.

Set `QUEUE_SERVICE_MINUTES` to a positive service interval to enable the basic
lane-position ETA calculation; otherwise ETA is unavailable. This accounts for priority demand and callback slots. Pending outbound messages require reconciliation; there
is no automatic resend worker.


### Surge mode and green lane

Apply migrations (`bun run --cwd packages/db migrate`) before starting this
version. Migration `0002` adds the singleton `queue_runtime` table for durable
surge episodes and callback allocation. No existing patient data is replaced.

At three active P1 visits, the queue worker records one surge notice per waiting
routine patient, including new arrivals during the surge. A matching recovery
notice is sent once when P1 demand drops below three. Staff-managed visits,
human requests, and emergencies receive no queue broadcasts. Notices are claimed
before sending; failed or interrupted sends require reconciliation rather than
blind automatic retries. In webhook-only mode the notices remain pending and
are not treated as delivered.

P1 cases lead the priority lane; other priority cases follow, then normal FIFO,
then callbacks ordered by their booked time. Position is numbered within each
lane. Routine ETA includes everyone in the priority lane ahead of it; it stays
unavailable unless `QUEUE_SERVICE_MINUTES` is configured. Tickets remain stable.

A delivered surge notice offers `JALUR HIJAU` only for visits with a clear
low-acuity minor/routine-medication decision (urgency at most 1), no higher-acuity
verdict anywhere in the visit, no escalation, and no human request. The patient
must explicitly accept while surge is still active. The backend rechecks triage
and eligibility, then retains the ticket and books a callback. It never moves a
patient automatically or clears a priority/human/emergency flag. New symptoms
and human requests still escalate callbacks immediately.

`QUEUE_CALLBACK_DELAY_MINUTES` defaults to 60; `QUEUE_CALLBACK_SPACING_MINUTES`
defaults to 10. These are scheduling defaults, not clinical wait-time advice.
Callback slots are visible in the dashboard in WIB; staff deliver the callback
through the existing chat and finish the visit normally. There is no automatic
phone dialer. Scheduled check-ins are implemented as described below.


### Scheduled waiting-room check-ins

A live WhatsApp worker polls every 30 seconds. Routine patients in the normal
waiting queue receive a check-in after 45 minutes without a patient message.
Their reply re-enters L1 and the normal triage pipeline; a floor hit immediately
escalates, while a routine reply postpones the next check-in.

The default limit is three reminder attempts per visit, persisted across restarts
and patient replies. After another interval without a reply, the visit moves to
the P2 human queue, keeps its ticket, and receives one handoff notice. Silence is
not a medical diagnosis and never clears an existing priority. Delivery failure
or unresolved delivery also routes to human review rather than retrying blindly.

Set `CHECK_IN_INTERVAL_MINUTES` (default 45, positive and at most 1440) and
`CHECK_IN_MAX_REMINDERS` (default 3, integer 1–10) to override the defaults. For a
local demonstration, an interval of 1 minute avoids a 45-minute wait.

Staff-owned, emergency, escalated, callback, called, served and closed visits do
not receive routine reminders. Patient replies, staff takeover and visit closure
cancel unsent reminders. Existing waiting visits are scheduled from their latest
patient activity/queue entry. No reminders go out beyond 24 hours from the last
patient message; those visits are flagged internally for human review. Webhook-only
mode neither polls nor reserves reminders.

The scheduler reuses `sessions.next_check_in`, `check_in_count` and the message
outbox; no new database migration is needed. Reservations are transactional and
claimed once across workers. A message already claimed for transport may complete
while staff take over; pending messages are cancelled. A crash during sending
leaves an uncertain delivery for reconciliation and never blindly resends it.


### Download a FHIR visit bundle

Open a patient thread in the live dashboard and choose **Unduh FHIR**, or request
`GET /api/sessions/:id/fhir`. This downloads an uncached FHIR R4 collection bundle
with Patient, Encounter, eligible confirmed Condition records and patient-reported
intake in QuestionnaireResponse. Export works on active and completed visits and
does not change their records or triage. No database migration is required.

For an offline demonstration, `bun run demo:fhir` prints the synthetic fixture;
`docs/demo/fhir-bundle.json` is the matching pre-rendered artifact. No real patient
data or credentials are used. See [FHIR mappings and limits](packages/core/src/fhir/README.md)
for lifecycle mappings, included data, exclusions and SATUSEHAT deployment needs.


### Run on a private VPS

See [VPS deployment](deploy/README.md) for Docker build, explicit migrations,
one-time WhatsApp pairing and the SSH tunnel. `compose.yaml` preserves the linked
session in a named volume, caps memory, probes readiness and restarts process
failures. It binds only to VPS localhost and builds the dashboard in live mode.
No local `.env` or default Baileys credentials are included in the image.
