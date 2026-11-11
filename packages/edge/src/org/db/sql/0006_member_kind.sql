ALTER TABLE `workspace_members` ADD `kind` text DEFAULT 'native' NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_members` ADD `runtime` text;