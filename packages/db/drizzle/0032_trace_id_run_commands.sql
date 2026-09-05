-- Add trace_id column to run_commands for trace correlation (VAL-RUN-076).
-- Forward-only and additive; nullable so existing rows remain valid.
ALTER TABLE "run_commands" ADD COLUMN "trace_id" text;
