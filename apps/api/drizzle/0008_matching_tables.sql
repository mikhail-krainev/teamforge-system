CREATE TABLE "matching"."application_exclusion" (
	"application_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	CONSTRAINT "application_exclusion_pkey" PRIMARY KEY("application_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "matching"."application_role" (
	"application_id" uuid NOT NULL,
	"role_code" text NOT NULL,
	"priority" smallint NOT NULL,
	"added_at" timestamp with time zone NOT NULL,
	"is_active" boolean NOT NULL,
	CONSTRAINT "application_role_pkey" PRIMARY KEY("application_id","role_code"),
	CONSTRAINT "application_role_priority_uq" UNIQUE("application_id","priority") DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "application_role_priority_check" CHECK ("matching"."application_role"."priority" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "matching"."auto_add_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"seat_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matching"."candidate_stats" (
	"user_id" uuid NOT NULL,
	"role_code" text NOT NULL,
	"completed_count" integer NOT NULL,
	CONSTRAINT "candidate_stats_pkey" PRIMARY KEY("user_id","role_code")
);
--> statement-breakpoint
CREATE TABLE "matching"."match_candidate" (
	"seat_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"role_code" text NOT NULL,
	"score" numeric(4, 3) NOT NULL,
	"reasons" jsonb NOT NULL,
	"in_queue" boolean NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "match_candidate_pkey" PRIMARY KEY("seat_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "matching"."search_application" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text NOT NULL,
	"enqueued_at" timestamp with time zone NOT NULL,
	"paused_seconds" integer DEFAULT 0 NOT NULL,
	"fulfilled_at" timestamp with time zone,
	"fulfilled_seat_id" uuid,
	"fulfilled_role_code" text,
	"fulfilled_team_id" uuid,
	"cancelled_at" timestamp with time zone,
	"restored_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "search_application_status_check" CHECK ("matching"."search_application"."status" IN ('active','fulfilled','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "matching"."wait_sample" (
	"id" uuid PRIMARY KEY NOT NULL,
	"application_id" uuid NOT NULL,
	"role_code" text NOT NULL,
	"waited_seconds" integer NOT NULL,
	"matched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "matching"."application_exclusion" ADD CONSTRAINT "application_exclusion_application_id_search_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "matching"."search_application"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matching"."application_role" ADD CONSTRAINT "application_role_application_id_search_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "matching"."search_application"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_role_queue_idx" ON "matching"."application_role" USING btree ("role_code","added_at") WHERE "matching"."application_role"."is_active";--> statement-breakpoint
CREATE INDEX "auto_add_log_application_idx" ON "matching"."auto_add_log" USING btree ("application_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "match_candidate_seat_idx" ON "matching"."match_candidate" USING btree ("seat_id","score" DESC NULLS LAST,"user_id");--> statement-breakpoint
CREATE INDEX "match_candidate_user_idx" ON "matching"."match_candidate" USING btree ("user_id","score" DESC NULLS LAST,"seat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "search_application_active_uq" ON "matching"."search_application" USING btree ("user_id") WHERE "matching"."search_application"."status" = 'active';--> statement-breakpoint
CREATE INDEX "search_application_queue_idx" ON "matching"."search_application" USING btree ("enqueued_at","id") WHERE "matching"."search_application"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "wait_sample_application_uq" ON "matching"."wait_sample" USING btree ("application_id","matched_at");--> statement-breakpoint
CREATE INDEX "wait_sample_role_idx" ON "matching"."wait_sample" USING btree ("role_code","matched_at" DESC NULLS LAST);