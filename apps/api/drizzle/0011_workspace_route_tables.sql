CREATE TABLE "workspace"."artifact_file" (
	"id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"checklist_item_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" "bytea" NOT NULL,
	"size_bytes" integer NOT NULL,
	"mime" text NOT NULL,
	"original_name" text NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "artifact_file_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "artifact_file_size_check" CHECK ("workspace"."artifact_file"."size_bytes" >= 1024)
);
--> statement-breakpoint
CREATE TABLE "workspace"."project_storage_usage" (
	"team_id" uuid PRIMARY KEY NOT NULL,
	"files_count" integer DEFAULT 0 NOT NULL,
	"bytes_total" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "project_storage_usage_files_check" CHECK ("workspace"."project_storage_usage"."files_count" BETWEEN 0 AND 30),
	CONSTRAINT "project_storage_usage_bytes_check" CHECK ("workspace"."project_storage_usage"."bytes_total" BETWEEN 0 AND 52428800)
);
--> statement-breakpoint
CREATE TABLE "workspace"."review_answer" (
	"checklist_item_id" uuid NOT NULL,
	"ordinal" smallint NOT NULL,
	"reviewer_user_id" uuid NOT NULL,
	"answer" boolean NOT NULL,
	"answered_at" timestamp with time zone NOT NULL,
	CONSTRAINT "review_answer_checklist_item_id_ordinal_pk" PRIMARY KEY("checklist_item_id","ordinal")
);
--> statement-breakpoint
CREATE TABLE "workspace"."review_risk" (
	"checklist_item_id" uuid NOT NULL,
	"ordinal" smallint NOT NULL,
	"reason" text NOT NULL,
	"accepted_by" uuid NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "review_risk_checklist_item_id_ordinal_pk" PRIMARY KEY("checklist_item_id","ordinal")
);
--> statement-breakpoint
CREATE TABLE "workspace"."participation_confirm" (
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"stage_ordinal" smallint NOT NULL,
	"confirmed_by" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "participation_confirm_team_id_user_id_stage_ordinal_pk" PRIMARY KEY("team_id","user_id","stage_ordinal")
);
--> statement-breakpoint
CREATE TABLE "workspace"."release_check" (
	"id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"url" text NOT NULL,
	"check_key" text NOT NULL,
	"ok" boolean NOT NULL,
	"http_status" integer,
	"reason" text,
	"checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "release_check_reason_check" CHECK ("workspace"."release_check"."reason" IN ('HTTP_STATUS','TOO_SMALL','PLACEHOLDER_TITLE','TIMEOUT','BLOCKED_ADDRESS','BLOCKED_PORT','TLS_ERROR','TOO_MANY_REDIRECTS','DNS_ERROR'))
);
--> statement-breakpoint
CREATE TABLE "workspace"."checklist_item" (
	"id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"project_stage_id" uuid NOT NULL,
	"step_key" text NOT NULL,
	"kind" text NOT NULL,
	"submission" text,
	"ritual_kind" text,
	"required" boolean NOT NULL,
	"owner_role" text NOT NULL,
	"alt_roles" text[] NOT NULL,
	"status" text NOT NULL,
	"assignee_user_id" uuid,
	"role_code" text,
	"fallback_used" boolean DEFAULT false NOT NULL,
	"link_url" text,
	"link_status" text DEFAULT 'none' NOT NULL,
	"link_checked_at" timestamp with time zone,
	"held_on" date,
	"external_url" text,
	"outcome" text,
	"done_by" uuid,
	"done_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "checklist_item_stage_step_uq" UNIQUE("project_stage_id","step_key"),
	CONSTRAINT "checklist_item_status_check" CHECK ("workspace"."checklist_item"."status" IN ('open','done')),
	CONSTRAINT "checklist_item_link_status_check" CHECK ("workspace"."checklist_item"."link_status" IN ('none','unchecked','ok','broken','rejected'))
);
--> statement-breakpoint
CREATE TABLE "workspace"."project_stage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"stage_key" text NOT NULL,
	"ordinal" smallint NOT NULL,
	"title" text NOT NULL,
	"duration_days" integer NOT NULL,
	"status" text NOT NULL,
	"opened_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "project_stage_team_ordinal_uq" UNIQUE("team_id","ordinal"),
	CONSTRAINT "project_stage_status_check" CHECK ("workspace"."project_stage"."status" IN ('pending','open','closed'))
);
--> statement-breakpoint
ALTER TABLE "workspace"."artifact_file" ADD CONSTRAINT "artifact_file_checklist_item_id_checklist_item_id_fk" FOREIGN KEY ("checklist_item_id") REFERENCES "workspace"."checklist_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace"."review_answer" ADD CONSTRAINT "review_answer_checklist_item_id_checklist_item_id_fk" FOREIGN KEY ("checklist_item_id") REFERENCES "workspace"."checklist_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace"."review_risk" ADD CONSTRAINT "review_risk_checklist_item_id_checklist_item_id_fk" FOREIGN KEY ("checklist_item_id") REFERENCES "workspace"."checklist_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace"."checklist_item" ADD CONSTRAINT "checklist_item_project_stage_id_project_stage_id_fk" FOREIGN KEY ("project_stage_id") REFERENCES "workspace"."project_stage"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_file_item_idx" ON "workspace"."artifact_file" USING btree ("checklist_item_id") WHERE "workspace"."artifact_file"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "artifact_file_sha_idx" ON "workspace"."artifact_file" USING btree ("sha256") WHERE "workspace"."artifact_file"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "release_check_team_idx" ON "workspace"."release_check" USING btree ("team_id","url","checked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "checklist_item_team_stage_idx" ON "workspace"."checklist_item" USING btree ("team_id","project_stage_id");--> statement-breakpoint
CREATE INDEX "checklist_item_assignee_idx" ON "workspace"."checklist_item" USING btree ("assignee_user_id") WHERE "workspace"."checklist_item"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "project_stage_one_open_uq" ON "workspace"."project_stage" USING btree ("team_id") WHERE "workspace"."project_stage"."status" = 'open';--> statement-breakpoint
CREATE INDEX "project_stage_due_idx" ON "workspace"."project_stage" USING btree ("due_at") WHERE "workspace"."project_stage"."status" = 'open';