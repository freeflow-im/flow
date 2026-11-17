ALTER TABLE `meetings` ADD `chat_channel_id` text REFERENCES channels(id);--> statement-breakpoint
ALTER TABLE `meetings` ADD `session_started_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `meetings_chat_channel_idx` ON `meetings` (`chat_channel_id`);