PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_import_sessions` (
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
	CONSTRAINT "import_sessions_status_check" CHECK("__new_import_sessions"."status" IN ('queued','processing','review','completed','failed','cancelled','skipped')),
	CONSTRAINT "import_sessions_progress_check" CHECK("__new_import_sessions"."progress" >= 0 AND "__new_import_sessions"."progress" <= 100)
);
--> statement-breakpoint
INSERT INTO `__new_import_sessions`("created_at", "current_stage", "id", "job_id", "progress", "request_key", "requested_by", "resulting_recipe_id", "source", "source_kind", "status", "updated_at") SELECT "created_at", "current_stage", "id", "job_id", "progress", "request_key", "requested_by", "resulting_recipe_id", "source", "source_kind", "status", "updated_at" FROM `import_sessions`;--> statement-breakpoint
DROP TABLE `import_sessions`;--> statement-breakpoint
ALTER TABLE `__new_import_sessions` RENAME TO `import_sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `import_sessions_request_key_unique` ON `import_sessions` (`request_key`);--> statement-breakpoint
CREATE INDEX `import_sessions_requested_idx` ON `import_sessions` (`requested_by`,`updated_at`);--> statement-breakpoint
CREATE INDEX `import_sessions_status_idx` ON `import_sessions` (`status`,`updated_at`);