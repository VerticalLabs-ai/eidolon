CREATE TABLE `inbox_read_states` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`company_id` text NOT NULL,
	`item_id` text NOT NULL,
	`read_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_inbox_read_states_user_company_item` ON `inbox_read_states` (`user_id`,`company_id`,`item_id`);--> statement-breakpoint
CREATE INDEX `idx_inbox_read_states_user_company` ON `inbox_read_states` (`user_id`,`company_id`);