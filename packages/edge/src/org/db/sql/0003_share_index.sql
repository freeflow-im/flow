CREATE TABLE `shares` (
	`ref` text NOT NULL,
	`principal` text NOT NULL,
	`role` text NOT NULL,
	`granted_by` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`kind` text DEFAULT '' NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`ref`, `principal`)
);
--> statement-breakpoint
CREATE INDEX `shares_principal_idx` ON `shares` (`principal`);