CREATE TABLE "agent_api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"agent_id" text,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"last_used_at" timestamp (3),
	"expires_at" timestamp (3),
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp (3) NOT NULL,
	"updated_at" timestamp (3) NOT NULL,
	"revoked_at" timestamp (3)
);
--> statement-breakpoint
CREATE TABLE "company_invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"invited_by_user_id" text NOT NULL,
	"accepted_by_user_id" text,
	"accepted_at" timestamp (3),
	"expires_at" timestamp (3) NOT NULL,
	"created_at" timestamp (3) NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_members" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp (3) NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_api_keys" ADD CONSTRAINT "agent_api_keys_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_api_keys" ADD CONSTRAINT "agent_api_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_invitations" ADD CONSTRAINT "company_invitations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_members" ADD CONSTRAINT "company_members_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_api_keys_hash" ON "agent_api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "idx_agent_api_keys_company_active" ON "agent_api_keys" USING btree ("company_id") WHERE "agent_api_keys"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_company_invitations_pending_company_email" ON "company_invitations" USING btree ("company_id","email") WHERE "company_invitations"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "idx_company_invitations_pending_email" ON "company_invitations" USING btree ("email") WHERE "company_invitations"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_company_members_company_user" ON "company_members" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_company_members_user" ON "company_members" USING btree ("user_id");