import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveRuntimeAuthorityValue,
  resolveRuntimeDatabaseAuthority,
} from "./runtime-database-environment.ts";

test("resolves one mode-exact Runtime database authority", () => {
  assert.deepEqual(
    resolveRuntimeDatabaseAuthority(
      { CREWON_CONTROL_DB_PATH: "/tmp/control.sqlite" },
      "standalone",
    ),
    { mode: "standalone", databasePath: "/tmp/control.sqlite" },
  );
  assert.deepEqual(
    resolveRuntimeDatabaseAuthority(
      {
        CREWON_CONTROL_DATABASE_URL: "postgresql://db.example/crewon",
        CREWON_CONTROL_DATABASE_SCHEMA: "tenant_runtime",
      },
      "production",
    ),
    {
      mode: "production",
      connectionString: "postgresql://db.example/crewon",
      schema: "tenant_runtime",
    },
  );
});

test("rejects missing and cross-mode Runtime database authority", () => {
  assert.throws(
    () => resolveRuntimeDatabaseAuthority({}, "standalone"),
    new Error("CREWON_CONTROL_DB_PATH_required"),
  );
  assert.throws(
    () =>
      resolveRuntimeDatabaseAuthority(
        {
          CREWON_CONTROL_DB_PATH: "/tmp/control.sqlite",
          CREWON_CONTROL_DATABASE_URL: "postgresql://db.example/crewon",
        },
        "standalone",
      ),
    new Error("CREWON_CONTROL_DATABASE_URL_forbidden"),
  );
  assert.throws(
    () =>
      resolveRuntimeDatabaseAuthority(
        {
          CREWON_CONTROL_DATABASE_URL: "postgresql://db.example/crewon",
          CREWON_CONTROL_DATABASE_SCHEMA: "tenant_runtime",
          CREWON_CONTROL_DB_PATH: "/tmp/control.sqlite",
        },
        "production",
      ),
    new Error("CREWON_CONTROL_DB_PATH_forbidden"),
  );
  assert.throws(
    () =>
      resolveRuntimeDatabaseAuthority(
        { CREWON_CONTROL_DATABASE_URL: "postgresql://db.example/crewon" },
        "production",
      ),
    new Error("CREWON_CONTROL_DATABASE_SCHEMA_required"),
  );
});

test("validates the production PostgreSQL URL and schema before Store open", () => {
  assert.throws(
    () =>
      resolveRuntimeDatabaseAuthority(
        {
          CREWON_CONTROL_DATABASE_URL: "https://db.example/crewon",
          CREWON_CONTROL_DATABASE_SCHEMA: "tenant_runtime",
        },
        "production",
      ),
    new Error("CREWON_CONTROL_DATABASE_URL_invalid"),
  );
  assert.throws(
    () =>
      resolveRuntimeDatabaseAuthority(
        {
          CREWON_CONTROL_DATABASE_URL: "postgresql://db.example/crewon",
          CREWON_CONTROL_DATABASE_SCHEMA: "Tenant-Runtime",
        },
        "production",
      ),
    new Error("CREWON_CONTROL_DATABASE_SCHEMA_invalid"),
  );
});

test("permits authority defaults only in standalone mode", () => {
  assert.equal(
    resolveRuntimeAuthorityValue(
      {},
      "standalone",
      "CREWON_TENANT_ID",
      "standalone-tenant",
    ),
    "standalone-tenant",
  );
  assert.equal(
    resolveRuntimeAuthorityValue(
      { CREWON_TENANT_ID: "tenant-production" },
      "production",
      "CREWON_TENANT_ID",
      "standalone-tenant",
    ),
    "tenant-production",
  );
  assert.throws(
    () =>
      resolveRuntimeAuthorityValue(
        {},
        "production",
        "CREWON_TENANT_ID",
        "standalone-tenant",
      ),
    new Error("CREWON_TENANT_ID_required"),
  );
  assert.throws(
    () =>
      resolveRuntimeAuthorityValue(
        { CREWON_TENANT_ID: "standalone-tenant" },
        "production",
        "CREWON_TENANT_ID",
        "standalone-tenant",
      ),
    new Error("CREWON_TENANT_ID_standalone_default_forbidden"),
  );
});
