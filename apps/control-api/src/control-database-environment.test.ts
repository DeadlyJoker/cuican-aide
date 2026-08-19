import assert from "node:assert/strict";
import test from "node:test";

import { resolveControlDatabaseAuthority } from "./control-database-environment.ts";

test("standalone Control requires SQLite and rejects PostgreSQL authority", () => {
  assert.deepEqual(
    resolveControlDatabaseAuthority(
      { CREWON_CONTROL_DB_PATH: "/tmp/crewon.sqlite" },
      "standalone",
    ),
    { mode: "standalone", databasePath: "/tmp/crewon.sqlite" },
  );
  assert.throws(
    () =>
      resolveControlDatabaseAuthority(
        {
          CREWON_CONTROL_DB_PATH: "/tmp/crewon.sqlite",
          CREWON_CONTROL_DATABASE_URL: "postgresql://localhost/crewon",
        },
        "standalone",
      ),
    /CREWON_CONTROL_DATABASE_URL_forbidden/,
  );
  assert.throws(
    () => resolveControlDatabaseAuthority({}, "standalone"),
    /CREWON_CONTROL_DB_PATH_required/,
  );
});

test("production Control requires one explicit PostgreSQL authority", () => {
  assert.deepEqual(
    resolveControlDatabaseAuthority(
      {
        CREWON_CONTROL_DATABASE_URL: "postgresql://localhost/crewon",
        CREWON_CONTROL_DATABASE_SCHEMA: "crewon_control",
      },
      "production",
    ),
    {
      mode: "production",
      connectionString: "postgresql://localhost/crewon",
      schema: "crewon_control",
    },
  );
  for (const environment of [
    {},
    { CREWON_CONTROL_DATABASE_URL: "postgresql://localhost/crewon" },
    {
      CREWON_CONTROL_DB_PATH: "/tmp/crewon.sqlite",
      CREWON_CONTROL_DATABASE_URL: "postgresql://localhost/crewon",
      CREWON_CONTROL_DATABASE_SCHEMA: "crewon_control",
    },
  ]) {
    assert.throws(() =>
      resolveControlDatabaseAuthority(environment, "production"),
    );
  }
});

test("Control rejects ambiguous or malformed database values before opening a Store", () => {
  for (const environment of [
    {
      CREWON_CONTROL_DATABASE_URL: " sqlite:///tmp/crewon ",
      CREWON_CONTROL_DATABASE_SCHEMA: "crewon_control",
    },
    {
      CREWON_CONTROL_DATABASE_URL: "postgresql://localhost/crewon#fragment",
      CREWON_CONTROL_DATABASE_SCHEMA: "crewon_control",
    },
    {
      CREWON_CONTROL_DATABASE_URL: "postgresql://localhost/crewon",
      CREWON_CONTROL_DATABASE_SCHEMA: "Public",
    },
  ]) {
    assert.throws(() =>
      resolveControlDatabaseAuthority(environment, "production"),
    );
  }
});
