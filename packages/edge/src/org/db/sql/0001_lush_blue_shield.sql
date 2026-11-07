ALTER TABLE `workspace_members` ADD `address` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `policies` text DEFAULT '{}' NOT NULL;