CREATE TABLE "profiles"."profile" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"timezone" text NOT NULL,
	"hours_per_week" smallint NOT NULL,
	"portfolio_url" text,
	"strengths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"weaknesses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"text_fingerprint" "bytea",
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "profile_display_name_check" CHECK (char_length("profiles"."profile"."display_name") BETWEEN 2 AND 60),
	CONSTRAINT "profile_hours_check" CHECK ("profiles"."profile"."hours_per_week" BETWEEN 3 AND 40)
);
--> statement-breakpoint
CREATE TABLE "profiles"."profile_experience" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"period_from" date NOT NULL,
	"period_to" date,
	"ordinal" smallint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles"."profile_role_pref" (
	"user_id" uuid NOT NULL,
	"role_code" text NOT NULL,
	"level" text NOT NULL,
	"ordinal" smallint NOT NULL,
	CONSTRAINT "profile_role_pref_pkey" PRIMARY KEY("user_id","role_code"),
	CONSTRAINT "profile_role_pref_ordinal_uq" UNIQUE("user_id","ordinal") DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "profile_role_pref_level_check" CHECK ("profiles"."profile_role_pref"."level" IN ('beginner','junior','middle'))
);
--> statement-breakpoint
CREATE TABLE "profiles"."profile_stack" (
	"user_id" uuid NOT NULL,
	"stack_tag_code" text NOT NULL,
	CONSTRAINT "profile_stack_pkey" PRIMARY KEY("user_id","stack_tag_code")
);
--> statement-breakpoint
CREATE TABLE "profiles"."resume_upload" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"storage_key" text,
	"mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" "bytea" NOT NULL,
	"status" text NOT NULL,
	"failure_reason" text,
	"extracted_text" text,
	"suggestions" jsonb,
	"keep_file" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "resume_upload_status_check" CHECK ("profiles"."resume_upload"."status" IN ('queued','processing','done','failed'))
);
--> statement-breakpoint
CREATE TABLE "profiles"."role" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"ordinal" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles"."stack_tag" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profiles"."profile_experience" ADD CONSTRAINT "profile_experience_user_id_profile_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "profiles"."profile"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles"."profile_role_pref" ADD CONSTRAINT "profile_role_pref_user_id_profile_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "profiles"."profile"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles"."profile_role_pref" ADD CONSTRAINT "profile_role_pref_role_code_role_code_fk" FOREIGN KEY ("role_code") REFERENCES "profiles"."role"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles"."profile_stack" ADD CONSTRAINT "profile_stack_user_id_profile_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "profiles"."profile"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles"."profile_stack" ADD CONSTRAINT "profile_stack_stack_tag_code_stack_tag_code_fk" FOREIGN KEY ("stack_tag_code") REFERENCES "profiles"."stack_tag"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "profile_text_fp_idx" ON "profiles"."profile" USING btree ("text_fingerprint");--> statement-breakpoint
CREATE INDEX "profile_experience_user_idx" ON "profiles"."profile_experience" USING btree ("user_id","ordinal");--> statement-breakpoint
CREATE INDEX "profile_role_pref_role_idx" ON "profiles"."profile_role_pref" USING btree ("role_code","level");--> statement-breakpoint
CREATE INDEX "resume_upload_user_idx" ON "profiles"."resume_upload" USING btree ("user_id","created_at" DESC NULLS LAST);