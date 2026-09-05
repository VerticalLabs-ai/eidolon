CREATE TABLE "budget_settlements" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"root_reservation_id" text NOT NULL,
	"allocation_id" text NOT NULL,
	"run_id" text NOT NULL,
	"billing_agent_id" text,
	"external_call_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"operation" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"credits" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer NOT NULL,
	"provider_request_id_hash" text,
	"trace_id" text,
	"created_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN "budget_settlement_id" text;--> statement-breakpoint
ALTER TABLE "budget_settlements" ADD CONSTRAINT "budget_settlements_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_settlements" ADD CONSTRAINT "budget_settlements_root_reservation_id_budget_reservations_id_fk" FOREIGN KEY ("root_reservation_id") REFERENCES "public"."budget_reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_settlements" ADD CONSTRAINT "budget_settlements_allocation_id_budget_allocations_id_fk" FOREIGN KEY ("allocation_id") REFERENCES "public"."budget_allocations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_settlements" ADD CONSTRAINT "budget_settlements_run_id_mission_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."mission_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_settlements" ADD CONSTRAINT "budget_settlements_billing_agent_id_agents_id_fk" FOREIGN KEY ("billing_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_budget_settlements_external_call" ON "budget_settlements" USING btree ("external_call_id");--> statement-breakpoint
CREATE INDEX "idx_budget_settlements_run" ON "budget_settlements" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_budget_settlements_allocation" ON "budget_settlements" USING btree ("allocation_id");