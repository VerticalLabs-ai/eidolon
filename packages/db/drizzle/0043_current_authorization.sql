-- Allow multiple historical approved bindings to coexist with one current
-- execution authorization per run (VAL-PLAN-102, VAL-PLAN-039, VAL-PLAN-101,
-- VAL-PLAN-121).
--
-- Phase 1 originally enforced "at most one approved binding per run" via a
-- partial unique index on (run_id) WHERE decision = 'approved'. That
-- prevents safe post-approval revision branching: after approving revision
-- A, revising, and approving revision B, both immutable decisions must
-- remain readable while only B is the current execution authorization.
--
-- This migration:
--  1. Drops the partial unique index that limited runs to one approved
--     binding. Historical approved bindings are now retained as immutable
--     governance records.
--  2. Adds a non-null `is_current_authorization` boolean (default false) to
--     `run_plan_approval_bindings` so exactly one binding per run can be
--     marked as the current execution authorization.
--  3. Backfills the column: for each run, the most recently decided
--     approved binding (if any) is marked as the current authorization.
--     This preserves the existing invariant that a queued/run run has at
--     most one current authorization.
--  4. Adds a partial unique index on (run_id) WHERE
--     is_current_authorization = true so at most one current authorization
--     exists per run.
--
-- Forward-only and additive: the column is nullable during the transition,
-- then set NOT NULL after backfill. Existing rows are unchanged in content;
-- only the authorization flag and index shape change.
DROP INDEX IF EXISTS "uq_run_plan_approval_bindings_run_approved";
--> statement-breakpoint
ALTER TABLE "run_plan_approval_bindings" ADD COLUMN "is_current_authorization" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Backfill: mark the latest approved binding per run as current. Uses
-- DISTINCT ON to pick one row per run_id ordered by decided_at DESC.
UPDATE "run_plan_approval_bindings" AS b
SET "is_current_authorization" = true
WHERE "b"."id" IN (
  SELECT "id" FROM (
    SELECT DISTINCT ON ("run_id") "id", "run_id", "decided_at"
    FROM "run_plan_approval_bindings"
    WHERE "decision" = 'approved'
    ORDER BY "run_id", "decided_at" DESC NULLS LAST, "id" DESC
  ) AS latest
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_plan_approval_bindings_run_current" ON "run_plan_approval_bindings" USING btree ("run_id") WHERE "is_current_authorization" = true;
