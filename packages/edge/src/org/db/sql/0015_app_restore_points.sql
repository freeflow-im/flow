CREATE TABLE `user_app_restore_points` (
	`name` text NOT NULL,
	`from_version` integer NOT NULL,
	`to_version` integer NOT NULL,
	`bookmark` text NOT NULL,
	`by` text NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`name`, `at`)
);
