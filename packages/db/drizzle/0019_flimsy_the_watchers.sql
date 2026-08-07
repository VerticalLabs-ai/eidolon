ALTER TABLE "messages" ALTER COLUMN "from_agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "to_agent_id" DROP NOT NULL;