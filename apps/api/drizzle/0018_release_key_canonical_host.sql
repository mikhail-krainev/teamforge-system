-- R-1 (re-review of slice 6): the application now stores the release address in the form of the WHATWG
-- URL parser (`new URL(raw).href`: host in lower case and punycode, percent-encoding and full-width or
-- ideographic dots in the host resolved), and the key function also cuts leading and trailing spaces.
-- The function is pure, so it is IMMUTABLE (R-8); the keys of the existing rows are made again.
CREATE OR REPLACE FUNCTION "teams"."release_address_key"(address text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
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
	-- URL parsers cut leading and trailing spaces and control characters, drop tabs and line breaks
	-- inside, and read a backslash as a slash.
	rest := replace(regexp_replace(regexp_replace(address, '^[\x01-\x20]+|[\x01-\x20]+$', '', 'g'), '[\t\r\n]', '', 'g'), '\', '/');
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
UPDATE "teams"."team" SET "release_key" = "teams"."release_address_key"("release_url") WHERE "release_url" IS NOT NULL;
