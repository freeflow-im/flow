ALTER TABLE `user_app_versions` ADD `state` text DEFAULT 'installed' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_app_versions` ADD `files` text;--> statement-breakpoint
ALTER TABLE `user_app_versions` ADD `prefix` text;