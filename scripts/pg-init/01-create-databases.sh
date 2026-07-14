#!/bin/sh
# Creates the two dev databases (08-stack-and-repo §6.1): bolusi_dev + bolusi_rls_test.
# Idempotent: safe to re-run against an already-initialized cluster (task 01 acceptance).
set -eu

for db in bolusi_dev bolusi_rls_test; do
  if psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname = '$db'" | grep -q 1; then
    echo "pg-init: database $db already exists"
  else
    psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE $db"
    echo "pg-init: created database $db"
  fi
done
