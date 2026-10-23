ALTER TABLE `dnfi_run_tickets` ADD `snapshot_json` text;--> statement-breakpoint
CREATE TABLE `dnfi_run_traces` (
	`run_id` text PRIMARY KEY NOT NULL,
	`game_version` text NOT NULL,
	`seed` text NOT NULL,
	`inherited` integer NOT NULL,
	`epoch` integer NOT NULL,
	`source_epoch` integer,
	`snapshot_json` text NOT NULL,
	`snapshot_hash` text NOT NULL,
	`end_tick` integer NOT NULL,
	`trace_hash` text NOT NULL,
	`trace` blob NOT NULL,
	`result_json` text NOT NULL,
	`stored_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_dnfi_run_traces_stored_at` ON `dnfi_run_traces` (`stored_at`);
