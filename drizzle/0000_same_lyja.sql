CREATE TABLE `jobs` (
	`attempts` integer DEFAULT 0 NOT NULL,
	`available_at` text NOT NULL,
	`created_at` text NOT NULL,
	`error_code` text,
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`lease_expires_at` text,
	`lease_owner` text,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`payload` text NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`type` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_idempotency_key_unique` ON `jobs` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `jobs_claim_idx` ON `jobs` (`status`,`available_at`,`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `system_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`updated_at` text NOT NULL,
	`value` text NOT NULL
);
