CREATE TABLE "test_users" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "test_users" ADD CONSTRAINT "test_users_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_test_users_company" ON "test_users" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_test_users_company_email" ON "test_users" USING btree ("company_id","email");