ALTER TABLE `meetings` ADD `code` text;--> statement-breakpoint
CREATE UNIQUE INDEX `meetings_code_idx` ON `meetings` (`code`);