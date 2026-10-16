import { sessionToFhirBundle } from '../packages/core/src/fhir/mapper';
import visit from '../packages/core/src/fhir/fixtures/visit.json';
// Synthetic fixture only: no database, model, patient account or credentials.
console.log(JSON.stringify(sessionToFhirBundle(visit as Parameters<typeof sessionToFhirBundle>[0]),null,2));
