CREATE TABLE `import_checkpoints` (
	`artifact` text NOT NULL,
	`artifact_hash` text NOT NULL,
	`completed_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`stage` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `import_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_checkpoints_session_stage_idx` ON `import_checkpoints` (`session_id`,`stage`);--> statement-breakpoint
CREATE TABLE `import_reviews` (
	`confirmed_brand_ingredient_ids` text DEFAULT '[]' NOT NULL,
	`draft` text NOT NULL,
	`reviewed_at` text NOT NULL,
	`reviewed_by` text,
	`session_id` text PRIMARY KEY NOT NULL,
	FOREIGN KEY (`reviewed_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`session_id`) REFERENCES `import_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `import_sessions` (
	`created_at` text NOT NULL,
	`current_stage` text,
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text,
	`progress` integer DEFAULT 0 NOT NULL,
	`request_key` text NOT NULL,
	`requested_by` text,
	`resulting_recipe_id` text,
	`source` text NOT NULL,
	`source_kind` text NOT NULL,
	`status` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`requested_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`resulting_recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "import_sessions_status_check" CHECK("import_sessions"."status" IN ('queued','processing','review','completed','failed','cancelled')),
	CONSTRAINT "import_sessions_progress_check" CHECK("import_sessions"."progress" >= 0 AND "import_sessions"."progress" <= 100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_sessions_request_key_unique` ON `import_sessions` (`request_key`);--> statement-breakpoint
CREATE INDEX `import_sessions_requested_idx` ON `import_sessions` (`requested_by`,`updated_at`);--> statement-breakpoint
CREATE INDEX `import_sessions_status_idx` ON `import_sessions` (`status`,`updated_at`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `artifact_refs` text DEFAULT '[]' NOT NULL;