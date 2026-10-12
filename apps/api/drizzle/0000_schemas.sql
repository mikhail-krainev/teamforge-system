CREATE SCHEMA "auth";
--> statement-breakpoint
CREATE SCHEMA "github";
--> statement-breakpoint
CREATE SCHEMA "matching";
--> statement-breakpoint
CREATE SCHEMA "playbooks";
--> statement-breakpoint
CREATE SCHEMA "profiles";
--> statement-breakpoint
CREATE SCHEMA "rewards";
--> statement-breakpoint
CREATE SCHEMA "teams";
--> statement-breakpoint
CREATE SCHEMA "workspace";
--> statement-breakpoint
-- IF NOT EXISTS: the migrator creates the schema first, it also holds the journal table.
CREATE SCHEMA IF NOT EXISTS "platform";
--> statement-breakpoint
CREATE TABLE "platform"."event_dead_letter" (
	"consumer" text NOT NULL,
	"event_id" uuid NOT NULL,
	"type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"error" text NOT NULL,
	"attempts" smallint NOT NULL,
	"failed_at" timestamp with time zone NOT NULL,
	"replayed_at" timestamp with time zone,
	CONSTRAINT "event_dead_letter_pkey" PRIMARY KEY("consumer","event_id")
);
--> statement-breakpoint
CREATE TABLE "platform"."idempotency_key" (
	"user_id" uuid NOT NULL,
	"key" uuid NOT NULL,
	"operation_id" text NOT NULL,
	"request_hash" "bytea" NOT NULL,
	"status" text NOT NULL,
	"locked_until" timestamp with time zone NOT NULL,
	"lock_token" uuid NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_key_pkey" PRIMARY KEY("user_id","key"),
	CONSTRAINT "idempotency_key_status_check" CHECK ("platform"."idempotency_key"."status" IN ('in_progress','completed'))
);
--> statement-breakpoint
CREATE TABLE "platform"."inbox_event" (
	"consumer" text NOT NULL,
	"event_id" uuid NOT NULL,
	"processed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "inbox_event_pkey" PRIMARY KEY("consumer","event_id")
);
--> statement-breakpoint
CREATE TABLE "platform"."outbox_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"module" text NOT NULL,
	"type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"request_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "event_dead_letter_open_idx" ON "platform"."event_dead_letter" USING btree ("failed_at") WHERE "platform"."event_dead_letter"."replayed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idempotency_key_expires_idx" ON "platform"."idempotency_key" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx" ON "platform"."outbox_event" USING btree ("id") WHERE "platform"."outbox_event"."published_at" IS NULL;--> statement-breakpoint
CREATE INDEX "outbox_published_at_idx" ON "platform"."outbox_event" USING btree ("published_at") WHERE "platform"."outbox_event"."published_at" IS NOT NULL;