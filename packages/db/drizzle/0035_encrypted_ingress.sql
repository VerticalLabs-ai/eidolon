ALTER TABLE "mission_runs" ALTER COLUMN "request_envelope" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "mission_runs" ADD COLUMN "request_safe_summary" text;