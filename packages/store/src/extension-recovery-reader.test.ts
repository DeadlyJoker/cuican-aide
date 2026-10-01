import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { readSqliteExtensionRecoveryRelease } from "./extension-recovery-reader.ts";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { agentVersionAsset } from "./agent-version-store-conformance.test-support.ts";
import {
  releaseActivation,
  releaseBundle,
} from "./agent-version-release-store-conformance.test-support.ts";

async function fixture(t: TestContext) {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "crewon-recovery-db-")),
  );
  const databasePath = join(directory, "control.sqlite");
  const store = new SqliteRunStore(databasePath);
  t.after(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const agentVersionIds = ["base", "planner", "plugin"];
  const bundle = releaseBundle("1", agentVersionIds);
  for (const id of agentVersionIds)
    await store.registerAgentVersion(agentVersionAsset(bundle.tenantId, id));
  const activation = releaseActivation(bundle, "first", null);
  await store.activateAgentVersionRelease({
    bundle,
    activation,
    expectedActiveReleaseId: null,
  });
  const input = {
    databasePath,
    tenantId: bundle.tenantId,
    releaseId: bundle.releaseId,
    agentVersionIds,
  };
  return { directory, databasePath, store, bundle, activation, input };
}
function mutate(
  databasePath: string,
  statement: string,
  parameters: string[] = [],
) {
  const database = new DatabaseSync(databasePath);
  try {
    // Deliberate corruption fixture; the production reader never changes this setting.
    database.exec("PRAGMA foreign_keys=OFF");
    database.prepare(statement).run(...parameters);
  } finally {
    database.close();
  }
}

test("reads a complete old release from live WAL without changing the current pointer or running migrations", async (t) => {
  const f = await fixture(t);
  const newer = releaseBundle("2", ["new-default"]);
  await f.store.registerAgentVersion(
    agentVersionAsset(newer.tenantId, "new-default"),
  );
  const newerActivation = releaseActivation(
    newer,
    "second",
    f.bundle.releaseId,
  );
  await f.store.activateAgentVersionRelease({
    bundle: newer,
    activation: newerActivation,
    expectedActiveReleaseId: f.bundle.releaseId,
  });
  const schema = new DatabaseSync(f.databasePath, { readOnly: true });
  const before = schema
    .prepare("SELECT name,sql FROM sqlite_schema ORDER BY name")
    .all();
  try {
    const read = readSqliteExtensionRecoveryRelease(f.input);
    assert.deepEqual(read.bundle, f.bundle);
    assert.equal(read.assets.length, 3);
    assert.deepEqual(
      read.assets,
      await Promise.all(
        f.input.agentVersionIds.map((agentVersionId) =>
          f.store.loadAgentVersion({
            tenantId: f.bundle.tenantId,
            agentVersionId,
          }),
        ),
      ),
    );
    assert.deepEqual(
      read.deployments,
      await Promise.all(
        f.input.agentVersionIds.map((agentVersionId) =>
          f.store.loadAgentVersionDeployment({
            tenantId: f.bundle.tenantId,
            agentVersionId,
          }),
        ),
      ),
    );
    assert.deepEqual(
      await f.store.loadActiveAgentVersionRelease({ tenantId: newer.tenantId }),
      { bundle: newer, activation: newerActivation },
    );
    assert.deepEqual(
      schema.prepare("SELECT name,sql FROM sqlite_schema ORDER BY name").all(),
      before,
    );
    assert.ok(
      Object.isFrozen(read) &&
        Object.isFrozen(read.assets) &&
        Object.isFrozen(read.deployments),
    );
  } finally {
    schema.close();
  }
});

test("missing database is never created and failures expose only the fixed code", async (t) => {
  const f = await fixture(t);
  const missing = join(f.directory, "missing.sqlite");
  assert.throws(
    () =>
      readSqliteExtensionRecoveryRelease({ ...f.input, databasePath: missing }),
    { message: "extension_recovery_database_unavailable" },
  );
  assert.equal(existsSync(missing), false);
  assert.throws(
    () =>
      readSqliteExtensionRecoveryRelease({
        ...f.input,
        tenantId: "other-tenant",
      }),
    { message: "extension_recovery_database_unavailable" },
  );
});

