-- Research attempt accounting and nonmutating source availability checks
-- (m5-f12-research-attempt-accounting).
--
-- VAL-RES-064: Research budget preflight — deny before dispatch when the
--   finite ceiling cannot cover the conservative estimate.
-- VAL-RES-065: In-flight budget reservation — combined reserved + settled
--   never exceeds the allocation or root hold.
-- VAL-RES-066: Provider credits settled exactly once — unique external call
--   id prevents duplicate charges on replay/recovery.
-- VAL-RES-067: Fallback attempts separately charged — each physical attempt
--   has its own settlement/request-id hash/credits.
-- VAL-RES-068: Budget exhaustion blocks fallback — no dispatch without a
--   sufficient new in-flight reservation.
-- VAL-RES-069: Unknown price is not free — reserve/charge the configured
--   conservative maximum or reject before dispatch.
-- VAL-RES-070: Unused research budget released — residuals release on
--   completion/failure/cancellation while known charges remain settled.
-- VAL-RES-110: Unknown paid attempts remain budget safe — every physical
--   attempt is recorded prepared|started|succeeded|failed|cancelled|unknown;
--   post-dispatch connection loss preserves unknown and the conservative
--   maximum; retry reserves separately.
-- VAL-RES-119: Source availability refresh is explicit and nonmutating.
-- VAL-RES-120: Pricing snapshots are immutable per attempt.
--
-- Forward-only and additive: two new tables. No changes to existing enums
-- or constraints.

CREATE TABLE "research_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"run_id" text NOT NULL,
	"root_run_id" text NOT NULL,
	"allocation_id" text NOT NULL,
	"logical_call_id" text NOT NULL,
	"attempt_ordinal" integer NOT NULL,
	"provider" text NOT NULL,
	"operation" text NOT NULL,
	"state" text NOT NULL DEFAULT 'prepared',
	"reserved_cents" integer NOT NULL,
	"settled_cents" integer NOT NULL DEFAULT 0,
	"pricing_snapshot_id" text,
	"external_call_id" text,
	"provider_request_id_hash" text,
	"reported_credits" integer NOT NULL DEFAULT 0,
	"failure_code" text,
	"safe_error_message" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"started_at" timestamp (3) with time zone,
	"settled_at" timestamp (3) with time zone,
	"terminal_at" timestamp (3) with time zone,
	CONSTRAINT "chk_research_attempts_reserved_nonneg" CHECK ("research_attempts"."reserved_cents" >= 0),
	CONSTRAINT "chk_research_attempts_settled_nonneg" CHECK ("research_attempts"."settled_cents" >= 0),
	CONSTRAINT "chk_research_attempts_ordinal_positive" CHECK ("research_attempts"."attempt_ordinal" > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_research_attempts_logical_ordinal" ON "research_attempts" USING btree ("logical_call_id","attempt_ordinal");--> statement-breakpoint
CREATE INDEX "idx_research_attempts_run" ON "research_attempts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_research_attempts_allocation" ON "research_attempts" USING btree ("allocation_id");--> statement-breakpoint
CREATE INDEX "idx_research_attempts_logical_call" ON "research_attempts" USING btree ("logical_call_id");--> statement-breakpoint
CREATE INDEX "idx_research_attempts_state" ON "research_attempts" USING btree ("state");--> statement-breakpoint
ALTER TABLE "research_attempts" ADD CONSTRAINT "research_attempts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "research_attempts" ADD CONSTRAINT "research_attempts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "research_attempts" ADD CONSTRAINT "research_attempts_run_id_mission_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "mission_runs"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "research_attempts" ADD CONSTRAINT "research_attempts_allocation_id_budget_allocations_id_fk" FOREIGN KEY ("allocation_id") REFERENCES "budget_allocations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "research_attempts" ADD CONSTRAINT "research_attempts_pricing_snapshot_id_research_pricing_snapshots_id_fk" FOREIGN KEY ("pricing_snapshot_id") REFERENCES "research_pricing_snapshots"("id") ON DELETE set null;--> statement-breakpoint
CREATE TABLE "research_source_availability_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"run_id" text NOT NULL,
	"root_run_id" text NOT NULL,
	"source_revision_id" text NOT NULL,
	"logical_call_id" text NOT NULL,
	"attempt_id" text,
	"checked_url" text NOT NULL,
	"status" text NOT NULL,
	"http_status" integer,
	"warning" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_availability_checks_revision_key" ON "research_source_availability_checks" USING btree ("source_revision_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_availability_checks_run" ON "research_source_availability_checks" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_availability_checks_revision" ON "research_source_availability_checks" USING btree ("source_revision_id");--> statement-breakpoint
ALTER TABLE "research_source_availability_checks" ADD CONSTRAINT "research_source_availability_checks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "research_source_availability_checks" ADD CONSTRAINT "research_source_availability_checks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "research_source_availability_checks" ADD CONSTRAINT "research_source_availability_checks_run_id_mission_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "mission_runs"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "research_source_availability_checks" ADD CONSTRAINT "research_source_availability_checks_source_revision_id_research_source_revisions_id_fk" FOREIGN KEY ("source_revision_id") REFERENCES "research_source_revisions"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "research_source_availability_checks" ADD CONSTRAINT "research_source_availability_checks_attempt_id_research_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "research_attempts"("id") ON DELETE set null;
