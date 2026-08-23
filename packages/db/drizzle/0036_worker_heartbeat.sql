-- Create mission_worker_heartbeats table for queueHealth derivation (VAL-RUN-088).
-- Forward-only and additive; new table with no changes to existing tables.
-- Each orchestration worker upserts a row on every poll cycle; the snapshot
-- service derives queueHealth from MAX(last_heartbeat_at) age (>=30s = unavailable).
CREATE TABLE "mission_worker_heartbeats" (
	"id" text PRIMARY KEY NOT NULL,
	"worker_id" text NOT NULL,
	"last_heartbeat_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mission_worker_heartbeats_worker_id_unique" ON "mission_worker_heartbeats" USING btree ("worker_id");
