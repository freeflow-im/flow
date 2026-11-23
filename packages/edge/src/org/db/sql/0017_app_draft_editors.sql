CREATE TABLE `user_app_draft_editors` (
	`name` text NOT NULL,
	`author` text NOT NULL,
	`editor` text NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`name`, `author`, `editor`)
);
--> statement-breakpoint
CREATE INDEX `user_app_draft_editors_editor` ON `user_app_draft_editors` (`editor`);