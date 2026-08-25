ALTER TABLE `recipe_publications` ADD `rights_attested_at` text;--> statement-breakpoint
ALTER TABLE `recipe_publications` ADD `rights_attested_by` text REFERENCES user(id);--> statement-breakpoint
UPDATE `recipe_publications`
SET `status` = 'review',
    `published_by` = NULL,
    `published_at` = NULL,
    `review_requested_by` = NULL,
    `review_requested_at` = NULL,
    `updated_at` = CURRENT_TIMESTAMP
WHERE `status` = 'published';
