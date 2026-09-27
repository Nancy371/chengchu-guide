CREATE TABLE `habit_memories` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`value_json` text NOT NULL,
	`source_session_id` text NOT NULL,
	`source_turn` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `habit_memories_user_kind_uq` ON `habit_memories` (`user_id`,`kind`);--> statement-breakpoint
CREATE INDEX `habit_memories_user_expires_idx` ON `habit_memories` (`user_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `memory_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `sessions` ADD `user_id` text;--> statement-breakpoint
CREATE INDEX `sessions_user_updated_idx` ON `sessions` (`user_id`,`updated_at`);