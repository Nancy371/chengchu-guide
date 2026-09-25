CREATE TABLE `requests` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`request_id` text NOT NULL,
	`text` text NOT NULL,
	`status` text NOT NULL,
	`input_version` integer,
	`response_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `requests_session_request_uq` ON `requests` (`session_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `requests_session_created_idx` ON `requests` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `requests_created_idx` ON `requests` (`created_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`state_json` text NOT NULL,
	`input_version` integer DEFAULT 0 NOT NULL,
	`state_version` integer DEFAULT 0 NOT NULL,
	`result_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);