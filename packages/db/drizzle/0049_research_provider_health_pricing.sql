-- Persistent research provider circuit-breaker health and immutable pricing
-- snapshots (m5-f03-provider-health-pricing).
--
-- VAL-RES-013: Circuit state is Postgres-backed so worker restart does not
-- erase health. One row per (provider, operation) with closed/open/half_open
-- state, consecutive provider-wide failures, open-until deadline, and a
-- latency aggregate.
-- VAL-RES-014: One half-open probe claimed via row lock with a 30-second
-- fenced lease. Crash/cancellation releases or expires it.
-- VAL-RES-015 / VAL-RES-109: Health rows hold ONLY bounded
-- provider/operation/status/latency data. No tenant query, URL, source text,
-- user ID, company ID, run ID, or credential. Only provider-wide transport,
-- 5xx, and malformed-service failures increment the global threshold.
-- VAL-RES-120: Pricing snapshots are immutable per attempt; settlements
-- recompute from the snapshot, not current prices.
--
-- Forward-only and additive: two new tables. No changes to existing enums
-- or constraints.

CREATE TABLE "research_provider_health" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"operation" text NOT NULL,
	"state" text NOT NULL DEFAULT 'closed',
	"consecutive_failures" integer NOT NULL DEFAULT 0,
	"open_until_ms" integer NOT NULL DEFAULT 0,
	"last_success_at" timestamp (3) with time zone,
	"last_failure_at" timestamp (3) with time zone,
	"latency_count" integer NOT NULL DEFAULT 0,
	"latency_sum_ms" integer NOT NULL DEFAULT 0,
	"half_open_probe_owner" text,
	"half_open_probe_lease_expires_ms" integer NOT NULL DEFAULT 0,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_research_provider_health_provider_operation" ON "research_provider_health" USING btree ("provider", "operation");
--> statement-breakpoint
CREATE INDEX "idx_research_provider_health_state" ON "research_provider_health" USING btree ("state");
--> statement-breakpoint
CREATE TABLE "research_pricing_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"operation" text NOT NULL,
	"pricing_table_version" text NOT NULL,
	"currency" text NOT NULL DEFAULT 'USD',
	"unit_definition" jsonb NOT NULL,
	"rounding_rule" text NOT NULL DEFAULT 'round_half_up',
	"conservative_unknown_price_cents" integer NOT NULL,
	"reported_credits" integer NOT NULL DEFAULT 0,
	"resulting_cents" integer NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_research_pricing_snapshots_id" ON "research_pricing_snapshots" USING btree ("id");
--> statement-breakpoint
CREATE INDEX "idx_research_pricing_snapshots_provider_operation" ON "research_pricing_snapshots" USING btree ("provider", "operation");
--> statement-breakpoint
CREATE INDEX "idx_research_pricing_snapshots_hash" ON "research_pricing_snapshots" USING btree ("content_hash");
