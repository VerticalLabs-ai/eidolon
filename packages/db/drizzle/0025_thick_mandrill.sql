CREATE TABLE "local_trusted_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"company_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "step_up_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"company_id" text,
	"scope" text NOT NULL,
	"granted_at" timestamp (3) with time zone NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"revoked_at" timestamp (3) with time zone,
	"consumed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_mfa_factors" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"company_id" text,
	"type" text DEFAULT 'totp' NOT NULL,
	"secret" text NOT NULL,
	"label" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp (3) NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "local_trusted_sessions" ADD CONSTRAINT "local_trusted_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_local_trusted_sessions_company_user" ON "local_trusted_sessions" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_local_trusted_sessions_user" ON "local_trusted_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_step_up_sessions_user_scope" ON "step_up_sessions" USING btree ("user_id","scope","expires_at");--> statement-breakpoint
CREATE INDEX "idx_step_up_sessions_company" ON "step_up_sessions" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "idx_user_mfa_factors_user" ON "user_mfa_factors" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_mfa_factors_user_secret" ON "user_mfa_factors" USING btree ("user_id","secret");