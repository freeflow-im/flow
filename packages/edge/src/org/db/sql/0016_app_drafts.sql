CREATE TABLE `user_app_draft_files` (
	`name` text NOT NULL,
	`author` text NOT NULL,
	`path` text NOT NULL,
	`body` blob NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`name`, `author`, `path`)
);
--> statement-breakpoint
CREATE TABLE `user_app_drafts` (
	`name` text NOT NULL,
	`author` text NOT NULL,
	`secret` blob NOT NULL,
	`secret_nonce` blob NOT NULL,
	`enc_key_id` text NOT NULL,
	`enc_scheme` integer NOT NULL,
	`dev_host` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`name`, `author`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_app_drafts_dev_host` ON `user_app_drafts` (`dev_host`);