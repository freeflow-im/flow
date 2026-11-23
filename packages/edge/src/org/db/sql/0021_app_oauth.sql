CREATE TABLE `user_app_oauth_clients` (
	`name` text NOT NULL,
	`dev` text DEFAULT '' NOT NULL,
	`provider` text NOT NULL,
	`client_id` text NOT NULL,
	`secret` blob NOT NULL,
	`secret_nonce` blob NOT NULL,
	`enc_key_id` text NOT NULL,
	`enc_scheme` integer NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`name`, `dev`, `provider`)
);
--> statement-breakpoint
CREATE TABLE `user_app_oauth_states` (
	`state_hash` blob PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`dev` text DEFAULT '' NOT NULL,
	`provider` text NOT NULL,
	`account_id` text NOT NULL,
	`verifier` text NOT NULL,
	`return_origin` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_app_oauth_tokens` (
	`name` text NOT NULL,
	`dev` text DEFAULT '' NOT NULL,
	`provider` text NOT NULL,
	`account_id` text NOT NULL,
	`body` blob NOT NULL,
	`body_nonce` blob NOT NULL,
	`enc_key_id` text NOT NULL,
	`enc_scheme` integer NOT NULL,
	`scope` text,
	`expires_at` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`name`, `dev`, `provider`, `account_id`)
);
--> statement-breakpoint
CREATE INDEX `user_app_oauth_tokens_account` ON `user_app_oauth_tokens` (`account_id`);