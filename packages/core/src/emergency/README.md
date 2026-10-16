Emergency conversation

The first emergency reply stays a local, fixed playbook. Subsequent patient text,
while no staff member owns the session, uses a separate LLM to select up to two
entries and one question from engine.ts. The model cannot author clinical prose,
set priority, diagnose, prescribe, clear an emergency, or promise dispatched help.
An invalid, truncated or unavailable provider tries the next provider, then falls
back to local support. Each provider has a four-second request timeout.

The server retains all previous red-flag families from the current session.
A new family gets an immediate static playbook. Multiple families allow only
common dialogue entries, avoiding a mixture of incompatible family instructions.
Staff takeover pauses automation; no staff response is assumed or guaranteed.
No autonomous check-in or external ambulance/nurse dispatch is implemented.

Catalog sources (checked 2026-10-16):
- Indonesia 119 emergency access and operator assistance:
  https://www.kemkes.go.id/id/akses-darurat-medis-119-kini-bisa-melalui-satusehat-mobile
- Stopping activity and resting comfortably for suspected cardiac symptoms:
  https://www.redcross.org/take-a-class/resources/learn-first-aid/heart-attack
- External bleeding: direct pressure; do not remove embedded objects:
  https://www.redcross.org/take-a-class/resources/learn-first-aid/bleeding-life-threatening-external

This is a limited first-aid support catalog, not autonomous treatment. Sourcing
and automated tests do not substitute for local clinician review before clinical
use. Family-specific dialogue currently covers cardiac rest and external bleeding;
other families use common support and immediate emergency-service guidance.
Every reply is persisted with catalog version, selections, family context and
fallback status. Conversational support is not logged as a delivered full playbook.
