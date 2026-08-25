CREATE TABLE `print_collections` (
	`created_at` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`global_layout` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`numbering_mode` text DEFAULT 'modular' NOT NULL,
	`outline` text DEFAULT '[]' NOT NULL,
	`profile_id` text,
	`updated_at` text NOT NULL,
	`user_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `print_profiles`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "print_collections_layout_check" CHECK("print_collections"."global_layout" IN ('classic-single-column','classic-two-column','step-linked','landscape-merge-grid','compact-card')),
	CONSTRAINT "print_collections_numbering_check" CHECK("print_collections"."numbering_mode" IN ('modular','fixed')),
	CONSTRAINT "print_collections_version_check" CHECK("print_collections"."version" >= 1)
);
--> statement-breakpoint
CREATE INDEX `print_collections_user_name_idx` ON `print_collections` (`user_id`,`name`);--> statement-breakpoint
CREATE TABLE `print_jobs` (
	`artifact_checksum` text,
	`artifact_mime_type` text,
	`artifact_page_count` integer,
	`artifact_relative_path` text,
	`artifact_size_bytes` integer,
	`collection_id` text,
	`created_at` text NOT NULL,
	`error_code` text,
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`profile_id` text,
	`request` text NOT NULL,
	`request_hash` text NOT NULL,
	`status` text NOT NULL,
	`updated_at` text NOT NULL,
	`user_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `print_collections`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`profile_id`) REFERENCES `print_profiles`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "print_jobs_status_check" CHECK("print_jobs"."status" IN ('queued','rendering','completed','failed')),
	CONSTRAINT "print_jobs_page_count_check" CHECK("print_jobs"."artifact_page_count" IS NULL OR "print_jobs"."artifact_page_count" > 0),
	CONSTRAINT "print_jobs_size_check" CHECK("print_jobs"."artifact_size_bytes" IS NULL OR "print_jobs"."artifact_size_bytes" > 0),
	CONSTRAINT "print_jobs_version_check" CHECK("print_jobs"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `print_jobs_user_idempotency_idx` ON `print_jobs` (`user_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `print_jobs_user_created_idx` ON `print_jobs` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `print_jobs_status_created_idx` ON `print_jobs` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `print_profiles` (
	`config` text NOT NULL,
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`updated_at` text NOT NULL,
	`user_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "print_profiles_version_check" CHECK("print_profiles"."version" >= 1)
);
--> statement-breakpoint
CREATE INDEX `print_profiles_user_name_idx` ON `print_profiles` (`user_id`,`name`);