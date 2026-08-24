-- Normalized research source identity, immutable source revisions, run-to-
-- revision join, citations, and artifact provenance
-- (m5-f05-source-normalization-citations).
--
-- VAL-RES-019: canonical URL deduplication. research_sources is unique on
--   (company_id, canonical_url_hash).
-- VAL-RES-020: content-hash deduplication. research_source_revisions reuses
--   an existing immutable revision for unchanged content.
-- VAL-RES-021: changed content produces a new immutable revision.
-- VAL-RES-022: tenant-local deduplication — dedup is keyed by company_id;
--   no cross-company deduplication.
-- VAL-RES-098: source metadata is normalized and bounded (enforced in the
--   service layer before persistence).
-- VAL-RES-112: source normalization is versioned (normalization_version)
--   and deterministic (SHA-256 hashes over normalized UTF-8 bytes).
-- VAL-RES-097: citations bind to exact immutable source/artifact revisions;
--   repeated quotes require an unambiguous locator.
-- VAL-RES-113: historical provenance freezes display metadata at citation
--   creation time.
-- VAL-CROSS-034: the source API is bounded — routes expose only summaries,
--   never full untrusted content.
--
-- Forward-only and additive: five new tables. No changes to existing enums
-- or constraints. Content and display-metadata columns are encrypted at rest
-- by the service layer (VAL-RES-107); hashes, IDs, counts, ordinals,
-- offsets, statuses, timestamps, and the canonical URL remain plaintext.

CREATE TABLE "research_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"canonical_url" text NOT NULL,
	"canonical_url_hash" text NOT NULL,
	"origin_domain" text NOT NULL,
	"title_encrypted" text,
	"author_encrypted" text,
	"published_at_encrypted" text,
	"language_encrypted" text,
	"first_seen_at" timestamp (3) with time zone NOT NULL,
	"last_seen_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_research_sources_company_url_hash" ON "research_sources" USING btree ("company_id", "canonical_url_hash");
--> statement-breakpoint
CREATE INDEX "idx_research_sources_company_domain" ON "research_sources" USING btree ("company_id", "origin_domain");
--> statement-breakpoint
ALTER TABLE "research_sources" ADD CONSTRAINT "chk_research_sources_url_hash_hex" CHECK (length("canonical_url_hash") = 64);
--> statement-breakpoint
ALTER TABLE "research_sources" ADD CONSTRAINT "research_sources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE TABLE "research_source_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"source_id" text NOT NULL,
	"run_id" text NOT NULL,
	"root_run_id" text NOT NULL,
	"logical_call_id" text NOT NULL,
	"provider" text NOT NULL,
	"operation" text NOT NULL,
	"provider_request_id_hash" text,
	"retrieved_at" timestamp (3) with time zone NOT NULL,
	"normalization_version" integer NOT NULL,
	"content_hash" text,
	"normalized_text_encrypted" text,
	"excerpt_encrypted" text,
	"byte_count" integer NOT NULL DEFAULT 0,
	"mime_type_encrypted" text,
	"title_encrypted" text,
	"author_encrypted" text,
	"published_at_encrypted" text,
	"language_encrypted" text,
	"http_status" integer,
	"injection_risk_labels" jsonb NOT NULL DEFAULT '[]',
	"warnings" jsonb NOT NULL DEFAULT '[]',
	"status" text NOT NULL DEFAULT 'available',
	"created_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_research_source_revisions_source_hash" ON "research_source_revisions" USING btree ("source_id", "content_hash") WHERE "content_hash" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "idx_research_source_revisions_run" ON "research_source_revisions" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "idx_research_source_revisions_source" ON "research_source_revisions" USING btree ("source_id");
--> statement-breakpoint
CREATE INDEX "idx_research_source_revisions_company_project" ON "research_source_revisions" USING btree ("company_id", "project_id");
--> statement-breakpoint
ALTER TABLE "research_source_revisions" ADD CONSTRAINT "chk_research_source_revisions_version_positive" CHECK ("normalization_version" > 0);
--> statement-breakpoint
ALTER TABLE "research_source_revisions" ADD CONSTRAINT "chk_research_source_revisions_byte_count_nonneg" CHECK ("byte_count" >= 0);
--> statement-breakpoint
ALTER TABLE "research_source_revisions" ADD CONSTRAINT "research_source_revisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "research_source_revisions" ADD CONSTRAINT "research_source_revisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "research_source_revisions" ADD CONSTRAINT "research_source_revisions_source_id_research_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "research_sources"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "research_source_revisions" ADD CONSTRAINT "research_source_revisions_run_id_mission_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "mission_runs"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE TABLE "run_research_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"run_id" text NOT NULL,
	"root_run_id" text NOT NULL,
	"logical_call_id" text NOT NULL,
	"source_revision_id" text NOT NULL,
	"rank" integer,
	"relevance_score" real,
	"query_hash" text,
	"selected" boolean NOT NULL DEFAULT true,
	"excluded" boolean NOT NULL DEFAULT false,
	"exclusion_reason" text,
	"created_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_research_sources_run_revision" ON "run_research_sources" USING btree ("run_id", "source_revision_id");
