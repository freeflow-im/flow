ALTER TABLE `meetings` ADD `channel_id` text REFERENCES channels(id);--> statement-breakpoint
CREATE UNIQUE INDEX `meetings_channel_idx` ON `meetings` (`channel_id`);