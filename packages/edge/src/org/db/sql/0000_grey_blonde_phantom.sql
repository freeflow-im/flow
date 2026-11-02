CREATE TABLE `agent_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` blob NOT NULL,
	`workspace_id` text NOT NULL,
	`sponsor_user_id` text NOT NULL,
	`agent_user_id` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`redeemed_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sponsor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_6` ON `agent_invites` (`code_hash`);--> statement-breakpoint
CREATE INDEX `agent_invites_sponsor_idx` ON `agent_invites` (`sponsor_user_id`) WHERE redeemed_at IS NULL;--> statement-breakpoint
CREATE TABLE `agent_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` blob NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_7` ON `agent_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `agent_tokens_user_idx` ON `agent_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `app_link_codes` (
	`code_hash` blob PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`kind` text DEFAULT 'file' NOT NULL,
	`file_id` text,
	`url` text,
	`owns_file` integer DEFAULT false NOT NULL,
	`requester_user_id` text,
	`source_thread_root_id` text,
	`operation_id` text,
	`name` text NOT NULL,
	`app_secret` blob,
	`app_secret_nonce` blob,
	`app_enc_key_id` text,
	`app_enc_scheme` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requester_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_thread_root_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `artifacts_channel_idx` ON `artifacts` (`channel_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_delivery_operation` ON `artifacts` (`channel_id`,`created_by`,`operation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_channel_file_pin` ON `artifacts` (`channel_id`,`file_id`) WHERE owns_file = false;--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_channel_link_pin` ON `artifacts` (`channel_id`,`url`) WHERE kind = 'link';--> statement-breakpoint
