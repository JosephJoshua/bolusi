#!/bin/sh
# Stamps THIS cluster's databases with the compose project that owns them (T-14d).
#
# Why a stamp exists at all: this repo's dev daemon is shared by every worktree. A test lane
# that merely *believes* it reached its own database has already shipped a fake green here —
# task 13's "82/11 on real PG16" was served by task 05's container after an unread `db:up`
# failure. So attribution is ASSERTED, not assumed: the db-server test lane reads this stamp
# and aborts unless it matches the project it provisioned.
#
# Why a database-level GUC rather than a table:
#   - it survives the test harness's `DROP SCHEMA public CASCADE` reset (a table in `public`
#     would be erased by the first test file, and an absent stamp is indistinguishable from a
#     foreign one — the guard would be blind exactly when it matters);
#   - it is invisible to kysely-codegen and to the SEC-TENANT-01 catalog sweep, so the guard
#     cannot perturb the schema it is guarding.
#
# Runs once, at cluster init, from the postgres image's entrypoint — AFTER 01-create-databases.
# Provisioning (writing the stamp) and verification (reading it) are deliberately separate:
# nothing in the test lane may ever write a stamp, or a foreign database could be adopted by
# the very run that was supposed to detect it.
set -eu

: "${BOLUSI_DB_OWNER:?pg-init: BOLUSI_DB_OWNER is unset — start this database with 'pnpm db:up', which supplies the compose project name}"

# The stamp is interpolated into SQL below. Compose project names are already restricted to
# [a-z0-9][a-z0-9_-]*, but this is the one place an unvalidated value would reach a psql -c
# string, so re-check it here rather than trust the caller.
if ! printf '%s' "$BOLUSI_DB_OWNER" | grep -Eq '^[a-z0-9][a-z0-9_-]*$'; then
  echo "pg-init: refusing to stamp — BOLUSI_DB_OWNER '$BOLUSI_DB_OWNER' is not a valid compose project name" >&2
  exit 1
fi

for db in bolusi_dev bolusi_rls_test; do
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c \
    "ALTER DATABASE $db SET bolusi.db_owner = '$BOLUSI_DB_OWNER'"
  echo "pg-init: stamped $db with bolusi.db_owner = $BOLUSI_DB_OWNER"
done
