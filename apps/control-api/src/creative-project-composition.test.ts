import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import type {
  ActorContext,
  AuthorizationDecision,
  CreativeProjectAuthorizationPort,
} from "@crewon/application";
import type {
  CreativeProjectBriefMutationResponse,
  CreativeProjectConceptMutationResponse,
  CreativeProjectMetadataMutationResponse,
  GetConceptRevisionResponse,
  GetCreativeProjectResponse,
  GetProjectBriefResponse,
} from "@crewon/contracts";
import { SqliteRunStore } from "@crewon/store";
import {
  captureCreativeProjectCompositionConfig,
  prepareCreativeProjects,
} from "./creative-project-composition.ts";
import {
  createStandaloneControlApi,
  createStandaloneControlApiWithCreativeProjects,
  type StandaloneControlApiConfig,
  type StandaloneControlApiRuntime,
} from "./standalone-composition.ts";

const actor: ActorContext = Object.freeze({
  tenantId: "project-composition-tenant",
  spaceId: "project-composition-space",
  principalId: "project-composition-principal",
  actorId: "project-composition-audit-actor",
});
const headers = Object.freeze({
  "authorization": `Bearer ${"s".repeat(32)}`,
  "origin": "crewon://desktop",
  "x-csrf-token": "c".repeat(32),
});
const root = "/api/v1/creative-projects";
const disabledScans = {
  heartbeatIntervalMs: null,
  outboxScanIntervalMs: null,
  outboxRetention: null,
  artifactRetention: null,
  automationScanIntervalMs: null,
};
const allowed: CreativeProjectAuthorizationPort = {
  authorize: async () => ({ outcome: "allow" }),
};