--> statement-breakpoint
CREATE INDEX "idx_run_research_sources_run" ON "run_research_sources" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "idx_run_research_sources_logical_call" ON "run_research_sources" USING btree ("logical_call_id");
--> statement-breakpoint
ALTER TABLE "run_research_sources" ADD CONSTRAINT "run_research_sources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "run_research_sources" ADD CONSTRAINT "run_research_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "run_research_sources" ADD CONSTRAINT "run_research_sources_run_id_mission_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "mission_runs"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "run_research_sources" ADD CONSTRAINT "run_research_sources_source_revision_id_research_source_revisions_id_fk" FOREIGN KEY ("source_revision_id") REFERENCES "research_source_revisions"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE TABLE "citations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"run_id" text NOT NULL,
	"source_revision_id" text NOT NULL,
	"artifact_id" text NOT NULL,
	"artifact_revision_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"quote_exact_encrypted" text NOT NULL,
	"quote_prefix_encrypted" text,
	"quote_suffix_encrypted" text,
	"quote_hash" text NOT NULL,
	"char_start" integer,
	"char_end" integer,
	"section" text,
	"frozen_title_encrypted" text,
	"frozen_author_encrypted" text,
	"frozen_canonical_url" text NOT NULL,
	"frozen_retrieved_at" timestamp (3) with time zone NOT NULL,
	"frozen_provider" text NOT NULL,
	"frozen_content_hash" text,
	"artifact_locator" jsonb,
	"created_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_citations_artifact_revision_ordinal" ON "citations" USING btree ("artifact_revision_id", "ordinal");
--> statement-breakpoint
CREATE INDEX "idx_citations_source_revision" ON "citations" USING btree ("source_revision_id");
--> statement-breakpoint
CREATE INDEX "idx_citations_run" ON "citations" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "idx_citations_company_project" ON "citations" USING btree ("company_id", "project_id");
--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "chk_citations_ordinal_nonneg" CHECK ("ordinal" >= 0);
--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "chk_citations_quote_hash_hex" CHECK (length("quote_hash") = 64);
--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_run_id_mission_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "mission_runs"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_source_revision_id_research_source_revisions_id_fk" FOREIGN KEY ("source_revision_id") REFERENCES "research_source_revisions"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_artifact_revision_id_artifact_revisions_id_fk" FOREIGN KEY ("artifact_revision_id") REFERENCES "artifact_revisions"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE TABLE "artifact_provenance" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"run_id" text NOT NULL,
	"root_run_id" text NOT NULL,
	"artifact_id" text NOT NULL,
	"artifact_revision_id" text NOT NULL,
	"approved_plan_revision_id" text,
	"approved_plan_hash" text,
	"policy_hash" text,
	"producing_step_key" text,
	"producing_child_run_id" text,
	"generation_time" timestamp (3) with time zone NOT NULL,
	"cited_source_revision_ids" jsonb NOT NULL DEFAULT '[]',
	"created_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_artifact_provenance_revision" ON "artifact_provenance" USING btree ("artifact_revision_id");
--> statement-breakpoint
CREATE INDEX "idx_artifact_provenance_run" ON "artifact_provenance" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "idx_artifact_provenance_company_project" ON "artifact_provenance" USING btree ("company_id", "project_id");
--> statement-breakpoint
ALTER TABLE "artifact_provenance" ADD CONSTRAINT "artifact_provenance_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "artifact_provenance" ADD CONSTRAINT "artifact_provenance_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "artifact_provenance" ADD CONSTRAINT "artifact_provenance_run_id_mission_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "mission_runs"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "artifact_provenance" ADD CONSTRAINT "artifact_provenance_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "artifact_provenance" ADD CONSTRAINT "artifact_provenance_artifact_revision_id_artifact_revisions_id_fk" FOREIGN KEY ("artifact_revision_id") REFERENCES "artifact_revisions"("id") ON DELETE CASCADE;
