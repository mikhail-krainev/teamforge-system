CREATE TABLE "playbooks"."playbook" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_type_code" text NOT NULL,
	"title" text NOT NULL,
	"version" text NOT NULL,
	"v_major" integer NOT NULL,
	"v_minor" integer NOT NULL,
	"v_patch" integer NOT NULL,
	"status" text NOT NULL,
	"total_days" integer NOT NULL,
	"source_text" text NOT NULL,
	"source_sha256" "bytea" NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "playbook_status_check" CHECK ("playbooks"."playbook"."status" IN ('draft','published')),
	CONSTRAINT "playbook_total_days_check" CHECK ("playbooks"."playbook"."total_days" > 0)
);
--> statement-breakpoint
CREATE TABLE "playbooks"."product_type" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams"."departure" (
	"id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"seat_ids" uuid[] NOT NULL,
	"reason" text NOT NULL,
	"decision" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	CONSTRAINT "departure_decision_check" CHECK ("teams"."departure"."decision" IN ('pending','replace','continue'))
);
--> statement-breakpoint
CREATE TABLE "teams"."invitation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"seat_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"invitee_github_user_id" bigint,
	"invitee_github_login" text,
	"invitee_email_hmac" "bytea",
	"status" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_by" uuid,
	"used_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "invitation_status_check" CHECK ("teams"."invitation"."status" IN ('active','used','revoked','expired'))
);
--> statement-breakpoint
CREATE TABLE "teams"."membership" (
	"id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text NOT NULL,
	"joined_via" text NOT NULL,
	"joined_at" timestamp with time zone NOT NULL,
	"trial_until" timestamp with time zone,
	"trial_confirmed_at" timestamp with time zone,
	"application_id" uuid,
	"left_at" timestamp with time zone,
	"left_reason" text,
	CONSTRAINT "membership_status_check" CHECK ("teams"."membership"."status" IN ('active','left','removed')),
	CONSTRAINT "membership_joined_via_check" CHECK ("teams"."membership"."joined_via" IN ('creator','invite','offer','request','auto','vote')),
	CONSTRAINT "membership_left_reason_check" CHECK ("teams"."membership"."left_reason" IN ('left','removed_in_trial','deleted_account','team_archived'))
);
--> statement-breakpoint
CREATE TABLE "teams"."seat" (
	"id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"role_code" text NOT NULL,
	"ordinal" smallint NOT NULL,
	"desired" boolean DEFAULT false NOT NULL,
	"desired_changed_at" timestamp with time zone,
	"min_level" text NOT NULL,
	"min_hours" smallint NOT NULL,
	"stack" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text NOT NULL,
	"opened_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "seat_team_role_ordinal_uq" UNIQUE("team_id","role_code","ordinal"),
	CONSTRAINT "seat_min_level_check" CHECK ("teams"."seat"."min_level" IN ('beginner','junior','middle')),
	CONSTRAINT "seat_status_check" CHECK ("teams"."seat"."status" IN ('open','filled','closed'))
);
--> statement-breakpoint
CREATE TABLE "teams"."seat_assignment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seat_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_code" text NOT NULL,
	"joined_via" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"deficit_at_join" boolean NOT NULL,
	"deficit_open_seats" integer NOT NULL,
	"deficit_queued" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams"."seat_offer" (
	"id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"seat_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"status" text NOT NULL,
	"message" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "seat_offer_direction_check" CHECK ("teams"."seat_offer"."direction" IN ('lead_to_user','user_to_lead')),
	CONSTRAINT "seat_offer_status_check" CHECK ("teams"."seat_offer"."status" IN ('pending','accepted','rejected','expired','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "teams"."team" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"product_type_code" text NOT NULL,
	"playbook_id" uuid NOT NULL,
	"lead_user_id" uuid,
	"status" text NOT NULL,
	"status_reason" text,
	"status_before_vote" text,
	"timezone" text NOT NULL,
	"hours_per_week" smallint NOT NULL,
	"member_count" smallint DEFAULT 0 NOT NULL,
	"seat_count" smallint DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"planned_end_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"suspended_total_seconds" integer DEFAULT 0 NOT NULL,
	"release_url" text,
	"lead_last_active_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "team_status_check" CHECK ("teams"."team"."status" IN ('forming','active','voting','suspended','completed','archived')),
	CONSTRAINT "team_member_count_check" CHECK ("teams"."team"."member_count" BETWEEN 0 AND 8),
	CONSTRAINT "team_seat_count_check" CHECK ("teams"."team"."seat_count" BETWEEN 0 AND 12)
);
--> statement-breakpoint
CREATE TABLE "teams"."leader_vote" (
	"id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"round" smallint DEFAULT 1 NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"phase_deadline" timestamp with time zone,
	"voting_deadline" timestamp with time zone NOT NULL,
	"extended" boolean DEFAULT false NOT NULL,
	"eligible_count" smallint NOT NULL,
	"outcome" text,
	"winner_user_id" uuid,
	"random_tie_break" boolean DEFAULT false NOT NULL,
	"closed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "leader_vote_trigger_check" CHECK ("teams"."leader_vote"."trigger" IN ('lead_left','lead_deleted','lead_inactive')),
	CONSTRAINT "leader_vote_status_check" CHECK ("teams"."leader_vote"."status" IN ('nominating','voting','runoff','confirming','offering','closed','cancelled')),
	CONSTRAINT "leader_vote_round_check" CHECK ("teams"."leader_vote"."round" IN (1,2)),
	CONSTRAINT "leader_vote_outcome_check" CHECK ("teams"."leader_vote"."outcome" IN ('elected','appointed_senior','sole_member','suspended','archived','cancelled_lead_returned'))
);
--> statement-breakpoint
CREATE TABLE "teams"."team_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor_user_id" uuid,
	"payload" jsonb NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams"."vote_ballot" (
	"vote_id" uuid NOT NULL,
	"round" smallint NOT NULL,
	"voter_user_id" uuid NOT NULL,
	"candidate_user_id" uuid NOT NULL,
	"cast_at" timestamp with time zone NOT NULL,
	CONSTRAINT "vote_ballot_pkey" PRIMARY KEY("vote_id","round","voter_user_id")
);
--> statement-breakpoint
CREATE TABLE "teams"."vote_candidate" (
	"vote_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"nominated_by" uuid NOT NULL,
	"consent_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"in_runoff" boolean DEFAULT false NOT NULL,
	CONSTRAINT "vote_candidate_pkey" PRIMARY KEY("vote_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "teams"."vote_eligible" (
	"vote_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_at" timestamp with time zone NOT NULL,
	CONSTRAINT "vote_eligible_pkey" PRIMARY KEY("vote_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "teams"."vote_offer" (
	"id" uuid PRIMARY KEY NOT NULL,
	"vote_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ordinal" smallint NOT NULL,
	"status" text NOT NULL,
	"offered_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"answered_at" timestamp with time zone,
	CONSTRAINT "vote_offer_vote_user_kind_uq" UNIQUE("vote_id","user_id","kind"),
	CONSTRAINT "vote_offer_kind_check" CHECK ("teams"."vote_offer"."kind" IN ('winner_confirmation','senior_offer')),
	CONSTRAINT "vote_offer_status_check" CHECK ("teams"."vote_offer"."status" IN ('offered','accepted','declined','expired'))
);
--> statement-breakpoint
CREATE TABLE "teams"."vote_request" (
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "vote_request_pkey" PRIMARY KEY("team_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "workspace"."notification" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "playbooks"."playbook" ADD CONSTRAINT "playbook_product_type_code_product_type_code_fk" FOREIGN KEY ("product_type_code") REFERENCES "playbooks"."product_type"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams"."departure" ADD CONSTRAINT "departure_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"."team"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams"."departure" ADD CONSTRAINT "departure_membership_id_membership_id_fk" FOREIGN KEY ("membership_id") REFERENCES "teams"."membership"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams"."invitation" ADD CONSTRAINT "invitation_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"."team"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams"."invitation" ADD CONSTRAINT "invitation_seat_id_seat_id_fk" FOREIGN KEY ("seat_id") REFERENCES "teams"."seat"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams"."membership" ADD CONSTRAINT "membership_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"."team"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams"."seat" ADD CONSTRAINT "seat_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"."team"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams"."seat_assignment" ADD CONSTRAINT "seat_assignment_seat_id_seat_id_fk" FOREIGN KEY ("seat_id") REFERENCES "teams"."seat"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams"."seat_assignment" ADD CONSTRAINT "seat_assignment_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"."team"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams"."seat_assignment" ADD CONSTRAINT "seat_assignment_membership_id_membership_id_fk" FOREIGN KEY ("membership_id") REFERENCES "teams"."membership"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams"."seat_offer" ADD CONSTRAINT "seat_offer_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"."team"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams"."seat_offer" ADD CONSTRAINT "seat_offer_seat_id_seat_id_fk" FOREIGN KEY ("seat_id") REFERENCES "teams"."seat"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams"."leader_vote" ADD CONSTRAINT "leader_vote_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"."team"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams"."team_event" ADD CONSTRAINT "team_event_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"."team"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams"."vote_ballot" ADD CONSTRAINT "vote_ballot_vote_id_leader_vote_id_fk" FOREIGN KEY ("vote_id") REFERENCES "teams"."leader_vote"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams"."vote_candidate" ADD CONSTRAINT "vote_candidate_vote_id_leader_vote_id_fk" FOREIGN KEY ("vote_id") REFERENCES "teams"."leader_vote"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams"."vote_eligible" ADD CONSTRAINT "vote_eligible_vote_id_leader_vote_id_fk" FOREIGN KEY ("vote_id") REFERENCES "teams"."leader_vote"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams"."vote_offer" ADD CONSTRAINT "vote_offer_vote_id_leader_vote_id_fk" FOREIGN KEY ("vote_id") REFERENCES "teams"."leader_vote"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams"."vote_request" ADD CONSTRAINT "vote_request_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"."team"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "playbook_type_version_uq" ON "playbooks"."playbook" USING btree ("product_type_code","version");--> statement-breakpoint
CREATE INDEX "playbook_latest_idx" ON "playbooks"."playbook" USING btree ("product_type_code","v_major" DESC NULLS LAST,"v_minor" DESC NULLS LAST,"v_patch" DESC NULLS LAST) WHERE "playbooks"."playbook"."status" = 'published';--> statement-breakpoint
CREATE INDEX "departure_pending_idx" ON "teams"."departure" USING btree ("due_at") WHERE "teams"."departure"."decision" = 'pending';--> statement-breakpoint
CREATE INDEX "departure_team_idx" ON "teams"."departure" USING btree ("team_id","decision");--> statement-breakpoint
CREATE UNIQUE INDEX "invitation_token_uq" ON "teams"."invitation" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "invitation_team_active_idx" ON "teams"."invitation" USING btree ("team_id") WHERE "teams"."invitation"."status" = 'active';--> statement-breakpoint
CREATE INDEX "invitation_cleanup_idx" ON "teams"."invitation" USING btree ("created_at") WHERE "teams"."invitation"."status" <> 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "membership_active_uq" ON "teams"."membership" USING btree ("team_id","user_id") WHERE "teams"."membership"."status" = 'active';--> statement-breakpoint
CREATE INDEX "membership_user_status_idx" ON "teams"."membership" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "membership_trial_idx" ON "teams"."membership" USING btree ("trial_until") WHERE "teams"."membership"."status" = 'active' AND "teams"."membership"."trial_until" IS NOT NULL AND "teams"."membership"."trial_confirmed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "seat_team_status_role_idx" ON "teams"."seat" USING btree ("team_id","status","role_code");--> statement-breakpoint
CREATE INDEX "seat_open_role_idx" ON "teams"."seat" USING btree ("role_code","opened_at") WHERE "teams"."seat"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "seat_assignment_active_seat_uq" ON "teams"."seat_assignment" USING btree ("seat_id") WHERE "teams"."seat_assignment"."ended_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "seat_assignment_active_role_uq" ON "teams"."seat_assignment" USING btree ("team_id","user_id","role_code") WHERE "teams"."seat_assignment"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX "seat_assignment_membership_idx" ON "teams"."seat_assignment" USING btree ("membership_id");--> statement-breakpoint
CREATE UNIQUE INDEX "seat_offer_pending_uq" ON "teams"."seat_offer" USING btree ("seat_id","user_id") WHERE "teams"."seat_offer"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "seat_offer_user_idx" ON "teams"."seat_offer" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "seat_offer_team_idx" ON "teams"."seat_offer" USING btree ("team_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "team_catalog_idx" ON "teams"."team" USING btree ("status","product_type_code","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "teams"."team"."status" IN ('forming','active');--> statement-breakpoint
CREATE INDEX "team_status_started_idx" ON "teams"."team" USING btree ("status","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "leader_vote_open_uq" ON "teams"."leader_vote" USING btree ("team_id") WHERE "teams"."leader_vote"."status" NOT IN ('closed','cancelled');--> statement-breakpoint
CREATE INDEX "leader_vote_deadline_idx" ON "teams"."leader_vote" USING btree ("phase_deadline") WHERE "teams"."leader_vote"."status" NOT IN ('closed','cancelled');--> statement-breakpoint
CREATE INDEX "team_event_team_idx" ON "teams"."team_event" USING btree ("team_id","at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "vote_ballot_tally_idx" ON "teams"."vote_ballot" USING btree ("vote_id","round","candidate_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vote_offer_pending_uq" ON "teams"."vote_offer" USING btree ("vote_id") WHERE "teams"."vote_offer"."status" = 'offered';--> statement-breakpoint
CREATE UNIQUE INDEX "notification_dedupe_uq" ON "workspace"."notification" USING btree ("user_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "notification_user_idx" ON "workspace"."notification" USING btree ("user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);