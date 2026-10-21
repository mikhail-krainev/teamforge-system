-- S6-12, CC-13: the snapshot of a completed project is never removed either. Migration 0015 refused only
-- UPDATE, while `tf_app` holds DELETE on the table; the same trigger function now guards both.
DROP TRIGGER "project_completion_immutable_trg" ON "workspace"."project_completion";--> statement-breakpoint
CREATE TRIGGER "project_completion_immutable_trg" BEFORE UPDATE OR DELETE ON "workspace"."project_completion" FOR EACH ROW EXECUTE FUNCTION "workspace"."project_completion_immutable"();
