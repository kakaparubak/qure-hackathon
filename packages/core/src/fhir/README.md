# Local FHIR R4 export

`sessionToFhirBundle(input)` is a deterministic pure function: the caller supplies
all data and the export timestamp. No network, model, generated identity, database
write or change to triage occurs. `createSessionFhirReader` assembles a consistent
read-only database snapshot for `GET /api/sessions/:id/fhir`.

The dashboard's **Unduh FHIR** button downloads that visit's JSON. Downloads are
uncached and errors remain retryable. The button is hidden in mock mode.

## Mappings

| Input | Output | Rule |
| --- | --- | --- |
| Patient | Patient | Local WhatsApp identifier and phone contact; existing name, birth date, sex and IHS number only. No birth date derived from age; emergency skeleton demographics may be absent. |
| Session | Encounter | Virtual (`VR`) visit: WhatsApp does not prove facility arrival or ED admission. P1/P2/P3 map to EM/UR/R plus the original local tier. No priority is recomputed. |
| Complaint | Encounter.reasonCode.text | Literal intake complaint, or the triggering patient message from the red-flag floor when intake was interrupted. |
| AI interpretation/category | Encounter.reasonCode.text | Explicitly labelled unconfirmed; never assigned an ICD code or promoted to a Condition. |
| Confirmed diagnoses | Condition | Chronic-kind rows with both confirmedBy and confirmedAt and one existing syntactically valid ICD-10 code. No diagnosis is guessed or confirmed by exporting. |
| Intake | QuestionnaireResponse | Includes age, duration, allergies and medicines as patient-reported answers, including literal negative answers. These do not become diagnoses or confirmed allergy/medication resources. |

Active session status mapping: `triaging` → `arrived`, `waiting`, `escalated` and
`green_lane` → `triaged`. A recorded sent staff reply makes an active visit
`in-progress`; assignment alone does not. `served` → `finished`; `closed` →
`finished` only with queue evidence of completed service, otherwise `cancelled`.
No status history or contact dates are invented. Terminal periods end only when
a real completion/closure timestamp is available.

Longitudinal confirmed diagnoses may be included without claiming they were
created during this encounter. Only diagnoses linked to this visit are included
in Encounter.diagnosis. Other patients and other visit-specific records are
excluded. Allergy/medication-kind rows are not mapped into Condition; dedicated
AllergyIntolerance/MedicationStatement mapping remains future work.

## Bundle semantics and limits

This is a self-contained `collection` bundle, not a transaction or clinical
Document. Full URLs use the reserved `https://qure.example/fhir` namespace and
resolve to entries in the downloaded bundle; they are not remote API endpoints.
Identifiers and references are stable across repeated exports. There are no
transaction requests, fake facility/practitioner IDs, profile conformance claims
or automatic submissions.

The structural mapping follows FHIR R4 and relevant SATUSEHAT identifier/ICD-10
conventions. Production SATUSEHAT submission still requires actual MPI/IHS and
facility/practitioner/location references, profile and terminology validation,
and the appropriate registered integration. ICD-10 syntax checks are not a
terminology server lookup. Ineligible diagnosis rows are omitted; the source
records remain unchanged. Bundle JSON-schema checks do not validate every
FHIRPath invariant or SATUSEHAT use-case profile.

## Synthetic demo

`bun run demo:fhir` prints a bundle from `fixtures/visit.json`, with no credentials
or patient database access. The matching pre-rendered artifact is
`docs/demo/fhir-bundle.json`; names, phone number and clinical history are synthetic.

## Validation

The committed synthetic bundle and an emergency skeleton bundle passed the
published HL7 R4 JSON schema (from `fhir.schema.json.zip`, draft-06, AJV).
Date inputs are also validated by the mapper. This is structural validation,
not the full HL7 FHIRPath validator or SATUSEHAT profile/terminology validation.
Fixture tests additionally check internal reference resolution, ownership,
clinical confirmation boundaries and lifecycle semantics.

## Sources

- https://hl7.org/fhir/R4/bundle.html
- https://hl7.org/fhir/R4/encounter.html
- https://hl7.org/fhir/R4/v3/ActEncounterCode/vs.html
- https://terminology.hl7.org/5.5.0/CodeSystem-v3-ActPriority.html
- https://hl7.org/fhir/R4/patient.html
- https://hl7.org/fhir/R4/condition.html
- https://hl7.org/fhir/R4/questionnaireresponse.html
- https://satusehat.kemkes.go.id/platform/docs/id/fhir/resources/patient/
- https://satusehat.kemkes.go.id/platform/docs/id/fhir/resources/condition/
