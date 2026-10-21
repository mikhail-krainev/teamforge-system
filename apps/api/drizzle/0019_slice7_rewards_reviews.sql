CREATE TABLE "profiles"."peer_review" (
	"id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"subject_user_id" uuid NOT NULL,
	"text" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"published_on" date,
	"sort_key" integer NOT NULL,
	"purge_after" date,
	CONSTRAINT "peer_review_text_check" CHECK (char_length("profiles"."peer_review"."text") BETWEEN 1 AND 2000),
	CONSTRAINT "peer_review_status_check" CHECK ("profiles"."peer_review"."status" IN ('pending','published','withheld'))
);
--> statement-breakpoint
CREATE TABLE "profiles"."peer_review_authorship" (
	"review_id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"subject_user_id" uuid NOT NULL,
	CONSTRAINT "peer_review_authorship_self_check" CHECK ("profiles"."peer_review_authorship"."author_user_id" <> "profiles"."peer_review_authorship"."subject_user_id")
);
--> statement-breakpoint
CREATE TABLE "profiles"."review_eligibility" (
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"team_name" text NOT NULL,
	"window_until" timestamp with time zone NOT NULL,
	CONSTRAINT "review_eligibility_pkey" PRIMARY KEY("team_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "rewards"."admin_audit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"reason" text NOT NULL,
	"data" jsonb NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rewards"."award" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"badge_code" text NOT NULL,
	"scope" text NOT NULL,
	"team_id" uuid,
	"awarded_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	CONSTRAINT "award_scope_check" CHECK ("rewards"."award"."scope" IN ('individual','team'))
);
--> statement-breakpoint
CREATE TABLE "rewards"."badge_def" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"series" text,
	"step" smallint,
	"scope" text NOT NULL,
	"available" boolean NOT NULL,
	CONSTRAINT "badge_def_series_check" CHECK ("rewards"."badge_def"."series" IS NULL OR "rewards"."badge_def"."series" IN ('projects','roles','product_types')),
	CONSTRAINT "badge_def_scope_check" CHECK ("rewards"."badge_def"."scope" IN ('individual','team'))
);
--> statement-breakpoint
CREATE TABLE "rewards"."counter" (
	"user_id" uuid NOT NULL,
	"role_code" text,
	"value" integer NOT NULL,
	CONSTRAINT "counter_uq" UNIQUE NULLS NOT DISTINCT("user_id","role_code"),
	CONSTRAINT "counter_value_check" CHECK ("rewards"."counter"."value" >= 0)
);
--> statement-breakpoint
CREATE TABLE "rewards"."credit" (
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_code" text NOT NULL,
	"status" text NOT NULL,
	"deficit_at_join" boolean NOT NULL,
	"credited_at" timestamp with time zone,
	CONSTRAINT "credit_pkey" PRIMARY KEY("team_id","user_id","role_code"),
	CONSTRAINT "credit_status_check" CHECK ("rewards"."credit"."status" IN ('credited','pending_account','denied','revoked'))
);
--> statement-breakpoint
CREATE TABLE "rewards"."credit_run" (
	"team_id" uuid PRIMARY KEY NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"cooling_until" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"roster_hash" "bytea" NOT NULL,
	"fraud_score" integer DEFAULT 0 NOT NULL,
	"credited_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "credit_run_status_check" CHECK ("rewards"."credit_run"."status" IN ('cooling','frozen','credited','revoked'))
);
--> statement-breakpoint
CREATE TABLE "rewards"."dispute" (
	"id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rewards"."fraud_case" (
	"id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"status" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"comment" text,
	CONSTRAINT "fraud_case_status_check" CHECK ("rewards"."fraud_case"."status" IN ('open','ok','violation'))
);
--> statement-breakpoint
CREATE TABLE "rewards"."fraud_signal" (
	"id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"phase" text NOT NULL,
	"rule_code" text NOT NULL,
	"action" text NOT NULL,
	"score" integer NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "fraud_signal_phase_check" CHECK ("rewards"."fraud_signal"."phase" IN ('completion','cooling_end','step_check')),
	CONSTRAINT "fraud_signal_action_check" CHECK ("rewards"."fraud_signal"."action" IN ('block','flag','signal','info'))
);
--> statement-breakpoint
CREATE TABLE "rewards"."project_credit" (
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"product_type_code" text NOT NULL,
	"overdue_days" integer NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"roster_hash" "bytea" NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	CONSTRAINT "project_credit_pkey" PRIMARY KEY("team_id","user_id"),
	CONSTRAINT "project_credit_status_check" CHECK ("rewards"."project_credit"."status" IN ('credited','pending_account','denied','revoked'))
);
--> statement-breakpoint
ALTER TABLE "profiles"."peer_review_authorship" ADD CONSTRAINT "peer_review_authorship_review_id_peer_review_id_fk" FOREIGN KEY ("review_id") REFERENCES "profiles"."peer_review"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rewards"."award" ADD CONSTRAINT "award_badge_code_badge_def_code_fk" FOREIGN KEY ("badge_code") REFERENCES "rewards"."badge_def"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rewards"."credit" ADD CONSTRAINT "credit_project_credit_fk" FOREIGN KEY ("team_id","user_id") REFERENCES "rewards"."project_credit"("team_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rewards"."project_credit" ADD CONSTRAINT "project_credit_team_id_credit_run_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "rewards"."credit_run"("team_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "peer_review_subject_idx" ON "profiles"."peer_review" USING btree ("subject_user_id","published_on" DESC NULLS LAST,"team_id","sort_key","id") WHERE "profiles"."peer_review"."status" = 'published';--> statement-breakpoint
CREATE INDEX "peer_review_team_subject_idx" ON "profiles"."peer_review" USING btree ("team_id","subject_user_id");--> statement-breakpoint
CREATE INDEX "peer_review_purge_idx" ON "profiles"."peer_review" USING btree ("purge_after") WHERE "profiles"."peer_review"."status" = 'withheld';--> statement-breakpoint
CREATE UNIQUE INDEX "peer_review_pair_uq" ON "profiles"."peer_review_authorship" USING btree ("team_id","author_user_id","subject_user_id");--> statement-breakpoint
CREATE INDEX "peer_review_authorship_author_idx" ON "profiles"."peer_review_authorship" USING btree ("author_user_id");--> statement-breakpoint
CREATE INDEX "review_eligibility_window_idx" ON "profiles"."review_eligibility" USING btree ("window_until");--> statement-breakpoint
CREATE INDEX "review_eligibility_user_idx" ON "profiles"."review_eligibility" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "admin_audit_target_idx" ON "rewards"."admin_audit" USING btree ("target_type","target_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "award_individual_uq" ON "rewards"."award" USING btree ("user_id","badge_code") WHERE "rewards"."award"."scope" = 'individual' AND "rewards"."award"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "award_team_uq" ON "rewards"."award" USING btree ("team_id","user_id","badge_code") WHERE "rewards"."award"."scope" = 'team';--> statement-breakpoint
CREATE INDEX "award_user_idx" ON "rewards"."award" USING btree ("user_id") WHERE "rewards"."award"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "award_team_idx" ON "rewards"."award" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "credit_user_idx" ON "rewards"."credit" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "credit_run_cooling_idx" ON "rewards"."credit_run" USING btree ("cooling_until") WHERE "rewards"."credit_run"."status" = 'cooling';--> statement-breakpoint
CREATE INDEX "credit_run_roster_idx" ON "rewards"."credit_run" USING btree ("roster_hash");--> statement-breakpoint
CREATE INDEX "dispute_team_idx" ON "rewards"."dispute" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dispute_team_user_uq" ON "rewards"."dispute" USING btree ("team_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fraud_case_open_uq" ON "rewards"."fraud_case" USING btree ("team_id") WHERE "rewards"."fraud_case"."status" = 'open';--> statement-breakpoint
CREATE INDEX "fraud_case_status_idx" ON "rewards"."fraud_case" USING btree ("status","opened_at","id");--> statement-breakpoint
CREATE INDEX "fraud_case_team_idx" ON "rewards"."fraud_case" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fraud_signal_uq" ON "rewards"."fraud_signal" USING btree ("team_id","phase","rule_code");--> statement-breakpoint
CREATE INDEX "project_credit_user_idx" ON "rewards"."project_credit" USING btree ("user_id","completed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "project_credit_pending_idx" ON "rewards"."project_credit" USING btree ("user_id") WHERE "rewards"."project_credit"."status" = 'pending_account';--> statement-breakpoint
-- Seed of the badge catalog (FR-REW-05, S7-02). Idempotent. The steps of a series are "ступени серии";
-- "Коллекционер форматов" (product types, step 2) is unreachable in the MVP (available = false).
INSERT INTO "rewards"."badge_def" ("code", "name", "series", "step", "scope", "available") VALUES
	('projects_1', 'Первый релиз', 'projects', 1, 'individual', true),
	('projects_2', 'Трое в строю', 'projects', 2, 'individual', true),
	('projects_3', 'Пятёрка проектов', 'projects', 3, 'individual', true),
	('projects_4', 'Десять из десяти', 'projects', 4, 'individual', true),
	('roles_1', 'Многоликий', 'roles', 1, 'individual', true),
	('roles_2', 'Универсал', 'roles', 2, 'individual', true),
	('product_types_1', 'Разные берега', 'product_types', 1, 'individual', true),
	('product_types_2', 'Коллекционер форматов', 'product_types', 2, 'individual', false),
	('on_time', 'В срок', NULL, NULL, 'individual', true),
	('on_time_streak', 'Три в срок подряд', NULL, NULL, 'individual', true),
	('closed_deficit', 'Закрыл дефицит', NULL, NULL, 'individual', true),
	('closed_vacancy', 'Закрытая вакансия', NULL, NULL, 'team', true)
ON CONFLICT ("code") DO NOTHING;
