ALTER TABLE `sessions` ADD `applied_input_version` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `sessions` SET `applied_input_version` = `input_version`;
