ALTER TABLE "messages" ALTER COLUMN "from_agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "to_agent_id" DROP NOT NULL;--> statement-breakpoint
UPDATE "messages" SET "from_agent_id" = NULL WHERE "from_agent_id" = '__board__';--> statement-breakpoint
UPDATE "messages" SET "to_agent_id" = NULL WHERE "to_agent_id" = '__board__';