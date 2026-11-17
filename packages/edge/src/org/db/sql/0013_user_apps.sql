CREATE TABLE `user_app_agents` (
	`name` text NOT NULL,
	`account_id` text NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`name`, `account_id`)
);
--> statement-breakpoint
CREATE TABLE `user_app_grants` (
	`name` text NOT NULL,
	`scope` text NOT NULL,
	`grantee` text NOT NULL,
	PRIMARY KEY(`name`, `scope`, `grantee`)
);
--> statement-breakpoint
CREATE INDEX `user_app_grants_grantee` ON `user_app_grants` (`grantee`);--> statement-breakpoint
CREATE TABLE `user_app_versions` (
	`name` text NOT NULL,
	`version` integer NOT NULL,
	`manifest` text NOT NULL,
	`by` text NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`name`, `version`)
);
--> statement-breakpoint
CREATE TABLE `user_apps` (
	`name` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`manifest` text NOT NULL,
	`manifest_url` text NOT NULL,
	`secret` blob NOT NULL,
	`secret_nonce` blob NOT NULL,
	`enc_key_id` text NOT NULL,
	`enc_scheme` integer NOT NULL,
	`installed_by` text NOT NULL,
	`installed_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
