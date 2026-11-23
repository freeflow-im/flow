CREATE TABLE `meeting_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`sent_by` text NOT NULL,
	`session_id` text,
	`joined_at` integer NOT NULL,
	`left_at` integer,
	`notes_url` text,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sent_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `meeting_agents_meeting_idx` ON `meeting_agents` (`meeting_id`,`joined_at`);--> statement-breakpoint
CREATE INDEX `meeting_agents_session_idx` ON `meeting_agents` (`session_id`);