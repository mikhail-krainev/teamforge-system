CREATE TABLE "github"."gh_installation" (
	"installation_id" bigint PRIMARY KEY NOT NULL,
	"account_id" bigint NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"status" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gh_installation_status_check" CHECK ("github"."gh_installation"."status" IN ('active','suspended','deleted'))
);
--> statement-breakpoint
CREATE TABLE "github"."installation_grant" (
	"installation_id" bigint NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "installation_grant_pkey" PRIMARY KEY("installation_id","team_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "github"."account_check" (
	"github_user_id" bigint PRIMARY KEY NOT NULL,
	"account_created_at" timestamp with time zone NOT NULL,
	"public_repos" integer NOT NULL,
	"has_public_activity" boolean NOT NULL,
	"checked_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github"."repo_check" (
	"id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"repository_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"ok" boolean NOT NULL,
	"details" jsonb NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "repo_check_kind_check" CHECK ("github"."repo_check"."kind" IN ('exists','final'))
);
--> statement-breakpoint
CREATE TABLE "github"."repo_link" (
	"id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"repository_id" bigint NOT NULL,
	"installation_id" bigint NOT NULL,
	"full_name" text NOT NULL,
	"is_private" boolean NOT NULL,
	"is_fork" boolean NOT NULL,
	"repo_created_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"linked_by" uuid NOT NULL,
	"linked_at" timestamp with time zone NOT NULL,
	"unlinked_at" timestamp with time zone,
	"unlink_reason" text,
	CONSTRAINT "repo_link_status_check" CHECK ("github"."repo_link"."status" IN ('active','completed','unlinked'))
);
--> statement-breakpoint
CREATE TABLE "github"."repo_sync_state" (
	"repository_id" bigint PRIMARY KEY NOT NULL,
	"issues_etag" text,
	"pulls_etag" text,
	"last_synced_at" timestamp with time zone,
	"ci_state" text,
	"ci_checked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "github"."gh_item" (
	"repository_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"html_url" text NOT NULL,
	"author_github_id" bigint,
	"assignee_github_ids" bigint[] DEFAULT '{}' NOT NULL,
	"closer_pr_number" integer,
	"state" text NOT NULL,
	"merged" boolean DEFAULT false NOT NULL,
	"labels" text[] DEFAULT '{}' NOT NULL,
	"additions" integer,
	"deletions" integer,
	"closed_at" timestamp with time zone,
	"merged_at" timestamp with time zone,
	"first_received_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"source_updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gh_item_pkey" PRIMARY KEY("repository_id","kind","number"),
	CONSTRAINT "gh_item_kind_check" CHECK ("github"."gh_item"."kind" IN ('issue','pr'))
);
--> statement-breakpoint
CREATE TABLE "github"."gh_pr_review" (
	"repository_id" bigint NOT NULL,
	"pr_number" integer NOT NULL,
	"reviewer_github_id" bigint NOT NULL,
	"state" text NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gh_pr_review_pkey" PRIMARY KEY("repository_id","pr_number","reviewer_github_id")
);
--> statement-breakpoint
CREATE TABLE "github"."webhook_delivery" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"action" text,
	"installation_id" bigint,
	"repository_id" bigint,
	"payload" jsonb,
	"status" text NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "webhook_delivery_status_check" CHECK ("github"."webhook_delivery"."status" IN ('received','processed','ignored','failed'))
);
--> statement-breakpoint
CREATE TABLE "workspace"."completion_check" (
	"id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"status" text NOT NULL,
	"results" jsonb DEFAULT '[]' NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"valid_until" timestamp with time zone,
	CONSTRAINT "completion_check_status_check" CHECK ("workspace"."completion_check"."status" IN ('queued','running','done','failed'))
);
--> statement-breakpoint
CREATE TABLE "workspace"."project_completion" (
	"team_id" uuid PRIMARY KEY NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"planned_end_at" timestamp with time zone NOT NULL,
	"overdue_days" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"completed_by" uuid NOT NULL,
	CONSTRAINT "project_completion_overdue_days_check" CHECK ("workspace"."project_completion"."overdue_days" >= 0)
);
--> statement-breakpoint
CREATE TABLE "workspace"."contribution" (
	"id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"ref" text NOT NULL,
	"title" text NOT NULL,
	"url" text,
	"role_code" text NOT NULL,
	"role_locked" boolean DEFAULT false NOT NULL,
	"stage_ordinal" smallint,
	"active" boolean DEFAULT true NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "contribution_source_check" CHECK ("workspace"."contribution"."source" IN ('issue','pr','artifact','ritual'))
);
--> statement-breakpoint
ALTER TABLE "workspace"."release_check" ADD COLUMN "completion_check_id" uuid;--> statement-breakpoint
ALTER TABLE "github"."installation_grant" ADD CONSTRAINT "installation_grant_installation_id_gh_installation_installation_id_fk" FOREIGN KEY ("installation_id") REFERENCES "github"."gh_installation"("installation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github"."repo_link" ADD CONSTRAINT "repo_link_installation_id_gh_installation_installation_id_fk" FOREIGN KEY ("installation_id") REFERENCES "github"."gh_installation"("installation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "installation_grant_team_user_idx" ON "github"."installation_grant" USING btree ("team_id","user_id") WHERE "github"."installation_grant"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "repo_check_team_idx" ON "github"."repo_check" USING btree ("team_id","kind","checked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "repo_link_repository_uq" ON "github"."repo_link" USING btree ("repository_id") WHERE "github"."repo_link"."status" IN ('active','completed');--> statement-breakpoint
CREATE UNIQUE INDEX "repo_link_team_active_uq" ON "github"."repo_link" USING btree ("team_id") WHERE "github"."repo_link"."status" = 'active';--> statement-breakpoint
CREATE INDEX "repo_link_installation_idx" ON "github"."repo_link" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "gh_item_repo_received_idx" ON "github"."gh_item" USING btree ("repository_id","first_received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "gh_item_author_idx" ON "github"."gh_item" USING btree ("author_github_id");--> statement-breakpoint
CREATE INDEX "webhook_delivery_pending_idx" ON "github"."webhook_delivery" USING btree ("received_at") WHERE "github"."webhook_delivery"."status" = 'received';--> statement-breakpoint
CREATE INDEX "webhook_delivery_received_idx" ON "github"."webhook_delivery" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "completion_check_team_idx" ON "workspace"."completion_check" USING btree ("team_id","requested_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "project_completion_completed_idx" ON "workspace"."project_completion" USING btree ("completed_at","team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contribution_uq" ON "workspace"."contribution" USING btree ("team_id","source","ref","user_id");--> statement-breakpoint
CREATE INDEX "contribution_stage_user_idx" ON "workspace"."contribution" USING btree ("team_id","stage_ordinal","user_id");--> statement-breakpoint
CREATE INDEX "contribution_feed_idx" ON "workspace"."contribution" USING btree ("team_id","received_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "release_check_completion_idx" ON "workspace"."release_check" USING btree ("completion_check_id") WHERE "workspace"."release_check"."completion_check_id" IS NOT NULL;--> statement-breakpoint
-- CC-13, architecture 10.1: the snapshot of a completed project never changes (S6-08 relies on it).
CREATE FUNCTION "workspace"."project_completion_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'workspace.project_completion is immutable' USING ERRCODE = 'integrity_constraint_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "project_completion_immutable_trg" BEFORE UPDATE ON "workspace"."project_completion" FOR EACH ROW EXECUTE FUNCTION "workspace"."project_completion_immutable"();--> statement-breakpoint
-- The application role `tf_app` gets DML only (docker/postgres/10-roles.sh). Default privileges already
-- cover tables created by the migrator; the explicit grant keeps the migration correct where they are not set.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tf_app') THEN
		GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "github" TO tf_app;
		GRANT SELECT, INSERT, UPDATE, DELETE ON "workspace"."contribution", "workspace"."completion_check", "workspace"."project_completion" TO tf_app;
	END IF;
END
$$;