async function fixture(t: TestContext) {
  const directory = await mkdtemp(
    join(tmpdir(), "crewon-project-composition-"),
  );
  const databasePath = join(directory, "control.sqlite");
  const runtimes = new Set<StandaloneControlApiRuntime>();
  t.after(async () => {
    for (const runtime of runtimes) await runtime.app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const config = (): StandaloneControlApiConfig => ({
    databasePath,
    actor,
    defaultAgentVersionId: "no-deployed-model",
    sessionToken: "s".repeat(32),
    csrfToken: "c".repeat(32),
    allowedOrigins: ["crewon://desktop"],
    artifactStore: new InMemoryArtifactStore(),
    artifactEncryptionKeyId: "fixture-key",
    ...disabledScans,
  });
  return {
    databasePath,
    config,
    track(runtime: StandaloneControlApiRuntime) {
      runtimes.add(runtime);
      return runtime;
    },
    async close(runtime: StandaloneControlApiRuntime) {
      runtimes.delete(runtime);
      await runtime.app.close();
    },
  };
}

function request(
  runtime: StandaloneControlApiRuntime,
  method: "GET" | "POST" | "PUT",
  url: string,
  payload?: Record<string, unknown>,
  key?: string,
) {
  return runtime.app.inject({
    method,
    url,
    headers: {
      ...headers,
      ...(key === undefined ? {} : { "idempotency-key": key }),
    },
    ...(payload === undefined ? {} : { payload }),
  });
}

test("absent project composition does not touch its Store adapter or schema", async (t) => {
  const f = await fixture(t);
  let touched = 0;
  t.mock.method(SqliteRunStore.prototype, "creativeProjectStore", () => {
    touched++;
    throw new Error("unexpected_project_adapter");
  });
  const runtime = f.track(createStandaloneControlApi(f.config()));
  assert.equal((await request(runtime, "GET", root)).statusCode, 404);
  assert.equal(
    (await request(runtime, "GET", "/api/v1/threads")).statusCode,
    200,
  );
  assert.equal(
    await prepareCreativeProjects(
      {
        creativeProjectStore() {
          throw new Error("unexpected_project_adapter");
        },
      },
      undefined,
    ),
    undefined,
  );
  assert.equal(touched, 0);
  const database = new DatabaseSync(f.databasePath);
  try {
    assert.equal(
      database
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'creative_%'",
        )
        .get()!.n,
      0,
    );
  } finally {
    database.close();
  }
});

test("synchronous project opt-in and invalid async authorities fail before the SQLite file opens", async (t) => {
  const f = await fixture(t);
  assert.throws(
    () =>
      createStandaloneControlApi({
        ...f.config(),
        creativeProjects: { authorization: allowed },
      }),
    /creative_projects_require_async_composition/u,
  );
  for (const creativeProjects of [
    undefined,
    null,
    {},
    { authorization: undefined },
    { authorization: null },
    { authorization: {} },
    { authorization: { authorize: 1 } },
  ]) {
    await assert.rejects(
      createStandaloneControlApiWithCreativeProjects({
        ...f.config(),
        creativeProjects,
      } as unknown as Parameters<
        typeof createStandaloneControlApiWithCreativeProjects
      >[0]),
      /creative_project_(configuration_invalid|authorization_required)/u,
    );
  }
  await assert.rejects(access(f.databasePath), /ENOENT/u);
});

test("project authority capture preserves the borrowed receiver and rejects accessors without invoking them", async () => {
  let getterCalls = 0;
  assert.throws(
    () =>
      captureCreativeProjectCompositionConfig({
        get authorization() {
          getterCalls++;
          return allowed;
        },
      }),
    /creative_project_configuration_invalid/u,
  );
  assert.equal(getterCalls, 0);
  const original: CreativeProjectAuthorizationPort & { live: boolean } = {
    live: true,
    async authorize(): Promise<AuthorizationDecision> {
      return this.live
        ? { outcome: "allow" }
        : { outcome: "deny", reasonCode: "revoked" };
    },
  };
  const config = { authorization: original };
  const captured = captureCreativeProjectCompositionConfig(config)!;
  config.authorization = {
    ...original,
    authorize: async () => ({ outcome: "deny", reasonCode: "replacement" }),
  };
  original.authorize = async () => ({
    outcome: "deny",
    reasonCode: "replacement",
  });
  const input: Parameters<CreativeProjectAuthorizationPort["authorize"]>[0] = {
    actor,
    action: "creativeProject:create",
    resource: {
      kind: "creativeProject",
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      projectId: null,
    },
  };
  assert.deepEqual(await captured.authorization.authorize(input), {
    outcome: "allow",
  });
  original.live = false;
  assert.deepEqual(await captured.authorization.authorize(input), {
    outcome: "deny",
    reasonCode: "revoked",
  });
  assert.equal(Object.isFrozen(captured), true);
  assert.equal(Object.isFrozen(captured.authorization), true);
  assert.equal(Object.isFrozen(config), false);
  assert.equal(Object.isFrozen(original), false);
});

test("borrowed project policy rejects own and inherited authorize accessors while accepting class methods", async () => {
  let getterCalls = 0;
  const accessorPort = {
    get authorize() {
      getterCalls++;
      return allowed.authorize;
    },
  };
  for (const authorization of [accessorPort, Object.create(accessorPort)])
    assert.throws(
      () => captureCreativeProjectCompositionConfig({ authorization }),
      /creative_project_authorization_required/u,
    );
  assert.equal(getterCalls, 0);
  class BorrowedPolicy implements CreativeProjectAuthorizationPort {
    live = true;
    async authorize(): Promise<AuthorizationDecision> {
      return this.live
        ? { outcome: "allow" }
        : { outcome: "deny", reasonCode: "revoked" };
    }
  }
  const policy = new BorrowedPolicy();
  assert.equal(Object.hasOwn(policy, "authorize"), false);
  const captured = captureCreativeProjectCompositionConfig({
    authorization: policy,
  })!;
  const input: Parameters<CreativeProjectAuthorizationPort["authorize"]>[0] = {
    actor,
    action: "creativeProject:list",
    resource: {
      kind: "creativeProject",
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      projectId: null,
    },
  };
  assert.deepEqual(await captured.authorization.authorize(input), {
    outcome: "allow",
  });
  policy.live = false;
  assert.deepEqual(await captured.authorization.authorize(input), {
    outcome: "deny",
    reasonCode: "revoked",
  });
});

test("explicit SQLite project metadata survives cold reopen without generation, billing or model readiness", async (t) => {
  const f = await fixture(t);
  const open = async () =>
    f.track(
      await createStandaloneControlApiWithCreativeProjects({
        ...f.config(),
        creativeProjects: { authorization: allowed },
      }),
    );
  const first = await open();
  assert.equal(
    (await request(first, "GET", "/api/v1/health/ready")).statusCode,
    503,
  );
  const createPayload = {
    title: "雨夜重逢",
    briefText: "需求第一版\n保留原始换行。",
  };
  const createdReply = await request(
    first,
    "POST",
    root,
    createPayload,
    "create-project",
  );
  assert.equal(createdReply.statusCode, 200, createdReply.body);
  const created = createdReply.json<CreativeProjectBriefMutationResponse>();
  const projectId = created.project.projectId;
  const path = `${root}/${projectId}`;
  const conceptReply = await request(
    first,
    "POST",
    `${path}/concepts`,
    {
      briefRevision: 1,
      name: "雨夜概念图",
      prompt: "保留的第一版描述",
      expectedProjectRevision: created.project.revision,
    },
    "concept-1",
  );
  assert.equal(conceptReply.statusCode, 200, conceptReply.body);
  const concept = conceptReply.json<CreativeProjectConceptMutationResponse>();
  const assetPath = `${path}/concepts/${concept.asset.assetId}`;
  const briefReply = await request(
    first,
    "POST",
    `${path}/briefs`,
    {
      text: "需求第二版",
      expectedProjectRevision: concept.project.revision,
    },
    "brief-2",
  );
  assert.equal(briefReply.statusCode, 200, briefReply.body);
  const brief = briefReply.json<CreativeProjectBriefMutationResponse>();
  const revisionReply = await request(
    first,
    "POST",
    `${assetPath}/revisions`,
    {
      briefRevision: 2,
      prompt: "明确保存的第二版描述",
      expectedProjectRevision: brief.project.revision,
      expectedAssetMetadataRevision: concept.asset.revision,
    },
    "concept-2",
  );
  assert.equal(revisionReply.statusCode, 200, revisionReply.body);
  const revision = revisionReply.json<CreativeProjectConceptMutationResponse>();
  const archivedReply = await request(
    first,
    "PUT",
    `${path}/state`,
    {
      state: "archived",
      expectedProjectRevision: revision.project.revision,
    },
    "archive-project",
  );
  assert.equal(archivedReply.statusCode, 200, archivedReply.body);
  const archived =
    archivedReply.json<CreativeProjectMetadataMutationResponse>();
  await f.close(first);

  const reopened = await open();
  const projectReply = await request(reopened, "GET", path);
  assert.equal(projectReply.statusCode, 200, projectReply.body);
  assert.deepEqual(
    projectReply.json<GetCreativeProjectResponse>().project,
    archived.project,
  );
  const firstBrief = await request(reopened, "GET", `${path}/briefs/1`);
  assert.equal(firstBrief.statusCode, 200, firstBrief.body);
  assert.equal(
    firstBrief.json<GetProjectBriefResponse>().brief.text,
    createPayload.briefText,
  );
  for (const [version, original] of [
    [1, concept.assetRevision],
    [2, revision.assetRevision],
  ] as const) {
    const reply = await request(
      reopened,
      "GET",
      `${assetPath}/revisions/${version}`,
    );
    assert.equal(reply.statusCode, 200, reply.body);
    assert.deepEqual(
      reply.json<GetConceptRevisionResponse>().assetRevision,
      original,
    );
  }
  const replay = await request(
    reopened,
    "POST",
    root,
    createPayload,
    "create-project",
  );
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(replay.json(), { ...created, disposition: "replayed" });
  const blocked = await request(
    reopened,
    "POST",
    `${path}/briefs`,
    {
      text: "归档后不能追加",
      expectedProjectRevision: archived.project.revision,
    },
    "archived-brief",
  );
  assert.equal(blocked.statusCode, 409, blocked.body);
  const database = new DatabaseSync(f.databasePath);
  try {
    const row = database
      .prepare("SELECT record_json FROM creative_projects WHERE project_id=?")
      .get(projectId)!;
    assert.equal(
      JSON.parse(String(row.record_json)).ownerPrincipalId,
      actor.principalId,
    );
    for (const table of ["run_snapshots", "threads", "messages", "outbox"])
      assert.equal(
        database.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,
        0,
      );
    assert.equal(
      database
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE name IN ('plugin_credit_entries','extension_credit_admissions','external_operations')",
        )
        .get()!.n,
      0,
    );
    assert.equal(
      database
        .prepare("SELECT count(*) AS n FROM creative_project_mutation_receipts")
        .get()!.n,
      5,
    );
  } finally {
    database.close();
  }
});

