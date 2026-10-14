# Project: Qure! (qure-hackathon)

WhatsApp triage assistant for puskesmas (Indonesian community health centers). Hackathon: Joints X UGM, healthcare subtheme.

## The Product
Patients chat WhatsApp; an AI pipeline triages every inbound message. Emergencies jump the queue and page a nurse; everyone else gets queue position + ETA + structured pre-visit intake. Nurse dashboard shows the live queue.

## Architecture (four layers, escalate-only invariant)
1. Red-flag floor: deterministic Bahasa regex patterns (recall over precision). Local, no network. NEVER consults a model.
2. Decision model: pplx-decider-v1.1 primary (red_flag cutoff 0.15), jev-1.13 fallback (cutoff 0.31), via OpenRouter System One API. Six parallel questions: urgency (score 0-4), clarity (choice), red_flag / red_flag_informal / wants_human (noul), category (choice).
3. Selective routing: model low-confidence -> full LLM turn.
4. Flow: clear+confident -> guided intake; ambiguous -> follow-up question; wants-human -> human queue.

INVARIANT: every layer can only ESCALATE, never de-escalate. Never remove this property.

## Stack
- Bun + Fastify + TypeScript (monorepo)
- Supabase Postgres + Drizzle ORM
- Baileys (WhatsApp, unofficial, demo-only) behind whatsapp.ts adapter; Meta Cloud API test number as fallback
- Dashboard: Vite + React + Tailwind, read-only
- FHIR R4 output: session -> FHIR bundle mapper (SATUSEHAT-compatible)

## Structure
- apps/api      - Fastify server, webhook/message ingestion, routes
- packages/core - triage pipeline: red-flag floor, decision-model client, orchestrator, playbooks
- packages/db   - Drizzle schema + migrations

## Rules
- TypeScript strict mode everywhere
- Every external dependency behind a thin adapter (whatsapp.ts, decision-model.ts, llm.ts)
- Never log or commit secrets; .env only
- Red-flag floor patterns live in a plain table - must stay human-readable
- Tests colocated: foo.test.ts next to foo.ts
