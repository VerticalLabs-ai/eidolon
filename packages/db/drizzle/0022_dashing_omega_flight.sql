CREATE TABLE "artifact_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" "artifact_type" NOT NULL,
	"content" jsonb NOT NULL,
	"content_schema_version" integer DEFAULT 1 NOT NULL,
	"artifact_id" text,
	"created_by_user_id" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_template_clones" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"template_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"project_id" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"project_id" text,
	"snapshot" jsonb NOT NULL,
	"artifact_count" integer DEFAULT 0 NOT NULL,
	"folder_count" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifact_templates" ADD CONSTRAINT "artifact_templates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_templates" ADD CONSTRAINT "artifact_templates_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_template_clones" ADD CONSTRAINT "project_template_clones_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_template_clones" ADD CONSTRAINT "project_template_clones_template_id_project_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."project_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_template_clones" ADD CONSTRAINT "project_template_clones_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_templates" ADD CONSTRAINT "project_templates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_templates" ADD CONSTRAINT "project_templates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_artifact_templates_company" ON "artifact_templates" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "idx_artifact_templates_company_type" ON "artifact_templates" USING btree ("company_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_template_clones_company_template_key" ON "project_template_clones" USING btree ("company_id","template_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_project_templates_company" ON "project_templates" USING btree ("company_id");