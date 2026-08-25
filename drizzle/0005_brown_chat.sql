CREATE TABLE `user_default_views` (
	`saved_view_id` text,
	`updated_at` text NOT NULL,
	`user_id` text PRIMARY KEY NOT NULL,
	FOREIGN KEY (`saved_view_id`) REFERENCES `saved_views`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
