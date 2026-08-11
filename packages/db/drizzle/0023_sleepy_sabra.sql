CREATE TABLE "artifact_permissions" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"grantee_type" text NOT NULL,
	"grantee_id" text NOT NULL,
	"access_level" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "chk_permissions_resource_type" CHECK ("artifact_permissions"."resource_type" IN ('project', 'folder', 'artifact')),
	CONSTRAINT "chk_permissions_grantee_type" CHECK ("artifact_permissions"."grantee_type" IN ('user', 'team')),
	CONSTRAINT "chk_permissions_access_level" CHECK ("artifact_permissions"."access_level" IN ('view', 'edit', 'manage'))
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"name" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifact_permissions" ADD CONSTRAINT "artifact_permissions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_artifact_permissions_resource" ON "artifact_permissions" USING btree ("company_id","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "idx_artifact_permissions_grantee" ON "artifact_permissions" USING btree ("grantee_type","grantee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_artifact_permissions_resource_grantee" ON "artifact_permissions" USING btree ("company_id","resource_type","resource_id","grantee_type","grantee_id");--> statement-breakpoint
CREATE INDEX "idx_team_members_team" ON "team_members" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "idx_team_members_user" ON "team_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_team_members_team_user" ON "team_members" USING btree ("team_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_teams_company" ON "teams" USING btree ("company_id");