import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { ProjectFoundationApplicationService } from "@crewon/application";
import type { ProjectFoundationMutationResponse } from "@crewon/contracts/project-foundation";
import { ownedProjectSqliteFixture } from "./plugin-project-owned-sqlite.test-support.ts";
import {
  interceptOwnedPostgresQueries,
  ownedProjectPostgresFixture,
} from "./plugin-project-owned-postgres.test-support.ts";
import { PostgresProjectFoundationStore } from "./project-foundation-postgres-store.ts";
import { SqliteProjectFoundationStore } from "./project-foundation-sqlite-store.ts";
import { projectFoundationActionFixture } from "../../application/src/plugin-project-foundation-action.test-support.ts";
import {
  createCommand,
  preparedSource,
} from "../../application/src/project-foundation-application-test-support.ts";
import {
  uiTestActor,
  uiTestAt,
} from "../../application/src/plugin-ui.test-support.ts";
const sha256 = (input: string) =>
  `sha256:${createHash("sha256").update(input).digest("hex")}`;
async function sqliteFixture(
  t: Parameters<typeof ownedProjectSqliteFixture>[0],
) {
  const f = await ownedProjectSqliteFixture(t);
  const directory = await f.ui();
  const store = new SqliteProjectFoundationStore({
    database: f.db,
    assertOpen() {},
    sourceAdmission: "trusted-internal-recipe",
  });
  await store.migrate();
  const foundations = new ProjectFoundationApplicationService({
    projects: f.store,
    store,
    sourceAdmission: "trusted-internal-recipe",
    sourcePreparation: {
      async loadPrepared(request) {
        return preparedSource(request.uploadId, uiTestActor);
      },
    },
    ids: f.ids,
    clock: { now: () => uiTestAt },
    digester: { sha256 },
    authorization: {
      async authorize() {
        return f.policy.allowed
          ? { outcome: "allow" }
          : { outcome: "deny", reasonCode: "fixture_denied" };
      },
    },
  });
  const ui = await projectFoundationActionFixture({
    foundationService: foundations,
    creationOwnership: "plugin-project-v1",
    assertActive() {
      if (!f.policy.allowed) throw new Error("fixture_denied");
    },
  });
  t.after(() => ui.owner.close());
  return { ...f, anotherUi: f.ui, directory, store, foundations, ui };
}
async function postgresFixture(
  t: Parameters<typeof ownedProjectPostgresFixture>[0],
) {
  const f = await ownedProjectPostgresFixture(t),
    directory = await f.ui();
  const store = new PostgresProjectFoundationStore({
    pool: f.pool,
    schema: f.schema,
    assertOpen() {},
    sourceAdmission: "trusted-internal-recipe",
  });
  await store.migrate();
  const foundations = new ProjectFoundationApplicationService({
    projects: f.store,
    store,
    sourceAdmission: "trusted-internal-recipe",
    sourcePreparation: {
      async loadPrepared(request) {
        return preparedSource(request.uploadId, uiTestActor);
      },
    },
    ids: f.ids,
    clock: { now: () => uiTestAt },
    digester: { sha256 },
    authorization: {
      async authorize() {
        return f.policy.allowed
          ? { outcome: "allow" }
          : { outcome: "deny", reasonCode: "fixture_denied" };
      },
    },
  });
  const ui = await projectFoundationActionFixture({
    foundationService: foundations,
    creationOwnership: "plugin-project-v1",
    assertActive() {
      if (!f.policy.allowed) throw new Error("fixture_denied");
    },
  });
  t.after(() => ui.owner.close());
  return {
    ...f,
    anotherUi: f.ui,
    directory,
    store,
    foundations,
    ui,
    count: async (table: string) =>
      Number(
        (await f.pool.query(`SELECT count(*) AS n FROM "${f.schema}".${table}`))
          .rows[0].n,
      ),
  };
}
async function fixture(
  t: Parameters<typeof ownedProjectSqliteFixture>[0],
  backend: "sqlite" | "postgres" = "sqlite",
) {
  if (backend === "postgres") return postgresFixture(t);
  const f = await sqliteFixture(t);
  return {
    ...f,
    count: async (table: string) =>
      Number(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n),
  };
}
for (const backend of ["sqlite", "postgres"] as const)
  for (const origin of ["creative", "novel"] as const)
    test(
      `${backend}: ${origin} creation is visible in its plugin directory and Foundation reads, hidden from ordinary projects, and retry preserves one ID`,
      { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
      async (t) => {
        const f = await fixture(t, backend),
          input = createCommand(origin);
        const created = (await f.ui.invoke(
          "createProject",
          input,
        )) as ProjectFoundationMutationResponse;
        const projectId = created.project.projectId;
        const directory = (await f.directory.invoke("listProjects", {
          query: { state: "active", cursor: null, limit: 20 },
        })) as { projects: { projectId: string }[] };
        assert.deepEqual(
          directory.projects.map((p) => p.projectId),
          [projectId],
        );
        const owner = {
          tenantId: uiTestActor.tenantId,
          spaceId: uiTestActor.spaceId,
          principalId: uiTestActor.principalId,
        };
        await assert.rejects(
          f.store.loadFoundation({ owner, projectId }),
          /creative_project_not_found/,
        );
        assert.equal(
          await f.store.loadMutationReceipt({
            actor: uiTestActor,
            kind: "create-project",
            receipt: {
              idempotencyKey: "missing",
              requestDigest: sha256("missing"),
            },
          }),
          null,
        );
        assert.deepEqual(
          await f.service.listProjects(uiTestActor, {
            state: "active",
            after: null,
            limit: 20,
          }),
          { projects: [], next: null },
        );
        const foundation = (await f.ui.invoke("getFoundation", {
          projectId,
        })) as { foundation: { projectId: string; origin: string } };
        assert.equal(foundation.foundation.projectId, projectId);
        assert.equal(foundation.foundation.origin, origin);
        const replay = (await f.ui.invoke(
          "createProject",
          input,
        )) as ProjectFoundationMutationResponse;
        assert.equal(replay.disposition, "replayed");
        assert.equal(replay.project.projectId, projectId);
        assert.equal(await f.count("plugin_project_metadata_owners"), 1);
        const changed = (await f.ui.invoke("updateParameters", {
          projectId,
          expectedFoundationRevision: 1,
          parameters: { ...input.parameters, genre: "喜剧" },
          idempotencyKey: "parameters",
        })) as ProjectFoundationMutationResponse;
        assert.equal(changed.foundation.parameters.genre, "喜剧");
        assert.equal(
          (
            (await f.ui.invoke("getFoundation", {
              projectId,
            })) as typeof foundation
          ).foundation.projectId,
          projectId,
        );
      },
    );
test("sqlite: another plugin cannot read a Foundation project and a revoked invocation cannot create ordinary records", async (t) => {
  const f = await fixture(t);
  const created = (await f.ui.invoke(
    "createProject",
    createCommand(),
  )) as ProjectFoundationMutationResponse;
  const other = await f.anotherUi("another.plugin");
  await assert.rejects(
    other.invoke("getProject", { projectId: created.project.projectId }),
  );
  f.ui.state.hostAllowed = false;
  await assert.rejects(
    f.ui.invoke("createProject", createCommand("creative", "denied")),
  );
  assert.equal(await f.count("creative_projects"), 1);
});

test("sqlite: losing live permission after the ownership insert rolls back the entire creation", async (t) => {
  const f = await sqliteFixture(t),
    original = f.db.prepare;
  f.db.prepare = new Proxy(original, {
    apply(target, receiver, args) {
      const statement = Reflect.apply(target, receiver, args);
      if (
        typeof args[0] !== "string" ||
        !args[0].startsWith("INSERT INTO plugin_project_metadata_owners")
      )
        return statement;
      return new Proxy(statement, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          if (typeof value !== "function") return value;
          return (...values: unknown[]) => {
            const result = Reflect.apply(value, target, values);
            if (key === "run") f.policy.allowed = false;
            return result;
          };
        },
      });
    },
  });
  await assert.rejects(f.ui.invoke("createProject", createCommand()), /denied/);
  for (const table of [
    "creative_projects",
    "creative_project_briefs",
    "project_foundations",
    "project_foundation_mutation_receipts",
    "plugin_project_metadata_owners",
  ])
    assert.equal(
      Number(
        original.call(f.db, `SELECT count(*) AS n FROM ${table}`).get()!.n,
      ),
      0,
      table,
    );
});

test(
  "postgres: losing live permission after ownership insertion rolls back every row",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL },
  async (t) => {
    const f = await postgresFixture(t);
    interceptOwnedPostgresQueries(f.pool, (statement) => {
      if (
        typeof statement === "string" &&
        /INSERT INTO .*plugin_project_metadata_owners/.test(statement)
      )
        f.policy.allowed = false;
    });
    await assert.rejects(
      f.ui.invoke("createProject", createCommand()),
      /denied/,
    );
    for (const table of [
      "creative_projects",
      "creative_project_briefs",
      "project_foundations",
      "project_foundation_mutation_receipts",
      "plugin_project_metadata_owners",
    ])
      assert.equal(await f.count(table), 0, table);
  },
);
