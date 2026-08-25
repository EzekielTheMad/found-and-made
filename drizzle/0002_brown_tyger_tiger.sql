CREATE TABLE `app_users` (
	`created_at` text NOT NULL,
	`role` text NOT NULL,
	`updated_at` text NOT NULL,
	`user_id` text PRIMARY KEY NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "app_users_role_check" CHECK("app_users"."role" IN ('owner','editor','viewer'))
);
--> statement-breakpoint
CREATE TABLE `audit_events` (
	`action` text NOT NULL,
	`actor_id` text,
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`metadata` text NOT NULL,
	`subject_id` text
);
--> statement-breakpoint
CREATE INDEX `audit_events_created_idx` ON `audit_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `account` (
	`accessToken` text,
	`accessTokenExpiresAt` date,
	`accountId` text NOT NULL,
	`createdAt` date NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`idToken` text,
	`password` text,
	`providerId` text NOT NULL,
	`refreshToken` text,
	`refreshTokenExpiresAt` date,
	`scope` text,
	`updatedAt` date NOT NULL,
	`userId` text NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`userId`);--> statement-breakpoint
CREATE TABLE `session` (
	`createdAt` date NOT NULL,
	`expiresAt` date NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`ipAddress` text,
	`token` text NOT NULL,
	`updatedAt` date NOT NULL,
	`userAgent` text,
	`userId` text NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`userId`);--> statement-breakpoint
CREATE TABLE `user` (
	`createdAt` date NOT NULL,
	`email` text NOT NULL,
	`emailVerified` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`image` text,
	`name` text NOT NULL,
	`updatedAt` date NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`createdAt` date NOT NULL,
	`expiresAt` date NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`updatedAt` date NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `invitations` (
	`consumed_at` text,
	`created_at` text NOT NULL,
	`email` text NOT NULL,
	`expires_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`invited_by` text NOT NULL,
	`role` text NOT NULL,
	`token_hash` text NOT NULL,
	FOREIGN KEY (`invited_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "invitations_role_check" CHECK("invitations"."role" IN ('editor','viewer'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invitations_token_hash_unique` ON `invitations` (`token_hash`);--> statement-breakpoint
CREATE INDEX `invitations_email_idx` ON `invitations` (`email`,`expires_at`);--> statement-breakpoint
CREATE TABLE `recipe_publications` (
	`published_at` text,
	`published_by` text,
	`recipe_id` text PRIMARY KEY NOT NULL,
	`review_requested_at` text,
	`review_requested_by` text,
	`status` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`published_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_requested_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "recipe_publications_status_check" CHECK("recipe_publications"."status" IN ('review','published'))
);
--> statement-breakpoint
CREATE TABLE `recovery_tokens` (
	`consumed_at` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`token_hash` text NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "recovery_kind_check" CHECK("recovery_tokens"."kind" IN ('email','server'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recovery_tokens_token_hash_unique` ON `recovery_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `recovery_user_idx` ON `recovery_tokens` (`user_id`,`expires_at`);