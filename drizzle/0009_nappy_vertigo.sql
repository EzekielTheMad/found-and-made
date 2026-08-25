CREATE TABLE `mcp_rate_windows` (
	`request_count` integer DEFAULT 0 NOT NULL,
	`token_id` text PRIMARY KEY NOT NULL,
	`window_started_at` text NOT NULL,
	FOREIGN KEY (`token_id`) REFERENCES `mcp_tokens`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mcp_recipe_approvals` (
	`approved_at` text NOT NULL,
	`approved_by` text NOT NULL,
	`recipe_id` text PRIMARY KEY NOT NULL,
	FOREIGN KEY (`approved_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mcp_tokens` (
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`expires_at` text,
	`id` text PRIMARY KEY NOT NULL,
	`last_used_at` text,
	`name` text NOT NULL,
	`revoked_at` text,
	`scopes` text NOT NULL,
	`token_hash` text NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_tokens_token_hash_unique` ON `mcp_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `mcp_tokens_expiry_idx` ON `mcp_tokens` (`expires_at`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `mcp_use_records` (
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`outcome` text NOT NULL,
	`result_count` integer DEFAULT 0 NOT NULL,
	`token_id` text,
	`tool` text NOT NULL,
	FOREIGN KEY (`token_id`) REFERENCES `mcp_tokens`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "mcp_use_records_outcome_check" CHECK("mcp_use_records"."outcome" IN ('success','denied','rate_limited','error'))
);
--> statement-breakpoint
CREATE INDEX `mcp_use_records_token_created_idx` ON `mcp_use_records` (`token_id`,`created_at`);