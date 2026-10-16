import { and, eq, isNull, or, sql, desc, asc } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { sessionToFhirBundle, type FhirBundle } from '@qure/core/fhir/mapper';
import { readIntake } from '@qure/core/intake/engine';
import * as s from './schema';

/** Snapshot reads only. Exports never change a visit or mark a diagnosis confirmed. */
export function createSessionFhirReader<T extends PgQueryResultHKT>(db:PgDatabase<T,typeof s>) {
  return async (id:string,exportedAt=new Date()):Promise<FhirBundle|null>=>db.transaction(async tx=>{
    const [row]=await tx.select({session:s.sessions,patient:s.patients,
      staffStarted:sql<boolean>`exists(select 1 from ${s.messages} m where m.session_id = ${s.sessions.id} and m.sender = 'nurse' and m.meta->>'delivery' = 'sent')`,
    }).from(s.sessions).innerJoin(s.patients,eq(s.patients.id,s.sessions.patientId)).where(eq(s.sessions.id,id));
    if(!row) return null;
    const [queue]=await tx.select().from(s.queueEntries).where(eq(s.queueEntries.sessionId,id));
    const [triage]=await tx.select({category:s.triageResults.category}).from(s.triageResults)
      .where(and(eq(s.triageResults.sessionId,id),sql`${s.triageResults.category} is not null`))
      .orderBy(desc(s.triageResults.createdAt),desc(s.triageResults.id)).limit(1);
    // Floor emergencies can interrupt before intake has a complaint. Preserve
    // the actual triggering patient text without turning the floor into a diagnosis.
    const [floorMessage]=await tx.select({body:s.messages.body}).from(s.triageResults)
      .innerJoin(s.messages,eq(s.messages.id,s.triageResults.messageId))
      .where(and(eq(s.triageResults.sessionId,id),eq(s.triageResults.redFlagFired,true),eq(s.messages.direction,'inbound'),eq(s.messages.kind,'text')))
      .orderBy(asc(s.triageResults.createdAt),asc(s.triageResults.id)).limit(1);
    const conditions=await tx.select().from(s.patientConditions).where(and(eq(s.patientConditions.patientId,row.patient.id),or(isNull(s.patientConditions.sessionId),eq(s.patientConditions.sessionId,id))));
    const {session,patient}=row;
    return sessionToFhirBundle({exportedAt:exportedAt.toISOString(),
      patient:{id:patient.id,waNumber:patient.waNumber,name:patient.name,birthDate:patient.birthDate,sex:patient.sex,ihsNumber:patient.ihsNumber,medicalRecordNumber:patient.medicalRecordNumber},
      session:{id:session.id,patientId:session.patientId,status:session.status,priority:session.priority,startedAt:session.startedAt.toISOString(),closedAt:session.closedAt?.toISOString() ?? queue?.completedAt?.toISOString(),
        staffStarted:row.staffStarted,served:session.status === 'served' || queue?.status === 'served',reasonForVisit:session.reasonForVisit,presentingComplaint:floorMessage?.body,category:session.category ?? triage?.category,
        intake:session.intake === null ? null : readIntake(session.intake)},
      conditions:conditions.map(condition=>({id:condition.id,patientId:condition.patientId,sessionId:condition.sessionId,kind:condition.kind,icd10Code:condition.icd10Code,display:condition.display,clinicalStatus:condition.clinicalStatus,confirmedBy:condition.confirmedBy,confirmedAt:condition.confirmedAt?.toISOString()})),
    });
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}
