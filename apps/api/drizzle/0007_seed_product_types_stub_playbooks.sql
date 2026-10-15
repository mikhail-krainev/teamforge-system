-- Seed of the product types (FR-PLAY-06: two active in the MVP) and stub playbooks 0.0.1, so a team can
-- pin a playbook before slice 5 loads the real 1.0.0 ones. Idempotent. The stubs are published with
-- the total_days of the real playbooks; version 0.0.1 stays below any 1.0.0 loaded later.
INSERT INTO "playbooks"."product_type" ("code", "name", "active") VALUES
	('web_service', 'Веб-сервис', true),
	('ml_product', 'ML-продукт', true)
ON CONFLICT ("code") DO NOTHING;
--> statement-breakpoint
INSERT INTO "playbooks"."playbook"
	("id", "product_type_code", "title", "version", "v_major", "v_minor", "v_patch", "status",
	 "total_days", "source_text", "source_sha256", "uploaded_by", "published_at")
VALUES
	('00000000-0000-7000-8000-0000000a0001', 'web_service', 'Веб-сервис (заглушка)', '0.0.1', 0, 0, 1,
	 'published', 84, 'stub', sha256(convert_to('stub', 'UTF8')),
	 '00000000-0000-0000-0000-000000000000', '2026-01-01T00:00:00Z'),
	('00000000-0000-7000-8000-0000000a0002', 'ml_product', 'ML-продукт (заглушка)', '0.0.1', 0, 0, 1,
	 'published', 91, 'stub', sha256(convert_to('stub', 'UTF8')),
	 '00000000-0000-0000-0000-000000000000', '2026-01-01T00:00:00Z')
ON CONFLICT ("product_type_code", "version") DO NOTHING;
