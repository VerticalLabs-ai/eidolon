-- Add cancellation_deadline_at column to mission_runs (VAL-RUN-136).
-- Forward-only and additive; nullable so existing rows remain valid.
ALTER TABLE "mission_runs" ADD COLUMN "cancellation_deadline_at" timestamp (3) with time zone;
