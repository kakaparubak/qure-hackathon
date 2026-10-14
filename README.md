# Qure!

WhatsApp triage assistant for Indonesian puskesmas. Patients chat; AI triages; emergencies jump the queue; nurses get structured records.

> Mobile JKN books the queue. Qure! triages, structures, and escalates the patient before they reach it.

**Joints X UGM hackathon - healthcare subtheme.** Team source of truth: Notion page "Joints X UGM".

## What works today

A patient's WhatsApp message reaches the decision model and a Bahasa Indonesia
reply is sent back. The same pipeline is reachable over HTTP, so it can be
demonstrated by `curl` without a linked phone.

```
phone -> Baileys channel ─┐
                          ├─> orchestrator -> decision model -> reply template
POST /webhook/inbound ────┘
```

Not built yet: the red-flag floor, Postgres persistence, the nurse dashboard,
and the conversational LLM. See `docs/superpowers/specs/` for the design.

## Run it

```bash
cp .env.example .env      # fill in OPENROUTER_ENDPOINT, OPENROUTER_API_KEY, slugs
bun install
bun run dev
```

Boot fails loudly and names every missing variable rather than starting with a
half-configured process.

### Prove the pipeline without a phone

Leave `WA_ENABLED=false`. In another shell:

```bash
curl -s -X POST localhost:3000/webhook/inbound \
  -H 'content-type: application/json' \
  -d '{"phone":"628123456789","text":"nyeri dada dan sesak napas","providerMessageId":"curl-1","receivedAt":"2026-10-14T10:00:00.000Z","kind":"text"}'
```

A chest-pain message must come back as the emergency template. Repeating the
same `providerMessageId` returns `"reply": null` - that is deduplication
working, not a bug.

### Link a real number

Set `WA_ENABLED=true` and `WA_PAIRING_NUMBER` (E.164, digits only), restart,
and read the 8-digit code from the log. Enter it on that phone under **Linked
Devices**. Use a spare number - the transport is unofficial and demo-only.

`WA_AUTH_DIR` (default `.baileys/`) holds the linked session. It is gitignored
because those files are live credentials for the number.

## Safety properties

- **A model failure escalates.** Timeout, provider error, or an unparseable
  body produces the emergency template. Nothing falls through to a reassuring
  reply. This stands in for the escalate-only invariant while the red-flag
  floor is unbuilt.
- **A message is answered at most once.** Re-delivery on reconnect is absorbed
  by a bounded seen-set.
- **Asking for a human escalates** regardless of urgency score.

## Commands

```bash
bun run dev        # start the API
bun test           # all tests, no network required
bun run typecheck  # strict TS across all packages
```

Tests are colocated (`foo.test.ts` beside `foo.ts`) and run entirely against
fakes, so `bun test` needs no credentials.