test("project authority is captured before awaited migration while live revocation still applies", async (t) => {
  const f = await fixture(t);
  let entered!: () => void;
  let resume!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resumePromise = new Promise<void>((resolve) => {
    resume = resolve;
  });
  t.after(() => resume());
  const originalFactory = SqliteRunStore.prototype.creativeProjectStore;
  t.mock.method(
    SqliteRunStore.prototype,
    "creativeProjectStore",
    function (this: SqliteRunStore) {
      const adapter = originalFactory.call(this);
      const migrate = adapter.migrate.bind(adapter);
      adapter.migrate = async () => {
        await migrate();
        entered();
        await resumePromise;
      };
      return adapter;
    },
  );
  const port: CreativeProjectAuthorizationPort & {
    live: boolean;
    actors: ActorContext[];
  } = {
    live: true,
    actors: [],
    async authorize(input): Promise<AuthorizationDecision> {
      this.actors.push(input.actor);
      return this.live
        ? { outcome: "allow" }
        : { outcome: "deny", reasonCode: "revoked" };
    },
  };
  const creativeProjects = {
    authorization: port as CreativeProjectAuthorizationPort,
  };
  const opening = createStandaloneControlApiWithCreativeProjects({
    ...f.config(),
    creativeProjects,
  });
  await enteredPromise;
  creativeProjects.authorization = {
    authorize: async () => ({ outcome: "deny", reasonCode: "replacement" }),
  };
  port.authorize = creativeProjects.authorization.authorize;
  resume();
  const runtime = f.track(await opening);
  const created = await request(
    runtime,
    "POST",
    root,
    { title: "保存", briefText: "真实 SQLite" },
    "captured-authority",
  );
  assert.equal(created.statusCode, 200, created.body);
  assert.ok(port.actors.length > 0);
  for (const actual of port.actors) assert.deepEqual(actual, actor);
  port.live = false;
  const denied = await request(runtime, "GET", root);
  assert.equal(denied.statusCode, 403, denied.body);
});

