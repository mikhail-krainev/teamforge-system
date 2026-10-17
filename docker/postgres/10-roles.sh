#!/bin/sh
# Runs once, on the first start of an empty data directory (docker-entrypoint-initdb.d).
# Creates the two database roles of the application (S1R-10, architecture 13.8):
#   tf_migrator  owns the database and its schemas; used ONLY by the `migrate` job (DDL).
#   tf_app       what api and worker connect as (through PgBouncer): DML on the objects of tf_migrator,
#                no SUPERUSER, no CREATEDB, no CREATEROLE, no DDL.
# The superuser (POSTGRES_USER) is used by this script and for administration, never by the application.
# Default privileges make every table, sequence and schema that tf_migrator creates later usable by
# tf_app. They are also set in template1, so databases cloned from it (the test databases) have them.
# TF_MIGRATOR_CREATEDB=1 is for the test stack only: tests create a database per test file as
# tf_migrator and drop it WITH (FORCE), which needs CREATEDB and pg_signal_backend.
: "${TF_MIGRATOR_PASSWORD:?TF_MIGRATOR_PASSWORD is required}"
: "${TF_APP_PASSWORD:?TF_APP_PASSWORD is required}"

createdb=NOCREATEDB
grant_signal="SELECT 1"
if [ "${TF_MIGRATOR_CREATEDB:-0}" = "1" ]; then
  createdb=CREATEDB
  grant_signal="GRANT pg_signal_backend TO tf_migrator"
fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v db="$POSTGRES_DB" -v createdb="$createdb" -v grant_signal="$grant_signal" \
  -v migrator_password="$TF_MIGRATOR_PASSWORD" -v app_password="$TF_APP_PASSWORD" <<'SQL'
CREATE ROLE tf_migrator LOGIN NOSUPERUSER NOCREATEROLE NOREPLICATION NOBYPASSRLS :createdb
  PASSWORD :'migrator_password';
CREATE ROLE tf_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD :'app_password';

ALTER DATABASE :"db" OWNER TO tf_migrator;
:grant_signal;
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO tf_app;

\connect template1
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE tf_migrator GRANT USAGE ON SCHEMAS TO tf_app;
ALTER DEFAULT PRIVILEGES FOR ROLE tf_migrator GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tf_app;
ALTER DEFAULT PRIVILEGES FOR ROLE tf_migrator GRANT USAGE, SELECT ON SEQUENCES TO tf_app;

\connect :"db"
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE tf_migrator GRANT USAGE ON SCHEMAS TO tf_app;
ALTER DEFAULT PRIVILEGES FOR ROLE tf_migrator GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tf_app;
ALTER DEFAULT PRIVILEGES FOR ROLE tf_migrator GRANT USAGE, SELECT ON SEQUENCES TO tf_app;
SQL
