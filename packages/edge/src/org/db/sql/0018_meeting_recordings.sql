CREATE TABLE `meeting_recordings` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_id` text NOT NULL,
	`session_id` text,
	`started_by` text NOT NULL,
	`started_at` integer NOT NULL,
	`status` text NOT NULL,
	`folder` text NOT NULL,
	`download_url` text,
	`video_url` text,
	`transcript_download_url` text,
	`transcript_url` text,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`started_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `meeting_recordings_meeting_idx` ON `meeting_recordings` (`meeting_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `meeting_recordings_session_idx` ON `meeting_recordings` (`session_id`);