-- A team that has not started yet and is pinned to a stub playbook (0.0.1, no stages) cannot get a route:
-- the start of such a project fails. Moves it to the latest published playbook of its product type that
-- has stages. Idempotent; a no-op while only the stubs exist (the real ones are loaded by playbooks:load,
-- which repeats this move after every published playbook).
UPDATE "teams"."team" AS t
   SET "playbook_id" = (
         SELECT p."id"
           FROM "playbooks"."playbook" AS p
          WHERE p."product_type_code" = t."product_type_code"
            AND p."status" = 'published'
            AND EXISTS (SELECT 1 FROM "playbooks"."stage" AS s WHERE s."playbook_id" = p."id")
          ORDER BY p."v_major" DESC, p."v_minor" DESC, p."v_patch" DESC
          LIMIT 1
       ),
       "version" = t."version" + 1,
       "updated_at" = now()
 WHERE t."status" = 'forming'
   AND EXISTS (
         SELECT 1 FROM "playbooks"."playbook" AS stub
          WHERE stub."id" = t."playbook_id" AND stub."source_text" = 'stub')
   AND EXISTS (
         SELECT 1
           FROM "playbooks"."playbook" AS p
          WHERE p."product_type_code" = t."product_type_code"
            AND p."status" = 'published'
            AND EXISTS (SELECT 1 FROM "playbooks"."stage" AS s WHERE s."playbook_id" = p."id"));
