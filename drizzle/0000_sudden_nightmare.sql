CREATE TABLE `catalogs` (
	`owner_id` text NOT NULL,
	`id` text NOT NULL,
	`data_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`photo_key` text,
	`photo_mime` text,
	PRIMARY KEY(`owner_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `catalogs_owner_updated` ON `catalogs` (`owner_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `provider_settings` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`ciphertext` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `request_budgets` (
	`key` text PRIMARY KEY NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `request_budgets_window` ON `request_budgets` (`window_start`);