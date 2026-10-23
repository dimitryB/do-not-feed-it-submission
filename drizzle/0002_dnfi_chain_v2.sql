ALTER TABLE `dnfi_run_tickets` ADD `source_epoch` integer;--> statement-breakpoint
ALTER TABLE `dnfi_run_tickets` ADD `inherited` integer;--> statement-breakpoint
ALTER TABLE `dnfi_leaderboard_snapshots` ADD `refresh_lease_until` integer DEFAULT 0 NOT NULL;
