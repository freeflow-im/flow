CREATE TABLE `channel_visitors` (
	`channel_id` text NOT NULL,
	`user_id` text NOT NULL,
	`link_id` text,
	`sees_from` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`removed_at` integer,
	PRIMARY KEY(`channel_id`, `user_id`),
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`link_id`) REFERENCES `visitor_links`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `channel_visitors_link_idx` ON `channel_visitors` (`link_id`);--> statement-breakpoint
CREATE INDEX `channel_visitors_user_idx` ON `channel_visitors` (`user_id`);--> statement-breakpoint
CREATE TABLE `visitor_links` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`token_hash` blob NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `visitor_links_token_idx` ON `visitor_links` (`token_hash`);--> statement-breakpoint
CREATE INDEX `visitor_links_channel_idx` ON `visitor_links` (`channel_id`);--> statement-breakpoint
CREATE TABLE `visitor_sessions` (
	`token_hash` blob PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `visitor_sessions_user_idx` ON `visitor_sessions` (`user_id`);--> statement-breakpoint
ALTER TABLE `users` ADD `is_visitor` integer DEFAULT false NOT NULL;