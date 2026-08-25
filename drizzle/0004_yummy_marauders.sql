CREATE TABLE `collection_recipes` (
	`collection_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`recipe_id` text NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `collection_recipes_collection_position_idx` ON `collection_recipes` (`collection_id`,`position`);--> statement-breakpoint
CREATE INDEX `collection_recipes_recipe_idx` ON `collection_recipes` (`recipe_id`);--> statement-breakpoint
CREATE TABLE `collections` (
	`created_at` text NOT NULL,
	`description` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`title` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `collections_position_idx` ON `collections` (`position`);--> statement-breakpoint
CREATE TABLE `facet_groups` (
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`slug` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `facet_groups_slug_unique` ON `facet_groups` (`slug`);--> statement-breakpoint
CREATE INDEX `facet_groups_position_idx` ON `facet_groups` (`position`);--> statement-breakpoint
CREATE TABLE `facet_term_aliases` (
	`alias` text NOT NULL,
	`term_id` text NOT NULL,
	FOREIGN KEY (`term_id`) REFERENCES `facet_terms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `facet_term_aliases_alias_idx` ON `facet_term_aliases` (`alias`);--> statement-breakpoint
CREATE INDEX `facet_term_aliases_term_idx` ON `facet_term_aliases` (`term_id`);--> statement-breakpoint
CREATE TABLE `facet_terms` (
	`created_at` text NOT NULL,
	`group_id` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`parent_id` text,
	`position` integer DEFAULT 0 NOT NULL,
	`slug` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `facet_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `facet_terms`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `facet_terms_group_parent_idx` ON `facet_terms` (`group_id`,`parent_id`);--> statement-breakpoint
CREATE INDEX `facet_terms_group_slug_idx` ON `facet_terms` (`group_id`,`slug`);--> statement-breakpoint
CREATE TABLE `home_sections` (
	`config` text NOT NULL,
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`position` integer NOT NULL,
	`title` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `home_sections_position_idx` ON `home_sections` (`position`);--> statement-breakpoint
CREATE TABLE `labels` (
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `labels_normalized_name_unique` ON `labels` (`normalized_name`);--> statement-breakpoint
CREATE TABLE `recipe_labels` (
	`label_id` text NOT NULL,
	`recipe_id` text NOT NULL,
	FOREIGN KEY (`label_id`) REFERENCES `labels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recipe_labels_label_recipe_idx` ON `recipe_labels` (`label_id`,`recipe_id`);--> statement-breakpoint
CREATE INDEX `recipe_labels_recipe_label_idx` ON `recipe_labels` (`recipe_id`,`label_id`);--> statement-breakpoint
CREATE TABLE `recipe_terms` (
	`recipe_id` text NOT NULL,
	`term_id` text NOT NULL,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`term_id`) REFERENCES `facet_terms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recipe_terms_term_recipe_idx` ON `recipe_terms` (`term_id`,`recipe_id`);--> statement-breakpoint
CREATE INDEX `recipe_terms_recipe_term_idx` ON `recipe_terms` (`recipe_id`,`term_id`);--> statement-breakpoint
CREATE TABLE `saved_views` (
	`created_at` text NOT NULL,
	`criteria` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`is_starter` integer DEFAULT false NOT NULL,
	`layout` text NOT NULL,
	`name` text NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`sort` text NOT NULL,
	`updated_at` text NOT NULL,
	`user_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `saved_views_user_idx` ON `saved_views` (`user_id`,`name`);
--> statement-breakpoint
CREATE VIRTUAL TABLE `recipe_search` USING fts5(
	`recipe_id` UNINDEXED,
	`title`,
	`body`,
	tokenize = 'unicode61 remove_diacritics 2'
);
--> statement-breakpoint
INSERT INTO `recipe_search` (`recipe_id`, `title`, `body`)
SELECT `id`, `title`, `aggregate` FROM `recipes` WHERE `deleted_at` IS NULL;
--> statement-breakpoint
CREATE TRIGGER `recipes_search_insert` AFTER INSERT ON `recipes` WHEN NEW.`deleted_at` IS NULL BEGIN
	INSERT INTO `recipe_search` (`recipe_id`, `title`, `body`)
	VALUES (NEW.`id`, NEW.`title`, NEW.`aggregate`);
END;
--> statement-breakpoint
CREATE TRIGGER `recipes_search_update` AFTER UPDATE OF `title`, `aggregate`, `deleted_at` ON `recipes` BEGIN
	DELETE FROM `recipe_search` WHERE `recipe_id` = OLD.`id`;
	INSERT INTO `recipe_search` (`recipe_id`, `title`, `body`)
	SELECT NEW.`id`, NEW.`title`, NEW.`aggregate` WHERE NEW.`deleted_at` IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `recipes_search_delete` AFTER DELETE ON `recipes` BEGIN
	DELETE FROM `recipe_search` WHERE `recipe_id` = OLD.`id`;
END;