test("rejects omitted profiles, duplicate IDs and capacity before opening a database", async (t) => {
  const f = await fixture(t);
  for (const ids of [
    [],
    ["plugin"],
    ["base", "planner", "plugin", "plugin"],
    Array.from({ length: 257 }, (_, i) => `id-${i}`),
  ])
    assert.throws(
      () =>
        readSqliteExtensionRecoveryRelease({
          ...f.input,
          agentVersionIds: ids,
        }),
      { message: "extension_recovery_database_unavailable" },
    );
});

test("rejects database and ancestor aliases, hard links and non-files", async (t) => {
  const f = await fixture(t);
  const link = join(f.directory, "alias.sqlite");
  symlinkSync(f.databasePath, link);
  assert.throws(
    () =>
      readSqliteExtensionRecoveryRelease({ ...f.input, databasePath: link }),
    { message: "extension_recovery_database_unavailable" },
  );
  const aliasDirectory = join(f.directory, "alias-directory");
  symlinkSync(f.directory, aliasDirectory, "dir");
  assert.throws(
    () =>
      readSqliteExtensionRecoveryRelease({
        ...f.input,
        databasePath: join(aliasDirectory, "control.sqlite"),
      }),
    { message: "extension_recovery_database_unavailable" },
  );
  const folder = join(f.directory, "folder.sqlite");
  mkdirSync(folder);
  assert.throws(
    () =>
      readSqliteExtensionRecoveryRelease({ ...f.input, databasePath: folder }),
    { message: "extension_recovery_database_unavailable" },
  );
  const hardlink = join(f.directory, "hardlink.sqlite");
  linkSync(f.databasePath, hardlink);
  assert.throws(() => readSqliteExtensionRecoveryRelease(f.input), {
    message: "extension_recovery_database_unavailable",
  });
});

test("rejects missing base assets and missing deployments even when the plugin remains intact", async (t) => {
  const f = await fixture(t);
  mutate(
    f.databasePath,
    "DELETE FROM agent_versions WHERE agent_version_id=?",
    ["planner"],
  );
  assert.throws(() => readSqliteExtensionRecoveryRelease(f.input), {
    message: "extension_recovery_database_unavailable",
  });
  const missingDeployment = await fixture(t);
  mutate(
    missingDeployment.databasePath,
    "DELETE FROM agent_version_deployments WHERE agent_version_id=?",
    ["planner"],
  );
  assert.throws(
    () => readSqliteExtensionRecoveryRelease(missingDeployment.input),
    { message: "extension_recovery_database_unavailable" },
  );
});

test("rejects column/JSON disagreement and oversized material before returning it", async (t) => {
  const f = await fixture(t);
  const asset = agentVersionAsset(f.bundle.tenantId, "planner");
  mutate(
    f.databasePath,
    "UPDATE agent_versions SET asset_json=? WHERE agent_version_id=?",
    [
      JSON.stringify({ ...asset, contentDigest: `sha256:${"f".repeat(64)}` }),
      "planner",
    ],
  );
  assert.throws(() => readSqliteExtensionRecoveryRelease(f.input), {
    message: "extension_recovery_database_unavailable",
  });
  mutate(
    f.databasePath,
    "UPDATE agent_versions SET asset_json=? WHERE agent_version_id=?",
    [
      JSON.stringify({
        ...asset,
        definitionJson: JSON.stringify({
          instructions: "x".repeat(1024 * 1024),
        }),
      }),
      "planner",
    ],
  );
  assert.throws(() => readSqliteExtensionRecoveryRelease(f.input), {
    message: "extension_recovery_database_unavailable",
  });
});

test("a read-only probe of an empty SQLite database does not introduce Store tables", async (t) => {
  const f = await fixture(t);
  const emptyPath = join(f.directory, "empty.sqlite");
  const empty = new DatabaseSync(emptyPath);
  empty.close();
  const bytes = readFileSync(emptyPath);
  assert.throws(
    () =>
      readSqliteExtensionRecoveryRelease({
        ...f.input,
        databasePath: emptyPath,
      }),
    { message: "extension_recovery_database_unavailable" },
  );
  assert.deepEqual(readFileSync(emptyPath), bytes);
});
