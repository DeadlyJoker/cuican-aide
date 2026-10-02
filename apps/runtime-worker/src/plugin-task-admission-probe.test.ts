import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { SqliteRunStore } from "@crewon/store";
import { preparePluginTaskAdmissionProbe } from "./plugins/plugin-task-admission-probe.ts";
import { compositionFixture } from "./runtime-composition.test-support.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "crewon-plugin-probe-"));
  const path = join(root, "run.sqlite");
  const store = new SqliteRunStore(path);
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { store, path };
}

test("fresh Worker provenance can distinguish absence without funding or credit migration", async (t) => {
  const f = await fixture(t);
  const probe = await preparePluginTaskAdmissionProbe(f.store);
  assert.equal(probe.pluginAdmissionVersion, "crewon.plugin-task-admission.v1");
  assert.equal(
    await probe.loadPluginTaskAdmission!({
      tenantId: "tenant",
      spaceId: "space",
      runId: "ordinary-run",
    }),
    null,
  );
  await preparePluginTaskAdmissionProbe(f.store);
  const sql = new DatabaseSync(f.path);
  try {
    assert.deepEqual(
      sql
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%credit%'",
        )
        .all(),
      [],
    );
  } finally {
    sql.close();
  }
});

test("incompatible installed-package schema stops startup instead of permitting legacy dispatch", async (t) => {
  const f = await fixture(t);
  await preparePluginTaskAdmissionProbe(f.store);
  const sql = new DatabaseSync(f.path);
  try {
    sql.exec(
      "UPDATE plugin_task_admission_schema_version SET version=2 WHERE id=1",
    );
  } finally {
    sql.close();
  }
  await assert.rejects(
    preparePluginTaskAdmissionProbe(f.store),
    /plugin_task_admission_schema_version_unsupported/,
  );
});

test("ordinary composition leaves plugin storage absent until explicit feature activation", async (t) => {
  const f = compositionFixture(t, "sqlite");
  await f.activate();
  const runtime = await f.create();
  t.after(() => runtime.close());
  const sql = new DatabaseSync(join(f.root, "control.sqlite"));
  try {
    assert.deepEqual(
      sql
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND (name GLOB 'plugin_*' OR name GLOB 'extension_*')",
        )
        .all(),
      [],
    );
    assert.deepEqual(await runtime.worker.wake(), { kind: "idle" });
  } finally {
    sql.close();
  }
});
