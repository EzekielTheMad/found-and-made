CREATE TABLE `collection_publications` (
	`collection_id` text PRIMARY KEY NOT NULL,
	`published_at` text NOT NULL,
	`published_by` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`published_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `collection_publications_published_idx` ON `collection_publications` (`published_at`);