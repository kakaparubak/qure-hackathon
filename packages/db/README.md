# Database package

Drizzle/Postgres persistence aligned with the frozen core contracts. Importing
`@qure/db` has no connection side effects. Construct a client explicitly:

```ts
import { createDatabase, createRepository } from '@qure/db';
const { db, close } = createDatabase(process.env.DATABASE_URL ?? '');
const repository = createRepository(db);
// Call close() during application shutdown.
```

## Migrations

From `packages/db`:

```sh
bun run generate
bun run migrate
```

`migrate` loads the root `.env`. Set `DATABASE_URL` to a PostgreSQL connection
string for the intended database. Use a direct/session connection for migrations;
the application client disables prepared statements for pooler compatibility.
Generation does not require credentials. No migration runs on import or boot.

The checked-in `0000` is an initial schema for an empty database. `0001` adds
safety triggers. `0002` adds durable queue runtime state. If you previously pushed the old schema manually, do not apply
the initial migration over it: reconcile and baseline that database first. In
particular, the old family enum values and numeric clarity column need an
explicit data migration; existing data must not be dropped to fit this schema.

## Contract mapping

- Patient identity: `InboundMessage.phone` maps to unique `patients.waNumber`.
- `inboundToRow` preserves kind, provider message ID and received timestamp;
  `outboundToRow` retains phone and purpose in message metadata.
- `decisionToRow` preserves every Decision field, including categorical clarity,
  urgency confidence and raw provider findings. Unknown floor families fail.
- Session statuses and priorities use the frozen enums. `updateSession` locks
  the row in a transaction before checking legal transitions. SQL triggers
  independently reject illegal transitions, tier downgrades, cleared human
  requests and cleared emergency flags.
- `triage_results` rejects UPDATE, DELETE and TRUNCATE. Administrative schema
  owners can disable triggers; use a restricted application role in deployment.
- Check-in count belongs to sessions, including emergencies not yet queued.
- `readQueueBoard` returns `QueueTicketRow[]`, including stable daily ticket
  numbers and dates. The SSE route emits this array as `queue_updated` data;
  the dashboard invalidates its queue query and reads fresh REST data.
  Position derives from lane/joined time with session ID as a deterministic
  tie-breaker. Live tier comes from sessions; ticket number and tier-at-join are
  historical values. Active condition allergies and patient-reported intake
  allergies are surfaced; explicit none/unknown intake answers are excluded.
  Session details label intake allergies as patient-reported, without inserting
  clinical Condition rows or claiming nurse confirmation. ETA is derived only when a
  service interval is explicitly supplied, otherwise null. The legacy ETA column
  is not read by this projection. Priority demand is included in normal-lane ETA; callback ETA is derived from its slot.

## Chat persistence

The API wires `createPipelineStore` around core assessment for both WhatsApp and
HTTP ingress. It upserts a skeleton patient, reuses an open session (or creates
one), records the inbound message, assesses it, persists the decision and sticky
session escalation, and records a pending outbound reply in one transaction.
Patient-row locking serializes turns across processes. The provider message-ID
unique key makes replay suppression survive restarts. A processing exception
rolls back the claim, so that inbound ID can be retried.

The transaction spans the bounded triage call (9 seconds maximum), optional
intake extraction, and conversational reply generation. Each intake HTTP request
has a six-second timeout; extraction retries and provider failover can make the
total turn substantially longer. This serialization strategy holds a pooled
connection during assessment. Routine intake remains `triaging` until complete,
then creates a normal-lane queue entry and transitions to `waiting`. Escalations
create a priority-lane entry or upgrade the existing entry without changing its
daily ticket. `nursePagedAt` records priority placement, not confirmed external
notification delivery. Positions are derived; optional ETAs use a configured
service interval. Surge notices and opt-in callbacks are managed by `createQueueEngine`; `createCheckInEngine` manages scheduled check-ins using the existing session fields and durable message outbox.

WhatsApp sends after commit. Successful send is followed by a second transaction
that marks the outbound sent and inserts a playbook log, when applicable. HTTP
only returns the reply: its outbound record remains pending and it does not
claim WhatsApp delivery. Voice notes are stored but create no triage verdict.

A database failure produces an explicit recording-error/human-escalation fallback
and keeps family-specific emergency guidance when the local floor matches. It
cannot claim that the failed transaction was persisted.

