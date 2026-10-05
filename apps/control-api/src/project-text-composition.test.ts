import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { SqliteRunStore } from "@crewon/store";
import { publicTextOutline as outline } from "../../../packages/contracts/src/project-text-control.test-support.ts";
import { textActor } from "../../../packages/store/src/project-text-store.test-support.ts";
import {
  captureCreativeProjectCompositionConfig,
  prepareCreativeProjects,
} from "./creative-project-composition.ts";
import {
  createStandaloneControlApiWithCreativeProjects,
  type StandaloneControlApiConfig,
  type StandaloneControlApiRuntime,
} from "./standalone-composition.ts";
const authorization = {
  authorize: async () => ({ outcome: "allow" as const }),
};
const textArtifacts = { version: "crewon.project-text.v1" } as const;
const headers = {
  "authorization": `Bearer ${"s".repeat(32)}`,
  "origin": "crewon://desktop",
  "x-csrf-token": "c".repeat(32),
  "idempotency-key": "text-composition",
};
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "crewon-text-composition-")),
    databasePath = join(directory, "control.sqlite"),
    runtimes = new Set<StandaloneControlApiRuntime>();
  t.after(async () => {
    try {
      for (const runtime of runtimes) await runtime.app.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  const config = (): StandaloneControlApiConfig => ({
    databasePath,
    actor: textActor,
    defaultAgentVersionId: "no-model",
    sessionToken: "s".repeat(32),
    csrfToken: "c".repeat(32),
    allowedOrigins: ["crewon://desktop"],
    artifactStore: new InMemoryArtifactStore(),
    artifactEncryptionKeyId: "fixture-key",
    heartbeatIntervalMs: null,
    outboxScanIntervalMs: null,
    outboxRetention: null,
    artifactRetention: null,
    automationScanIntervalMs: null,
  });
  const open = async (enabled = true) => {
    const runtime = await createStandaloneControlApiWithCreativeProjects({
      ...config(),
      creativeProjects: {
        authorization,
        ...(enabled ? { textArtifacts } : {}),
      },
    });
    runtimes.add(runtime);
    return runtime;
  };
  const close = async (runtime: StandaloneControlApiRuntime) => {
    runtimes.delete(runtime);
    await runtime.app.close();
  };
  const tables = () => {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      return db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => String(row.name));
    } finally {
      db.close();
    }
  };
  return { directory, databasePath, config, open, close, tables };
}
test("text composition captures only the exact opt-in version and never evaluates configuration getters", () => {
  const original = {
    authorization,
    textArtifacts: { version: "crewon.project-text.v1" },
  };
  const captured = captureCreativeProjectCompositionConfig(original)!;
  original.textArtifacts.version = "changed";
  assert.deepEqual(captured.textArtifacts, textArtifacts);
  assert.equal(Object.isFrozen(captured.textArtifacts), true);
  let getters = 0;
  const accessor = {
    get version() {
      getters++;
      return "crewon.project-text.v1";
    },
  };
  for (const value of [
    null,
    {},
    undefined,
    "crewon.project-text.v1",
    { version: "next" },
    { version: "crewon.project-text.v1", migrate: true },
    accessor,
    Object.assign(Object.create({ authority: true }), textArtifacts),
  ])
    assert.throws(
      () =>
        captureCreativeProjectCompositionConfig({
          authorization,
          textArtifacts: value,
        }),
      /project_text_configuration_invalid/u,
    );
  assert.throws(
    () =>
      captureCreativeProjectCompositionConfig({
        authorization,
        get textArtifacts() {
          getters++;
          return textArtifacts;
        },
      }),
    /creative_project_configuration_invalid/u,
  );
  assert.equal(getters, 0);
});
test("old composition never calls the new parent adapter; opt-in migration is independent and uses real parent lifetime", async (t) => {
  const f = await fixture(t),
    parent = new SqliteRunStore(f.databasePath);
  t.after(() => parent.close());
  let calls = 0;
  const owner = {
    creativeProjectStore: () => parent.creativeProjectStore(),
    projectTextStore: () => {
      calls++;
      return parent.projectTextStore();
    },
  };
  assert.equal(await prepareCreativeProjects(owner, undefined), undefined);
  const old = await prepareCreativeProjects(owner, { authorization });
  assert.equal(old?.textService, undefined);
  assert.equal(calls, 0);
  assert.equal(
    f.tables().some((name) => name.startsWith("project_text")),
    false,
  );
  const enabled = await prepareCreativeProjects(owner, {
    authorization,
    textArtifacts,
  });
  assert.ok(enabled?.textService);
  assert.equal(calls, 1);
  assert.equal(
    f.tables().filter((name) => name.startsWith("project_text")).length,
    4,
  );
  await parent.close();
  await assert.rejects(
    enabled!.textService!.getOutline(textActor, { projectId: "missing" }),
    /project_text_service_unavailable/u,
  );
});
test("real standalone Control registration is opt-in and cold text metadata needs no model or paid service", async (t) => {
  const f = await fixture(t),
    old = await f.open(false);
  const create = await old.app.inject({
    method: "POST",
    url: "/api/v1/creative-projects",
    headers,
    payload: { title: "原版项目", briefText: "原版输入" },
  });
  assert.equal(create.statusCode, 200, create.body);
  const initial = create.json();
  const root = `/api/v1/creative-projects/${encodeURIComponent(initial.project.projectId)}/text-artifacts`;
  const originalTables = f.tables();
  assert.equal(
    (await old.app.inject({ method: "GET", url: root + "/outline", headers }))
      .statusCode,
    404,
  );
  assert.equal(
    f.tables().some((name) => name.startsWith("project_text")),
    false,
  );
  await f.close(old);
  const enabled = await f.open();
  assert.equal(
    (
      await enabled.app.inject({
        method: "GET",
        url: "/api/v1/health/ready",
        headers,
      })
    ).statusCode,
    503,
  );
  const saved = await enabled.app.inject({
    method: "POST",
    url: root + "/outline/candidates",
    headers: { ...headers, "idempotency-key": "candidate" },
    payload: {
      expectedArtifactRevision: 0,
      briefRevision: 1,
      content: outline,
    },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const result = saved.json();
  assert.equal(result.artifact.selectedContentRevision, null);
  await f.close(enabled);
  const cold = await f.open();
  const loaded = await cold.app.inject({
    method: "GET",
    url: root + "/outline",
    headers,
  });
  assert.equal(loaded.statusCode, 200, loaded.body);
  assert.equal(
    loaded.json().view.artifact.artifactId,
    result.artifact.artifactId,
  );
  assert.equal(loaded.json().view.dependencyState, "unselected");
  const project = await cold.app.inject({
    method: "GET",
    url: `/api/v1/creative-projects/${initial.project.projectId}`,
    headers,
  });
  assert.deepEqual(project.json().project, initial.project);
  await f.close(cold);
  const db = new DatabaseSync(f.databasePath, { readOnly: true });
  try {
    assert.deepEqual(
      f
        .tables()
        .filter((name) => !name.startsWith("project_text"))
        .sort(),
      originalTables.sort(),
    );
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS n FROM project_text_mutation_receipts")
        .get()?.n,
      1,
    );
  } finally {
    db.close();
  }
});
test("invalid text opt-in fails before opening actual standalone storage", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    createStandaloneControlApiWithCreativeProjects({
      ...f.config(),
      creativeProjects: { authorization, textArtifacts: { version: "next" } },
    } as never),
    /project_text_configuration_invalid/u,
  );
  await assert.rejects(access(f.databasePath), /ENOENT/u);
});
