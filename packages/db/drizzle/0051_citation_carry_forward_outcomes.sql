-- Citation carry-forward outcomes: verified carry-forward tracking
-- (m5-f07-provenance-revision-restoration)
--
-- VAL-RES-034: Revision-aware carried citation. A later artifact edit either
--   preserves a citation at a verified-unchanged locator (writing a new
--   revision-bound citation row) or marks it not-carried-forward.
-- VAL-RES-099: Restoring a cited revision creates verified citation rows.
-- VAL-CROSS-042: Edited artifacts do not float citations — citations never
--   silently move to a newer artifact revision.
--
-- Each outcome row records what happened to a previous revision's citation
-- when a new artifact revision was created (edit or restoration):
--   - 'carried_forward': the locator verified, a new citation row was
--     written bound to the new revision, new_citation_id points at it.
--   - 'not_carried_forward': the locator did not verify; the original
--     citation remains historical, bound to its original revision.
--
-- Forward-only and additive: one new table + one new enum. No changes to
-- existing tables, enums, or constraints.

CREATE TYPE "public"."carry_forward_outcome" AS ENUM('carried_forward', 'not_carried_forward');--> statement-breakpoint
CREATE TABLE "citation_carry_forward_outcomes" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"run_id" text NOT NULL,
	"previous_citation_id" text NOT NULL,
	"new_artifact_revision_id" text NOT NULL,
	"new_citation_id" text,
	"outcome" "carry_forward_outcome" NOT NULL,
	"reason" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "chk_carry_forward_outcome_new_citation" CHECK (("citation_carry_forward_outcomes"."outcome" = 'carried_forward' AND "citation_carry_forward_outcomes"."new_citation_id" IS NOT NULL) OR ("citation_carry_forward_outcomes"."outcome" = 'not_carried_forward'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_carry_forward_prev_new" ON "citation_carry_forward_outcomes" USING btree ("previous_citation_id","new_artifact_revision_id");--> statement-breakpoint
CREATE INDEX "idx_carry_forward_new_revision" ON "citation_carry_forward_outcomes" USING btree ("new_artifact_revision_id");--> statement-breakpoint
CREATE INDEX "idx_carry_forward_run" ON "citation_carry_forward_outcomes" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_carry_forward_company_project" ON "citation_carry_forward_outcomes" USING btree ("company_id","project_id");--> statement-breakpoint
ALTER TABLE "citation_carry_forward_outcomes" ADD CONSTRAINT "citation_carry_forward_outcomes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "citation_carry_forward_outcomes" ADD CONSTRAINT "citation_carry_forward_outcomes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "citation_carry_forward_outcomes" ADD CONSTRAINT "citation_carry_forward_outcomes_run_id_mission_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "mission_runs"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "citation_carry_forward_outcomes" ADD CONSTRAINT "citation_carry_forward_outcomes_previous_citation_id_citations_id_fk" FOREIGN KEY ("previous_citation_id") REFERENCES "citations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "citation_carry_forward_outcomes" ADD CONSTRAINT "citation_carry_forward_outcomes_new_artifact_revision_id_artifact_revisions_id_fk" FOREIGN KEY ("new_artifact_revision_id") REFERENCES "artifact_revisions"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "citation_carry_forward_outcomes" ADD CONSTRAINT "citation_carry_forward_outcomes_new_citation_id_citations_id_fk" FOREIGN KEY ("new_citation_id") REFERENCES "citations"("id") ON DELETE set null;
