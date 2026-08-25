CREATE TABLE `media_assets` (
	`alt_text` text NOT NULL,
	`caption` text NOT NULL,
	`checksum` text NOT NULL,
	`component_id` text,
	`created_at` text NOT NULL,
	`focal_x` integer DEFAULT 50 NOT NULL,
	`focal_y` integer DEFAULT 50 NOT NULL,
	`height` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`original_path` text NOT NULL,
	`position` integer NOT NULL,
	`recipe_id` text NOT NULL,
	`role` text NOT NULL,
	`social_path` text NOT NULL,
	`step_id` text,
	`updated_at` text NOT NULL,
	`web_path` text NOT NULL,
	`width` integer NOT NULL,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "media_assets_role_check" CHECK("media_assets"."role" IN ('hero','gallery','component','step'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_assets_original_path_unique` ON `media_assets` (`original_path`);--> statement-breakpoint
CREATE UNIQUE INDEX `media_assets_social_path_unique` ON `media_assets` (`social_path`);--> statement-breakpoint
CREATE UNIQUE INDEX `media_assets_web_path_unique` ON `media_assets` (`web_path`);--> statement-breakpoint
CREATE INDEX `media_assets_recipe_idx` ON `media_assets` (`recipe_id`,`position`);