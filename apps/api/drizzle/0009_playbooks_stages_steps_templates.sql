CREATE TABLE "playbooks"."platform_template" (
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"body_md" text NOT NULL,
	CONSTRAINT "platform_template_pkey" PRIMARY KEY("key","version")
);
--> statement-breakpoint
CREATE TABLE "playbooks"."stage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"playbook_id" uuid NOT NULL,
	"key" text NOT NULL,
	"ordinal" smallint NOT NULL,
	"title" text NOT NULL,
	"goal" text NOT NULL,
	"duration_days" integer NOT NULL,
	"exit_criteria" text NOT NULL,
	CONSTRAINT "stage_playbook_ordinal_uq" UNIQUE("playbook_id","ordinal"),
	CONSTRAINT "stage_playbook_key_uq" UNIQUE("playbook_id","key"),
	CONSTRAINT "stage_duration_days_check" CHECK ("playbooks"."stage"."duration_days" > 0)
);
--> statement-breakpoint
CREATE TABLE "playbooks"."step" (
	"id" uuid PRIMARY KEY NOT NULL,
	"playbook_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"key" text NOT NULL,
	"ordinal" smallint NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"kind" text NOT NULL,
	"submission" text,
	"ritual_kind" text,
	"required" boolean NOT NULL,
	"owner_role" text NOT NULL,
	"alt_roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"review_checklist" boolean NOT NULL,
	"auto_checks" text[] DEFAULT '{}'::text[] NOT NULL,
	"sources" text[] NOT NULL,
	CONSTRAINT "step_playbook_key_uq" UNIQUE("playbook_id","key"),
	CONSTRAINT "step_stage_ordinal_uq" UNIQUE("stage_id","ordinal"),
	CONSTRAINT "step_kind_check" CHECK ("playbooks"."step"."kind" IN ('artifact','ritual')),
	CONSTRAINT "step_submission_check" CHECK ("playbooks"."step"."submission" IN ('link','file','either')),
	CONSTRAINT "step_ritual_kind_check" CHECK ("playbooks"."step"."ritual_kind" IN ('call','retro','brainstorm','code_review')),
	CONSTRAINT "step_kind_submission_check" CHECK (("playbooks"."step"."kind" = 'artifact') = ("playbooks"."step"."submission" IS NOT NULL)),
	CONSTRAINT "step_kind_ritual_check" CHECK (("playbooks"."step"."kind" = 'ritual') = ("playbooks"."step"."ritual_kind" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "playbooks"."step_fallback" (
	"step_id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"instruction" text NOT NULL,
	"template_key" text NOT NULL,
	"url" text
);
--> statement-breakpoint
CREATE TABLE "playbooks"."step_review_item" (
	"step_id" uuid NOT NULL,
	"ordinal" smallint NOT NULL,
	"text" text NOT NULL,
	CONSTRAINT "step_review_item_pkey" PRIMARY KEY("step_id","ordinal")
);
--> statement-breakpoint
ALTER TABLE "playbooks"."stage" ADD CONSTRAINT "stage_playbook_id_playbook_id_fk" FOREIGN KEY ("playbook_id") REFERENCES "playbooks"."playbook"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbooks"."step" ADD CONSTRAINT "step_playbook_id_playbook_id_fk" FOREIGN KEY ("playbook_id") REFERENCES "playbooks"."playbook"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbooks"."step" ADD CONSTRAINT "step_stage_id_stage_id_fk" FOREIGN KEY ("stage_id") REFERENCES "playbooks"."stage"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbooks"."step_fallback" ADD CONSTRAINT "step_fallback_step_id_step_id_fk" FOREIGN KEY ("step_id") REFERENCES "playbooks"."step"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbooks"."step_review_item" ADD CONSTRAINT "step_review_item_step_id_step_id_fk" FOREIGN KEY ("step_id") REFERENCES "playbooks"."step"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Immutability of a published playbook (architecture 5.4): a second line of defence behind the service,
-- which never updates a published row. A draft may be built (INSERT) and published (status UPDATE) once.
CREATE FUNCTION "playbooks"."reject_published_playbook_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF OLD.status = 'published' THEN
		RAISE EXCEPTION 'published playbook % is immutable', OLD.id USING ERRCODE = 'integrity_constraint_violation';
	END IF;
	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "playbook_immutable_trg" BEFORE UPDATE OR DELETE ON "playbooks"."playbook"
	FOR EACH ROW EXECUTE FUNCTION "playbooks"."reject_published_playbook_change"();
--> statement-breakpoint
CREATE FUNCTION "playbooks"."reject_published_playbook_child_change"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	owner_ids uuid[];
	step_ids uuid[];
BEGIN
	IF TG_TABLE_NAME IN ('stage', 'step') THEN
		owner_ids := ARRAY[]::uuid[];
		IF TG_OP IN ('UPDATE', 'DELETE') THEN owner_ids := owner_ids || OLD.playbook_id; END IF;
		IF TG_OP IN ('UPDATE', 'INSERT') THEN owner_ids := owner_ids || NEW.playbook_id; END IF;
	ELSE
		IF TG_OP = 'DELETE' THEN
			step_ids := ARRAY[OLD.step_id];
		ELSIF TG_OP = 'INSERT' THEN
			step_ids := ARRAY[NEW.step_id];
		ELSE
			step_ids := ARRAY[OLD.step_id, NEW.step_id];
		END IF;
		SELECT coalesce(array_agg(s.playbook_id), ARRAY[]::uuid[]) INTO owner_ids
		FROM "playbooks"."step" s WHERE s.id = ANY (step_ids);
	END IF;
	IF EXISTS (
		SELECT 1 FROM "playbooks"."playbook" p WHERE p.id = ANY (owner_ids) AND p.status = 'published'
	) THEN
		RAISE EXCEPTION 'rows of a published playbook are immutable (%)', TG_TABLE_NAME
			USING ERRCODE = 'integrity_constraint_violation';
	END IF;
	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "stage_immutable_trg" BEFORE INSERT OR UPDATE OR DELETE ON "playbooks"."stage"
	FOR EACH ROW EXECUTE FUNCTION "playbooks"."reject_published_playbook_child_change"();
--> statement-breakpoint
CREATE TRIGGER "step_immutable_trg" BEFORE INSERT OR UPDATE OR DELETE ON "playbooks"."step"
	FOR EACH ROW EXECUTE FUNCTION "playbooks"."reject_published_playbook_child_change"();
--> statement-breakpoint
CREATE TRIGGER "step_review_item_immutable_trg" BEFORE INSERT OR UPDATE OR DELETE ON "playbooks"."step_review_item"
	FOR EACH ROW EXECUTE FUNCTION "playbooks"."reject_published_playbook_child_change"();
--> statement-breakpoint
CREATE TRIGGER "step_fallback_immutable_trg" BEFORE INSERT OR UPDATE OR DELETE ON "playbooks"."step_fallback"
	FOR EACH ROW EXECUTE FUNCTION "playbooks"."reject_published_playbook_child_change"();
