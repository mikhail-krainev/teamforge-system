ALTER TABLE "github"."repo_sync_state" ADD COLUMN "issues_resume_page" integer;--> statement-breakpoint
ALTER TABLE "github"."repo_sync_state" ADD COLUMN "pulls_resume_page" integer;--> statement-breakpoint
ALTER TABLE "github"."repo_sync_state" ADD COLUMN "pending_sync_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "teams"."team" ADD COLUMN "release_key" text;--> statement-breakpoint
CREATE INDEX "repo_link_team_idx" ON "github"."repo_link" USING btree ("team_id","linked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "team_release_key_idx" ON "teams"."team" USING btree ("release_key") WHERE "teams"."team"."release_key" IS NOT NULL;--> statement-breakpoint
-- AF-02 (S6SEC-03): the normalized release address, kept by the database so every write path of
-- `release_url` (the application, a repair script, a test) leaves the key right. The key is
-- `host/path` of the address: no scheme, user, port, query or fragment; the host in lower case without
-- a leading `www.` and a trailing dot; the path percent-decoded, in lower case, without `.` and `..`
-- segments, empty segments, a final `index.html` / `index.htm` and a final slash. NULL for text that is no address.
CREATE FUNCTION "teams"."release_address_key"(address text) RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE
	rest text;
	authority text;
	host text;
	path text;
	decoded text := '';
	found text[];
	pos integer;
	segment text;
	kept text[] := ARRAY[]::text[];
BEGIN
	IF address IS NULL THEN
		RETURN NULL;
	END IF;
	-- URL parsers drop tabs and line breaks and read a backslash as a slash.
	rest := replace(regexp_replace(address, '[\t\r\n]', '', 'g'), '\', '/');
	IF rest !~* '^[a-z][a-z0-9+.-]*://[^/?#]' THEN
		RETURN NULL;
	END IF;
	rest := regexp_replace(rest, '^[a-zA-Z][a-zA-Z0-9+.-]*://', '');
	rest := split_part(split_part(rest, '#', 1), '?', 1);
	authority := split_part(rest, '/', 1);
	path := substr(rest, length(authority) + 1);
	authority := regexp_replace(authority, '^.*@', '');
	IF authority LIKE '[%' THEN
		host := regexp_replace(authority, '\].*$', ']');
	ELSE
		host := regexp_replace(authority, ':.*$', '');
	END IF;
	host := regexp_replace(regexp_replace(lower(host), '\.$', ''), '^www\.', '');
	IF host = '' THEN
		RETURN NULL;
	END IF;
	-- Percent-encoded runs are decoded as UTF-8; a run that is no valid text stays as it is.
	LOOP
		found := regexp_match(path, '(?:%[0-9A-Fa-f]{2})+');
		EXIT WHEN found IS NULL;
		pos := strpos(path, found[1]);
		BEGIN
			segment := convert_from(decode(replace(found[1], '%', ''), 'hex'), 'UTF8');
		EXCEPTION WHEN others THEN
			segment := found[1];
		END;
		decoded := decoded || substr(path, 1, pos - 1) || segment;
		path := substr(path, pos + length(found[1]));
	END LOOP;
	path := lower(decoded || path);
	FOREACH segment IN ARRAY string_to_array(path, '/') LOOP
		IF segment = '..' THEN
			kept := kept[1:coalesce(array_length(kept, 1), 0) - 1];
		ELSIF segment <> '' AND segment <> '.' THEN
			kept := array_append(kept, segment);
		END IF;
	END LOOP;
	IF coalesce(array_length(kept, 1), 0) > 0 AND kept[array_length(kept, 1)] IN ('index.html', 'index.htm') THEN
		kept := kept[1:array_length(kept, 1) - 1];
	END IF;
	RETURN host || CASE WHEN coalesce(array_length(kept, 1), 0) > 0 THEN '/' || array_to_string(kept, '/') ELSE '' END;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "teams"."team_release_key"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	NEW.release_key := "teams"."release_address_key"(NEW.release_url);
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "team_release_key_trg" BEFORE INSERT OR UPDATE OF "release_url" ON "teams"."team" FOR EACH ROW EXECUTE FUNCTION "teams"."team_release_key"();--> statement-breakpoint
-- Teams that already have an address get their key now.
UPDATE "teams"."team" SET "release_key" = "teams"."release_address_key"("release_url") WHERE "release_url" IS NOT NULL;
