ALTER TABLE `meeting_agents` ADD `ended_at` integer;--> statement-breakpoint
UPDATE `meeting_agents` SET `ended_at` = COALESCE(`left_at`, `joined_at`);