-- Create mode_profiles table for company-defined custom Mission mode profiles.
-- Forward-only and additive; new table with no changes to existing tables.
-- Built-in modes are code-owned constants, not editable rows. Custom profiles
-- may only narrow company/platform policy. Administration is versioned,
-- authorized (company.settings.update), and attributable. Deletion is not a
-- Phase 1 operation; disabled (enabled=false) is the sole unavailable lifecycle.
CREATE TABLE "mode_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"enabled" boolean NOT NULL DEFAULT true,
	"config" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"version" integer NOT NULL DEFAULT 1,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_mode_profiles_company_slug" ON "mode_profiles" USING btree ("company_id", "slug");
--> statement-breakpoint
CREATE INDEX "idx_mode_profiles_company_enabled" ON "mode_profiles" USING btree ("company_id", "enabled");
--> statement-breakpoint
ALTER TABLE "mode_profiles" ADD CONSTRAINT "mode_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Add FK from mission_runs.mode_profile_id to mode_profiles (nullable;
-- only set when a custom profile is selected). Same-company enforcement is
-- handled at the application layer; the FK is within the same tablespace.
ALTER TABLE "mission_runs" ADD CONSTRAINT "mission_runs_mode_profile_id_mode_profiles_id_fk" FOREIGN KEY ("mode_profile_id") REFERENCES "mode_profiles" ("id") ON DELETE set null ON UPDATE no action;