for (const failure of ["migration", "composition"] as const) {
  test(`project ${failure} startup failure closes each acquired parent resource once`, async (t) => {
    const f = await fixture(t);
    if (failure === "migration") {
      const database = new DatabaseSync(f.databasePath);
      database.exec(
        "CREATE TABLE creative_project_schema_version (id INTEGER PRIMARY KEY,version INTEGER); INSERT INTO creative_project_schema_version VALUES(1,99)",
      );
      database.close();
    }
    const config = f.config();
    let storeCloses = 0;
    let artifactCloses = 0;
    const closeStore = SqliteRunStore.prototype.close;
    t.mock.method(
      SqliteRunStore.prototype,
      "close",
      function (this: SqliteRunStore) {
        storeCloses++;
        return closeStore.call(this);
      },
    );
    const closeArtifacts = config.artifactStore.close.bind(
      config.artifactStore,
    );
    t.mock.method(config.artifactStore, "close", async () => {
      artifactCloses++;
      await closeArtifacts();
    });
    await assert.rejects(
      createStandaloneControlApiWithCreativeProjects({
        ...config,
        ...(failure === "composition" ? { heartbeatIntervalMs: 0 } : {}),
        creativeProjects: { authorization: allowed },
      }),
      failure === "migration"
        ? /creative_project_schema_version_unsupported/u
        : /heartbeat_interval_invalid/u,
    );
    assert.equal(storeCloses, 1);
    assert.equal(artifactCloses, 1);
    const reopened = new SqliteRunStore(f.databasePath);
    await reopened.close();
  });
}
