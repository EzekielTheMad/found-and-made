CREATE TABLE `cooking_history` (
	`adjustment_id` text,
	`cooked_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`recipe_id` text NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`adjustment_id`) REFERENCES `personal_adjustments`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `cooking_history_user_cooked_idx` ON `cooking_history` (`user_id`,`cooked_at`);--> statement-breakpoint
CREATE INDEX `cooking_history_user_recipe_idx` ON `cooking_history` (`user_id`,`recipe_id`,`cooked_at`);--> statement-breakpoint
CREATE TABLE `cooking_sessions` (
	`checked_ingredient_ids` text DEFAULT '[]' NOT NULL,
	`completed_at` text,
	`created_at` text NOT NULL,
	`guided_step_index` integer DEFAULT 0 NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`recipe_id` text NOT NULL,
	`status` text NOT NULL,
	`target_servings` real NOT NULL,
	`timers` text DEFAULT '[]' NOT NULL,
	`updated_at` text NOT NULL,
	`user_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "cooking_sessions_status_check" CHECK("cooking_sessions"."status" IN ('active','completed','abandoned')),
	CONSTRAINT "cooking_sessions_target_servings_check" CHECK("cooking_sessions"."target_servings" > 0),
	CONSTRAINT "cooking_sessions_guided_step_check" CHECK("cooking_sessions"."guided_step_index" >= 0),
	CONSTRAINT "cooking_sessions_version_check" CHECK("cooking_sessions"."version" >= 1)
);
--> statement-breakpoint
CREATE INDEX `cooking_sessions_user_updated_idx` ON `cooking_sessions` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `cooking_sessions_user_recipe_idx` ON `cooking_sessions` (`user_id`,`recipe_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `personal_adjustments` (
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`note` text NOT NULL,
	`recipe_id` text NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `personal_adjustments_user_recipe_idx` ON `personal_adjustments` (`user_id`,`recipe_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `personal_recipe_states` (
	`cooked_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`favorite` integer DEFAULT false NOT NULL,
	`last_cooked_at` text,
	`last_viewed_at` text,
	`note` text DEFAULT '' NOT NULL,
	`rating` integer,
	`recipe_id` text NOT NULL,
	`updated_at` text NOT NULL,
	`user_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`user_id`, `recipe_id`),
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "personal_recipe_states_rating_check" CHECK("personal_recipe_states"."rating" IS NULL OR ("personal_recipe_states"."rating" >= 1 AND "personal_recipe_states"."rating" <= 5)),
	CONSTRAINT "personal_recipe_states_cooked_count_check" CHECK("personal_recipe_states"."cooked_count" >= 0),
	CONSTRAINT "personal_recipe_states_version_check" CHECK("personal_recipe_states"."version" >= 1)
);
--> statement-breakpoint
CREATE INDEX `personal_recipe_states_favorite_idx` ON `personal_recipe_states` (`user_id`,`favorite`,`updated_at`);--> statement-breakpoint
CREATE INDEX `personal_recipe_states_viewed_idx` ON `personal_recipe_states` (`user_id`,`last_viewed_at`);--> statement-breakpoint
CREATE INDEX `personal_recipe_states_cooked_idx` ON `personal_recipe_states` (`user_id`,`last_cooked_at`);--> statement-breakpoint
CREATE TABLE `personal_state_operations` (
	`applied_at` text NOT NULL,
	`client_operation_id` text NOT NULL,
	`operation_hash` text NOT NULL,
	`recipe_id` text NOT NULL,
	`result` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`user_id`, `client_operation_id`),
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `personal_state_operations_applied_idx` ON `personal_state_operations` (`user_id`,`applied_at`);