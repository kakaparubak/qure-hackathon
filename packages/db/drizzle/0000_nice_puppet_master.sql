CREATE TYPE "public"."clarity" AS ENUM('crystal_clear', 'mostly_clear', 'ambiguous', 'gibberish');--> statement-breakpoint
CREATE TYPE "public"."condition_clinical_status" AS ENUM('active', 'resolved', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."condition_kind" AS ENUM('chronic', 'allergy', 'medication');--> statement-breakpoint
CREATE TYPE "public"."decision_layer" AS ENUM('red_flag_floor', 'decision_model', 'llm');--> statement-breakpoint
CREATE TYPE "public"."encounter_status" AS ENUM('triaging', 'waiting', 'escalated', 'green_lane', 'served', 'closed');--> statement-breakpoint
CREATE TYPE "public"."flow_action" AS ENUM('escalate', 'queue', 'follow_up', 'green_lane', 'close');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."message_kind" AS ENUM('text', 'audio', 'image', 'document', 'other');--> statement-breakpoint
CREATE TYPE "public"."message_sender" AS ENUM('patient', 'bot', 'nurse', 'system');--> statement-breakpoint
CREATE TYPE "public"."queue_lane" AS ENUM('priority', 'normal', 'green');--> statement-breakpoint
CREATE TYPE "public"."queue_status" AS ENUM('waiting', 'called', 'served', 'abandoned', 'diverted');--> statement-breakpoint
CREATE TYPE "public"."red_flag_family" AS ENUM('cardiac', 'stroke_fast', 'breathing', 'consciousness', 'bleeding_trauma', 'sepsis_infection', 'anaphylaxis', 'pregnancy', 'mental_health_crisis', 'severe_pain_poisoning');--> statement-breakpoint
CREATE TYPE "public"."triage_tier" AS ENUM('P1', 'P2', 'P3');--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"direction" "message_direction" NOT NULL,
	"kind" "message_kind" DEFAULT 'text' NOT NULL,
	"sender" "message_sender" NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"meta" jsonb,
	"wa_message_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_wa_message_id_unique" UNIQUE("wa_message_id")
);
--> statement-breakpoint
CREATE TABLE "patient_conditions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"session_id" uuid,
	"kind" "condition_kind" NOT NULL,
	"icd10_code" varchar,
	"display" varchar NOT NULL,
	"clinical_status" "condition_clinical_status" DEFAULT 'active' NOT NULL,
	"confirmed_by" varchar,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wa_number" varchar(20) NOT NULL,
	"medical_record_number" varchar,
	"name" varchar,
	"birth_date" date,
	"sex" varchar,
	"bpjs_number" varchar,
	"ihs_number" varchar,
	"profile_complete" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patients_wa_number_unique" UNIQUE("wa_number")
);
--> statement-breakpoint
CREATE TABLE "playbook_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"triage_result_id" uuid,
	"playbook_key" varchar NOT NULL,
	"red_flag_family" "red_flag_family",
	"playbook_version" varchar NOT NULL,
	"message_text" text NOT NULL,
	"delivered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queue_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"queue_date" date DEFAULT now() NOT NULL,
	"queue_number" integer NOT NULL,
	"lane" "queue_lane" NOT NULL,
	"tier_at_join" "triage_tier",
	"status" "queue_status" DEFAULT 'waiting' NOT NULL,
	"eta_minutes" integer,
	"eta_reason" varchar,
	"nurse_paged_at" timestamp with time zone,
	"last_checkin_at" timestamp with time zone,
	"callback_slot" timestamp with time zone,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"called_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "queue_entries_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"status" "encounter_status" DEFAULT 'triaging' NOT NULL,
	"priority" "triage_tier",
	"category" varchar,
	"reason_for_visit" text,
	"intake" jsonb,
	"wants_human" boolean DEFAULT false NOT NULL,
	"is_emergency" boolean DEFAULT false NOT NULL,
	"assigned_nurse" varchar,
	"encounter_id" varchar,
	"check_in_count" integer DEFAULT 0 NOT NULL,
	"next_check_in" timestamp with time zone,
	"last_patient_message_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "triage_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"message_id" uuid,
	"layer" "decision_layer" NOT NULL,
	"red_flag_fired" boolean DEFAULT false NOT NULL,
	"red_flag_family" "red_flag_family",
	"matched_pattern" varchar,
	"model_name" varchar,
	"used_fallback" boolean DEFAULT false NOT NULL,
	"cutoff_used" double precision,
	"score_urgency" double precision,
	"clarity" "clarity",
	"urgency_confidence" double precision,
	"score_red_flag" double precision,
	"score_red_flag_informal" double precision,
	"score_wants_human" double precision,
	"category" varchar,
	"model_latency_ms" integer,
	"routed_to_llm" boolean DEFAULT false NOT NULL,
	"flow_action" "flow_action" NOT NULL,
	"tier" "triage_tier",
	"escalated" boolean DEFAULT false NOT NULL,
	"raw_output" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_conditions" ADD CONSTRAINT "patient_conditions_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_conditions" ADD CONSTRAINT "patient_conditions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_log" ADD CONSTRAINT "playbook_log_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_log" ADD CONSTRAINT "playbook_log_triage_result_id_triage_results_id_fk" FOREIGN KEY ("triage_result_id") REFERENCES "public"."triage_results"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_entries" ADD CONSTRAINT "queue_entries_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triage_results" ADD CONSTRAINT "triage_results_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triage_results" ADD CONSTRAINT "triage_results_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "queue_day_number_uq" ON "queue_entries" USING btree ("queue_date","queue_number");