import {
  pgTable, pgEnum, uuid, varchar, text, boolean, integer, date,
  timestamp, jsonb, doublePrecision, uniqueIndex,
} from "drizzle-orm/pg-core";

// ---------- helpers ----------
const pk = () => uuid("id").primaryKey().defaultRandom();
const ts = (n: string) => timestamp(n, { withTimezone: true });
const createdAt = () => ts("created_at").notNull().defaultNow();
const updatedAt = () =>
  ts("updated_at").notNull().defaultNow().$onUpdate(() => new Date());

// ---------- enums ----------
export const encounterStatus = pgEnum("encounter_status",
  ["triaging", "waiting", "escalated", "green_lane", "served", "closed"]);
export const triageTier = pgEnum("triage_tier", ["P1", "P2", "P3"]);
export const conditionKind = pgEnum("condition_kind", ["chronic", "allergy", "medication"]);
export const conditionClinicalStatus = pgEnum("condition_clinical_status",
  ["active", "resolved", "inactive"]);
export const queueLane = pgEnum("queue_lane", ["priority", "normal", "green"]);
export const queueStatus = pgEnum("queue_status",
  ["waiting", "called", "served", "abandoned", "diverted"]);
export const messageDirection = pgEnum("message_direction", ["inbound", "outbound"]);
export const messageKind = pgEnum("message_kind",
  ["text", "audio", "image", "document", "other"]);
export const messageSender = pgEnum("message_sender",
  ["patient", "bot", "nurse", "system"]);
export const decisionLayer = pgEnum("decision_layer",
  ["red_flag_floor", "decision_model", "llm"]);
export const redFlagFamily = pgEnum("red_flag_family", [
  "cardiac", "stroke", "breathing", "consciousness", "bleeding_trauma",
  "sepsis", "anaphylaxis", "pregnancy", "mental_health", "severe_pain_poisoning",
]);
export const flowAction = pgEnum("flow_action",
  ["escalate", "queue", "follow_up", "green_lane", "close"]);

// ---------- tables ----------
export const patients = pgTable("patients", {
  id: pk(),
  waNumber: varchar("wa_number", { length: 20 }).notNull().unique(), // E.164 no '+'
  medicalRecordNumber: varchar("medical_record_number"),
  name: varchar("name"),            // nullable: skeleton rows from emergencies
  birthDate: date("birth_date"),    // nullable: same reason
  sex: varchar("sex"),
  bpjsNumber: varchar("bpjs_number"), // optional, never required
  ihsNumber: varchar("ihs_number"),   // SATUSEHAT IHS from MPI
  profileComplete: boolean("profile_complete").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = pgTable("sessions", {
  id: pk(),
  patientId: uuid("patient_id").notNull().references(() => patients.id),
  status: encounterStatus("status").notNull().default("triaging"),
  priority: triageTier("priority"),          // nullable, only escalates
  category: varchar("category"),
  reasonForVisit: text("reason_for_visit"),  // AI read, not a diagnosis
  intake: jsonb("intake"),
  wantsHuman: boolean("wants_human").notNull().default(false),
  isEmergency: boolean("is_emergency").notNull().default(false),
  assignedNurse: varchar("assigned_nurse"),
  nextCheckIn: ts("next_check_in"),          // drives the check-in poller
  lastPatientMessageAt: ts("last_patient_message_at"),
  startedAt: ts("started_at").notNull().defaultNow(),
  closedAt: ts("closed_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const patientConditions = pgTable("patient_conditions", {
  id: pk(),
  patientId: uuid("patient_id").notNull().references(() => patients.id),
  sessionId: uuid("session_id").references(() => sessions.id), // optional
  kind: conditionKind("kind").notNull(),
  icd10Code: varchar("icd10_code"),          // nurse-confirmed
  display: varchar("display").notNull(),
  clinicalStatus: conditionClinicalStatus("clinical_status").notNull().default("active"),
  confirmedBy: varchar("confirmed_by"),
  confirmedAt: ts("confirmed_at"),
  createdAt: createdAt(),
});

export const queueEntries = pgTable("queue_entries", {
  id: pk(),
  // unique = one queue entry per session
  sessionId: uuid("session_id").notNull().unique().references(() => sessions.id),
  queueDate: date("queue_date").notNull().defaultNow(),
  queueNumber: integer("queue_number").notNull(),
  lane: queueLane("lane").notNull(),
  tierAtJoin: triageTier("tier_at_join"),    // historical snapshot, not live tier
  status: queueStatus("status").notNull().default("waiting"),
  etaMinutes: integer("eta_minutes"),
  etaReason: varchar("eta_reason"),
  nursePagedAt: ts("nurse_paged_at"),
  lastCheckinAt: ts("last_checkin_at"),
  checkinCount: integer("checkin_count").notNull().default(0),
  callbackSlot: ts("callback_slot"),         // green-lane callback
  joinedAt: ts("joined_at").notNull().defaultNow(),
  calledAt: ts("called_at"),
  completedAt: ts("completed_at"),
}, (t) => [
  uniqueIndex("queue_day_number_uq").on(t.queueDate, t.queueNumber), // per-day numbering
]);

export const messages = pgTable("messages", {
  id: pk(),
  sessionId: uuid("session_id").notNull().references(() => sessions.id),
  direction: messageDirection("direction").notNull(),
  kind: messageKind("kind").notNull().default("text"),
  sender: messageSender("sender").notNull(),
  body: text("body").notNull().default(""),  // empty for non-text payloads
  waMessageId: varchar("wa_message_id").unique(), // dedups retries
  createdAt: createdAt(),
});

export const triageResults = pgTable("triage_results", {
  id: pk(),
  sessionId: uuid("session_id").notNull().references(() => sessions.id),
  messageId: uuid("message_id").references(() => messages.id), // nullable
  layer: decisionLayer("layer").notNull(),
  redFlagFired: boolean("red_flag_fired").notNull().default(false),
  redFlagFamily: redFlagFamily("red_flag_family"),
  matchedPattern: varchar("matched_pattern"),  // which floor regex fired
  modelName: varchar("model_name"),            // null for floor
  usedFallback: boolean("used_fallback").notNull().default(false),
  cutoffUsed: doublePrecision("cutoff_used"),
  scoreUrgency: doublePrecision("score_urgency"),            // 0-4 fractional
  scoreClarity: doublePrecision("score_clarity"),
  scoreRedFlag: doublePrecision("score_red_flag"),
  scoreRedFlagInformal: doublePrecision("score_red_flag_informal"),
  scoreWantsHuman: doublePrecision("score_wants_human"),
  category: varchar("category"),
  modelLatencyMs: integer("model_latency_ms"),
  routedToLlm: boolean("routed_to_llm").notNull().default(false),
  flowAction: flowAction("flow_action").notNull(),
  tier: triageTier("tier"),
  escalated: boolean("escalated").notNull().default(false),
  rawOutput: jsonb("raw_output"),              // unmodified provider response
  createdAt: createdAt(),
});

export const playbookLog = pgTable("playbook_log", {
  id: pk(),
  sessionId: uuid("session_id").notNull().references(() => sessions.id),
  triageResultId: uuid("triage_result_id").references(() => triageResults.id),
  playbookKey: varchar("playbook_key").notNull(),
  redFlagFamily: redFlagFamily("red_flag_family"),
  playbookVersion: varchar("playbook_version").notNull(),
  messageText: text("message_text").notNull(), // exact text delivered
  deliveredAt: ts("delivered_at").notNull().defaultNow(),
}); 