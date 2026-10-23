ALTER TABLE `dnfi_run_tickets` ADD `game_version` text;--> statement-breakpoint
ALTER TABLE `dnfi_run_tickets` ADD `epoch` integer;--> statement-breakpoint
ALTER TABLE `dnfi_run_tickets` ADD `snapshot_hash` text;--> statement-breakpoint
ALTER TABLE `dnfi_run_tickets` ADD `player` text;--> statement-breakpoint
ALTER TABLE `dnfi_run_tickets` ADD `result_json` text;--> statement-breakpoint
DROP TABLE `dnfi_leaderboard_snapshots`;--> statement-breakpoint
CREATE TABLE `dnfi_leaderboard_snapshots` (
	`chain_id` integer NOT NULL,
	`contract_address` text NOT NULL,
	`game_version` text NOT NULL,
	`cursor` integer NOT NULL,
	`snapshot_json` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`chain_id`, `contract_address`, `game_version`)
);