Delivery limitation: the database and WhatsApp cannot commit atomically. A crash
between commit and send leaves a pending outbound; a crash between send and the
delivery audit can also leave one. Duplicate inbound events do not resend it.
Pending records require reconciliation; no automatic resend worker is included
because blind retry could duplicate patient guidance. This provides durable
inbound deduplication, not exactly-once outbound delivery.

## Verification

`bun test` runs contract tests and applies all migrations to isolated in-memory
PGlite (PostgreSQL). Tests cover all 36 state transitions, de-escalation guards,
append-only audit rows, provider-ID uniqueness and emergency skeleton patients.
These tests do not connect to Supabase or validate its production roles/network.

## Persisted intake state

`sessions.intake` is a validated version-1 JSON record of fields, the pending
question, failed attempts on that question, and collecting/complete/handoff
status. No schema migration is required for this JSON-only feature. The intake
model gets only this session's recent text history and current message. Extraction
updates need supporting quotes in the current message. Name is also copied to
`patients.name`; age remains age in the visit record, never a fabricated birth
date. Completion creates a normal-lane queue entry and a daily ticket, then
transitions the session to `waiting`. Outbound metadata records whether
intake used scripted fallback and its next field/counter for diagnostics.

The original triage decision is still audited as its own verdict; intake
extraction is not recorded as a fabricated clinical decision. Non-emergency
questions can be model-written after reply validation, with fixed questions as
fallback. Medical escalation guidance remains static. A human handoff is
escalated with wantsHuman set, without setting isEmergency unless medical triage
also fired. Medical signals still select a playbook even when a human request
coexists. Existing escalated sessions never return to collecting routine intake.


## Staff takeover

`claimStaffSession` locks patient then session, matching the intake lock order,
and uses the existing `assigned_nurse` column to persist staff ownership before
sending a dashboard reply. Serving the visit ends this ownership; a new visit
has no assignment. If delivery fails, the visit stays with staff for retry.

During staff care, patient messages are deduplicated and committed without model
or LLM calls and without bot replies. Local floor hits still append a verdict,
raise sticky session priority, and move the queue entry to priority. Legacy
sessions with nurse transcript rows are recognized on their next inbound turn.
`process` returning null can mean a persisted staff-managed inbound with no
outbound intent, as well as an already-seen provider ID. Nurse transcripts retain
their sender role, and session detail exposes `staffHandling` to the dashboard.
No new migration is needed.


## Queue engine delivery

`queue_runtime` serializes surge episode changes and callback allocation.
`createQueueEngine.refresh` recalculates normal queue ETA and records at most one
surge/recovery notice per patient per episode in `messages.meta.queueKey`.
Explicit callback consent requires an actually delivered offer from the active
episode and rechecks the patient's whole visit evidence. Callback slots are
allocated under the runtime row lock, keeping their original daily tickets.
Completing a callback uses the existing legal `green_lane -> closed` transition.

The API worker ticks every three seconds without overlapping. Notifications move
from `pending` to `sending` in a transaction before transport, then `sent` or
`failed`. Obsolete notices and staff takeovers are cancelled before delivery.
A crash after claiming a send leaves `sending` for reconciliation, preventing
blind replay across restarts. This outbox is specific to queue notices; earlier
triage replies retain their existing delivery behavior. No network calls occur
inside refresh or consent transactions.


`createCheckInEngine(db, options)` schedules normal waiting visits, reserves bounded
reminders and claims each for delivery once. Default: 45 minutes, three attempts;
the API polls every 30 seconds only with a live WhatsApp channel. New inbound turns
reschedule and cancel pending notices without resetting the per-visit bound.
Exhaustion/delivery failure sets `wants_human`, escalates to P2, retains the ticket,
and records the operational reason in message metadata (no fabricated medical
triage verdict). Staff takeover, green-lane routing, serving/closure and medical
escalation clear schedules. Claims recheck eligibility and the 24-hour contact
window. `sending` deliveries are not retried after crashes; they require
reconciliation. The window limit produces internal human review without outreach.


`createSessionFhirReader(db)(sessionId)` reads a repeatable-read, read-only snapshot
and calls the pure core FHIR mapper. It returns null for an unknown visit and
never writes export markers or clinical confirmation. Conditions are restricted
to the visit's patient and either this visit or longitudinal records. The reader
retains sent staff-contact evidence, completed callback evidence and the actual
floor-triggering patient text where intake was interrupted. The API download is
`GET /api/sessions/:id/fhir` with `application/fhir+json` and `Cache-Control: no-store`.
