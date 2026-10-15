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
safety triggers. If you previously pushed the old schema manually, do not apply
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
- `readQueue` returns `QueueRow[]`, usable directly in `queue_updated` events.
  Position derives from lane/joined time with session ID as a deterministic
  tie-breaker. Live tier comes from sessions; ticket number and tier-at-join are
  historical values. Active allergies are surfaced. ETA is derived only when a
  service interval is explicitly supplied, otherwise null. The legacy ETA column
  is not read by this projection. This is not a surge-aware scheduling engine.

## Chat persistence

The API wires `createPipelineStore` around core assessment for both WhatsApp and
HTTP ingress. It upserts a skeleton patient, reuses an open session (or creates
one), records the inbound message, assesses it, persists the decision and sticky
session escalation, and records a pending outbound reply in one transaction.
Patient-row locking serializes turns across processes. The provider message-ID
unique key makes replay suppression survive restarts. A processing exception
rolls back the claim, so that inbound ID can be retried.

The transaction deliberately spans the bounded triage call (9 seconds maximum) and optional intake extraction
(6 seconds maximum). This is a simple serialization strategy for the MVP; it holds a pooled
connection during assessment. Queued routine intake remains `triaging` until the
separate queue-placement work is implemented. No queue entry is fabricated here.

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

`bun test` runs contract tests and applies both migrations to isolated in-memory
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
date. Completion does not create a queue entry. Outbound metadata records whether
intake used scripted fallback and its next field/counter for diagnostics.

The original triage decision is still audited as its own verdict; intake
extraction is not recorded as a fabricated clinical decision. A human handoff is
escalated with wantsHuman set, without setting isEmergency unless medical triage
also fired. Medical signals still select a playbook even when a human request
coexists. Existing escalated sessions never return to collecting routine intake.
