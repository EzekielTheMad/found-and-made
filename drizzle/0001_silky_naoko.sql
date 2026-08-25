CREATE TABLE `recipe_revisions` (
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`recipe_id` text NOT NULL,
	`snapshot` text NOT NULL,
	`version` integer NOT NULL,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recipe_revisions_recipe_idx` ON `recipe_revisions` (`recipe_id`,`version`);--> statement-breakpoint
CREATE TABLE `recipes` (
	`aggregate` text NOT NULL,
	`created_at` text NOT NULL,
	`deleted_at` text,
	`fingerprint` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`source_canonical_url` text,
	`title` text NOT NULL,
	`updated_at` text NOT NULL,
	`variant_of_id` text,
	`version` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `recipes_active_updated_idx` ON `recipes` (`deleted_at`,`updated_at`);--> statement-breakpoint
CREATE INDEX `recipes_fingerprint_idx` ON `recipes` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `recipes_source_idx` ON `recipes` (`source_canonical_url`);--> statement-breakpoint
CREATE INDEX `recipes_variant_idx` ON `recipes` (`variant_of_id`);