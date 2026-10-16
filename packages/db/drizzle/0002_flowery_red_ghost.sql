CREATE TABLE "queue_runtime" (
	"id" varchar PRIMARY KEY NOT NULL,
	"surge_active" boolean DEFAULT false NOT NULL,
	"episode" integer DEFAULT 0 NOT NULL
);
