CREATE TABLE "auth"."account" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"account_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"password" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."consent" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"version" text NOT NULL,
	"text_hash" "bytea" NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"ip_hash" "bytea",
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "auth"."deletion_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"request_id" uuid NOT NULL,
	"module" text NOT NULL,
	"action" text NOT NULL,
	"counts" jsonb NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."deletion_request" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"cancel_token_hash" "bytea",
	"deadline_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "deletion_request_reason_check" CHECK ("auth"."deletion_request"."reason" IN ('user_request','consent_revoked')),
	CONSTRAINT "deletion_request_status_check" CHECK ("auth"."deletion_request"."status" IN ('requested','in_progress','completed','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "auth"."deletion_step" (
	"request_id" uuid NOT NULL,
	"module" text NOT NULL,
	"done_at" timestamp with time zone NOT NULL,
	CONSTRAINT "deletion_step_pkey" PRIMARY KEY("request_id","module")
);
--> statement-breakpoint
CREATE TABLE "auth"."identity_signal" (
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value_hmac" "bytea" NOT NULL,
	"first_seen" timestamp with time zone NOT NULL,
	"last_seen" timestamp with time zone NOT NULL,
	CONSTRAINT "identity_signal_pkey" PRIMARY KEY("user_id","kind","value_hmac"),
	CONSTRAINT "identity_signal_kind_check" CHECK ("auth"."identity_signal"."kind" IN ('ip24','ua','device'))
);
--> statement-breakpoint
CREATE TABLE "auth"."identity_tombstone" (
	"kind" text NOT NULL,
	"value_hmac" "bytea" NOT NULL,
	"deleted_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "identity_tombstone_pkey" PRIMARY KEY("kind","value_hmac"),
	CONSTRAINT "identity_tombstone_kind_check" CHECK ("auth"."identity_tombstone"."kind" IN ('github_user_id','email_normalized'))
);
--> statement-breakpoint
CREATE TABLE "auth"."session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."user" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text,
	"email" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"email_normalized" text,
	"image" text,
	"github_user_id" bigint,
	"github_login" text,
	"status" text DEFAULT 'active' NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"locale" text DEFAULT 'ru' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "user_status_check" CHECK ("auth"."user"."status" IN ('active','deleting','deleted'))
);
--> statement-breakpoint
CREATE TABLE "auth"."verification" (
	"id" uuid PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth"."account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."consent" ADD CONSTRAINT "consent_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."deletion_log" ADD CONSTRAINT "deletion_log_request_id_deletion_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "auth"."deletion_request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."deletion_step" ADD CONSTRAINT "deletion_step_request_id_deletion_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "auth"."deletion_request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."identity_signal" ADD CONSTRAINT "identity_signal_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_account_uq" ON "auth"."account" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "account_user_idx" ON "auth"."account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "consent_user_idx" ON "auth"."consent" USING btree ("user_id","accepted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "deletion_request_open_uq" ON "auth"."deletion_request" USING btree ("user_id") WHERE "auth"."deletion_request"."status" IN ('requested','in_progress');--> statement-breakpoint
CREATE UNIQUE INDEX "deletion_request_cancel_uq" ON "auth"."deletion_request" USING btree ("cancel_token_hash") WHERE "auth"."deletion_request"."cancel_token_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "deletion_request_scheduled_idx" ON "auth"."deletion_request" USING btree ("scheduled_at") WHERE "auth"."deletion_request"."status" = 'requested';--> statement-breakpoint
CREATE INDEX "identity_signal_value_idx" ON "auth"."identity_signal" USING btree ("kind","value_hmac","last_seen");--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_uq" ON "auth"."session" USING btree ("token");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "auth"."session" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_normalized_uq" ON "auth"."user" USING btree ("email_normalized") WHERE "auth"."user"."email_normalized" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "user_github_user_id_uq" ON "auth"."user" USING btree ("github_user_id") WHERE "auth"."user"."github_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "auth"."verification" USING btree ("identifier");