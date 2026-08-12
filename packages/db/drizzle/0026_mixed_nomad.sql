ALTER TABLE "artifacts" ADD COLUMN "search_text" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "search_tsv" "tsvector";--> statement-breakpoint
CREATE INDEX "idx_artifacts_search_tsv" ON "artifacts" USING gin ("search_tsv");