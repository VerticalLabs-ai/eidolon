-- Add source_profile_name and source_profile_description to run_policy_snapshots.
-- These nullable text columns store the mode/profile display name and description
-- at snapshot time so historical mode identity survives profile renames, disables,
-- or deletions (VAL-MODEQ-129). They are display text and are NOT included in the
-- canonical content hash (VAL-MODEQ-127: secrets, display text, timestamps, and
-- mutable rows are excluded from hashing).
--
-- Forward-only and additive: nullable columns with no default, safe for legacy rows
-- (existing snapshots have NULL for both fields).
ALTER TABLE "run_policy_snapshots" ADD COLUMN "source_profile_name" text;--> statement-breakpoint
ALTER TABLE "run_policy_snapshots" ADD COLUMN "source_profile_description" text;