CREATE TABLE `auth_handoffs` (
	`request_hash` blob PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`state` text NOT NULL,
	`server_origin` text NOT NULL,
	`client_origin` text,
	`return_url` text NOT NULL,
	`code_challenge` text NOT NULL,
	`code_hash` blob,
	`user_id` text,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_2` ON `auth_handoffs` (`code_hash`);--> statement-breakpoint
CREATE TABLE `channel_members` (
	`channel_id` text NOT NULL,
	`user_id` text NOT NULL,
	`joined_at` integer NOT NULL,
	`last_read_msg_id` text,
	`notify_level` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`channel_id`, `user_id`),
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_2` ON `channel_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text COLLATE NOCASE,
	`kind` text DEFAULT 'standard' NOT NULL,
	`dm_key` text,
	`topic` text,
	`is_private` integer DEFAULT false NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`archived_at` integer,
	`parent_id` text,
	`emoji` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ui_1` ON `channels` (`workspace_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `chan_dm_key` ON `channels` (`workspace_id`,`dm_key`) WHERE dm_key IS NOT NULL;--> statement-breakpoint
CREATE TABLE `device_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token` text NOT NULL,
	`routing_id` text,
	`platform` text NOT NULL,
	`environment` text NOT NULL,
	`bundle_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`disabled_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_8` ON `device_tokens` (`token`);--> statement-breakpoint
CREATE INDEX `device_tokens_user_idx` ON `device_tokens` (`user_id`) WHERE disabled_at IS NULL;--> statement-breakpoint
CREATE TABLE `email_tokens` (
	`token_hash` blob PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`purpose` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `email_tokens_user_purpose_idx` ON `email_tokens` (`user_id`,`purpose`);--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`storage_key` text NOT NULL,
	`enc_key_id` text,
	`status` text DEFAULT 'ready' NOT NULL,
	`width` integer,
	`height` integer,
	`thumb_key` text,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `huddle_invite_targets` (
	`invite_id` text NOT NULL,
	`user_id` text NOT NULL,
	`status` text NOT NULL,
	`responded_at` integer,
	PRIMARY KEY(`invite_id`, `user_id`),
	FOREIGN KEY (`invite_id`) REFERENCES `huddle_invites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `huddle_invite_targets_user_idx` ON `huddle_invite_targets` (`user_id`);--> statement-breakpoint
CREATE TABLE `huddle_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`started_by` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`answered_at` integer,
	`ended_at` integer,
	`duration_seconds` integer,
	`system_message_id` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`started_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`system_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `huddle_invites_channel_idx` ON `huddle_invites` (`channel_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `huddle_invites_ringing_idx` ON `huddle_invites` (`status`) WHERE status IN ('ringing', 'active');--> statement-breakpoint
CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`email` text COLLATE NOCASE NOT NULL,
	`token_hash` blob NOT NULL,
	`invited_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`accepted_at` integer,
	`invited_user_id` text,
	`declined_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invited_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_4` ON `invites` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `invites_pending_unique` ON `invites` (`workspace_id`,`email`) WHERE accepted_at IS NULL AND declined_at IS NULL;--> statement-breakpoint
CREATE INDEX `invites_invited_user_idx` ON `invites` (`invited_user_id`) WHERE accepted_at IS NULL AND declined_at IS NULL;--> statement-breakpoint
CREATE TABLE `message_files` (
	`message_id` text NOT NULL,
	`file_id` text NOT NULL,
	PRIMARY KEY(`message_id`, `file_id`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `message_files_file_idx` ON `message_files` (`file_id`);--> statement-breakpoint
CREATE TABLE `message_pins` (
	`message_id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`pinned_by` text,
	`pinned_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pinned_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `message_pins_channel_idx` ON `message_pins` (`channel_id`,`pinned_at`);--> statement-breakpoint
CREATE TABLE `message_unfurls` (
	`message_id` text NOT NULL,
	`url_hash` text NOT NULL,
	`channel_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	PRIMARY KEY(`message_id`, `url_hash`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `message_unfurls_suppression_idx` ON `message_unfurls` (`channel_id`,`url_hash`,`created_at`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`user_id` text NOT NULL,
	`thread_root_id` text,
	`client_msg_id` text NOT NULL,
	`body` blob NOT NULL,
	`body_nonce` blob NOT NULL,
	`enc_key_id` text NOT NULL,
	`enc_scheme` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`edited_at` integer,
	`deleted_at` integer,
	`reply_count` integer DEFAULT 0 NOT NULL,
	`last_reply_at` integer,
	`system_kind` text,
	`scheduled` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`thread_root_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ui_2` ON `messages` (`channel_id`,`client_msg_id`);--> statement-breakpoint
CREATE INDEX `msg_channel_top` ON `messages` (`channel_id`,`id`) WHERE thread_root_id IS NULL;--> statement-breakpoint
CREATE INDEX `msg_thread` ON `messages` (`thread_root_id`,`id`) WHERE thread_root_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`message_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`kind` integer NOT NULL,
	`subkind` text,
	`actor_id` text,
	`reaction_emoji` text,
	`created_at` integer NOT NULL,
	`read_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notifications_user_idx` ON `notifications` (`user_id`,`read_at`,`id`);--> statement-breakpoint
CREATE INDEX `notifications_unread_channel_idx` ON `notifications` (`user_id`,`channel_id`) WHERE read_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_reaction_uniq` ON `notifications` (`user_id`,`message_id`,`actor_id`,`reaction_emoji`) WHERE kind = 4;--> statement-breakpoint
CREATE TABLE `oauth_identities` (
	`provider` text NOT NULL,
	`provider_subject` text NOT NULL,
	`user_id` text NOT NULL,
	`email` text COLLATE NOCASE NOT NULL,
	`hosted_domain` text COLLATE NOCASE,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`provider`, `provider_subject`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oauth_identities_user_idx` ON `oauth_identities` (`user_id`);--> statement-breakpoint
CREATE TABLE `pending_push` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`notification_id` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	`failed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`notification_id`) REFERENCES `notifications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pending_push_due` ON `pending_push` (`next_attempt_at`) WHERE delivered_at IS NULL AND failed_at IS NULL;--> statement-breakpoint
CREATE INDEX `pending_push_user_idx` ON `pending_push` (`user_id`,`id`);--> statement-breakpoint
CREATE TABLE `pending_signups` (
	`token_hash` blob PRIMARY KEY NOT NULL,
	`email` text COLLATE NOCASE NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pending_signups_email_idx` ON `pending_signups` (`email`);--> statement-breakpoint
CREATE TABLE `rate_limit_windows` (
	`key` text PRIMARY KEY NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reactions` (
	`message_id` text NOT NULL,
	`user_id` text NOT NULL,
	`emoji` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`message_id`, `user_id`, `emoji`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `reactions_message_idx` ON `reactions` (`message_id`);--> statement-breakpoint
CREATE TABLE `scheduled_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`author_user_id` text NOT NULL,
	`body` blob NOT NULL,
	`body_nonce` blob NOT NULL,
	`enc_key_id` text NOT NULL,
	`enc_scheme` integer DEFAULT 1 NOT NULL,
	`recurrence` text NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`next_run_at` integer,
	`enabled` integer DEFAULT true NOT NULL,
	`last_run_at` integer,
	`last_run_status` text,
	`last_message_id` text,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`last_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `scheduled_messages_due_idx` ON `scheduled_messages` (`next_run_at`) WHERE enabled AND next_run_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX `scheduled_messages_workspace_idx` ON `scheduled_messages` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `scheduled_messages_author_idx` ON `scheduled_messages` (`author_user_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` blob PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`client_info` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `unfurl_cache` (
	`url_hash` text PRIMARY KEY NOT NULL,
	`normalized_url` text NOT NULL,
	`ok` integer NOT NULL,
	`failure_reason` text,
	`data` text,
	`fetched_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `unfurl_cache_expires_idx` ON `unfurl_cache` (`expires_at`);--> statement-breakpoint
CREATE TABLE `unfurl_domain_denylist` (
	`domain` text PRIMARY KEY NOT NULL,
	`note` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text COLLATE NOCASE NOT NULL,
	`password_hash` text NOT NULL,
	`display_name` text NOT NULL,
	`avatar_url` text,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`is_bot` integer DEFAULT false NOT NULL,
	`is_agent` integer DEFAULT false NOT NULL,
	`sponsor_user_id` text,
	`agent_username` text COLLATE NOCASE,
	`agent_key_hash` text,
	`status_emoji` text DEFAULT '' NOT NULL,
	`status_text` text DEFAULT '' NOT NULL,
	`website` text DEFAULT '' NOT NULL,
	`bio` text DEFAULT '' NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`notification_prefs` text DEFAULT '{}' NOT NULL,
	`status_suppress_alerts` integer DEFAULT false NOT NULL,
	`unfurl_own_links` integer DEFAULT true NOT NULL,
	`privacy_mode` integer DEFAULT false NOT NULL,
	`email_verified_at` integer,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`sponsor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_1` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `workspace_email_images` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`file_id` text NOT NULL,
	`created_by` text NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_9` ON `workspace_email_images` (`token`);--> statement-breakpoint
CREATE INDEX `workspace_email_images_file_idx` ON `workspace_email_images` (`file_id`);--> statement-breakpoint
CREATE TABLE `workspace_emoji` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`shortcode` text NOT NULL,
	`file_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_emoji_code_idx` ON `workspace_emoji` (`workspace_id`,`shortcode`);--> statement-breakpoint
CREATE TABLE `workspace_join_links` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_5` ON `workspace_join_links` (`token`);--> statement-breakpoint
CREATE TABLE `workspace_members` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`sponsor_user_id` text,
	`joined_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sponsor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_1` ON `workspace_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text COLLATE NOCASE NOT NULL,
	`name` text NOT NULL,
	`sidebar_color` text DEFAULT 'violet' NOT NULL,
	`avatar_url` text,
	`unfurl_enabled` integer DEFAULT true NOT NULL,
	`unfurl_domain_allowlist` text,
	`google_self_register_domain` text COLLATE NOCASE,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_3` ON `workspaces` (`slug`);