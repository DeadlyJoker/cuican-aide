import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import type { CreativeProjectAuthorizationPort } from "@crewon/application";
import type {
  CreativeProjectBriefMutationResponse,
  CreativeProjectConceptMutationResponse,
} from "@crewon/contracts";
import { PostgresDomainStore } from "@crewon/store";
import {
  createProductionPostgresControlApi,
  type ProductionPostgresControlApiConfig,
} from "./production-composition.ts";
import { pluginUiProductionIdentity } from "./production-plugin-ui.test-support.ts";
import { pluginRouteActor } from "./plugin-control-route.test-support.ts";

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

test("production project opt-in rejects unverified identity before opening PostgreSQL", async (t) => {
  let opened = 0;
  t.mock.method(PostgresDomainStore, "open", async () => {
    opened++;
    throw new Error("unexpected_database_open");
  });
  await assert.rejects(
    createProductionPostgresControlApi({
      connectionString: "unusable-connection",
      identity: { resolveActor: async () => pluginRouteActor },
      authorization: { authorize: async () => ({ outcome: "allow" }) },
      creativeProjects: { authorization: allowed },
      artifactStore: new InMemoryArtifactStore(),
      artifactEncryptionKeyId: "fixture-key",
    }),
    /production_creative_project_identity_required/u,
  );
  assert.equal(opened, 0);
});

test("production project opt-in rejects missing and malformed borrowed policy before database I/O", async (t) => {
  let opened = 0;
  t.mock.method(PostgresDomainStore, "open", async () => {
    opened++;
    throw new Error("unexpected_database_open");
  });
  const authentication = pluginUiProductionIdentity();
  for (const creativeProjects of [
    null,
    {},
    { authorization: undefined },
    { authorization: null },
    { authorization: {} },
    { authorization: { authorize: "allow" } },
  ]) {
    await assert.rejects(
      createProductionPostgresControlApi({
        connectionString: "unusable-connection",
        identity: authentication.identity,
        authorization: { authorize: async () => ({ outcome: "allow" }) },
        creativeProjects,
        artifactStore: new InMemoryArtifactStore(),
        artifactEncryptionKeyId: "fixture-key",
      } as unknown as ProductionPostgresControlApiConfig),
      /creative_project_(configuration_invalid|authorization_required)/u,
    );
  }
  assert.equal(opened, 0);
  assert.equal(authentication.reads(), 0);
});

async function postgresFixture(t: TestContext) {
  const schema = `creative_composition_${randomUUID().replaceAll("-", "")}`;
  const connectionString = process.env.CREWON_TEST_POSTGRES_URL!;
  const observer = new Pool({ connectionString, max: 1 });
  const authentication = pluginUiProductionIdentity();
  const runtimes = new Set<
    Awaited<ReturnType<typeof createProductionPostgresControlApi>>
  >();
  t.after(async () => {
    try {
      for (const runtime of runtimes) await runtime.app.close();
      await observer.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await observer.end();
    }
  });
  let legacyAuthorizations = 0;
  const config = (): ProductionPostgresControlApiConfig => ({
    connectionString,
    schema,
    maxPoolSize: 3,
    statementTimeoutMs: 5000,
    identity: authentication.identity,
    authorization: {
      authorize: async () => {
        legacyAuthorizations++;
        return { outcome: "deny", reasonCode: "legacy_policy_denied" };
      },
    },
    artifactStore: new InMemoryArtifactStore(),
    artifactEncryptionKeyId: "fixture-key",
    ...disabledScans,
  });
  return {
    schema,
    observer,
    authentication,
    config,
    legacyAuthorizations: () => legacyAuthorizations,
    track(
      runtime: Awaited<ReturnType<typeof createProductionPostgresControlApi>>,
    ) {
      runtimes.add(runtime);
      return runtime;
    },
    async close(
      runtime: Awaited<ReturnType<typeof createProductionPostgresControlApi>>,
    ) {
      runtimes.delete(runtime);
      await runtime.app.close();
    },
  };
}

const postgresOptions = {
  skip: !process.env.CREWON_TEST_POSTGRES_URL,
  timeout: 30000,
};

test(
  "default production composition leaves project adapter, route and independent schema absent",
  postgresOptions,
  async (t) => {
    const f = await postgresFixture(t);
    let touched = 0;
    t.mock.method(PostgresDomainStore.prototype, "creativeProjectStore", () => {
      touched++;
      throw new Error("unexpected_project_adapter");
    });
    const runtime = f.track(
      await createProductionPostgresControlApi(f.config()),
    );
    const unavailable = await runtime.app.inject({
      method: "GET",
      url: root,
      headers: f.authentication.headers,
    });
    assert.equal(unavailable.statusCode, 404, unavailable.body);
    assert.equal(touched, 0);
    const tables = await f.observer.query<{ count: string }>(
      "SELECT count(*) AS count FROM information_schema.tables WHERE table_schema=$1 AND table_name LIKE 'creative_%'",
      [f.schema],
    );
    assert.equal(tables.rows[0]!.count, "0");
  },
);

test(
  "production PostgreSQL projects retain actual request ownership and inputs across restart with independent trusted metadata policy",
  postgresOptions,
  async (t) => {
    const f = await postgresFixture(t);
    const decisions: Parameters<
      CreativeProjectAuthorizationPort["authorize"]
    >[0][] = [];
    let revoked = false;
    const authorization: CreativeProjectAuthorizationPort = {
      authorize: async (input) => {
        decisions.push(input);
        assert.deepEqual(input.actor, pluginRouteActor);
        assert.equal(input.resource.tenantId, pluginRouteActor.tenantId);
        assert.equal(input.resource.spaceId, pluginRouteActor.spaceId);
        return revoked
          ? { outcome: "deny", reasonCode: "project_policy_revoked" }
          : { outcome: "allow" };
      },
    };
    const open = async () =>
      f.track(
        await createProductionPostgresControlApi({
          ...f.config(),
          creativeProjects: { authorization },
        }),
      );
    const inject = (
      runtime: Awaited<ReturnType<typeof open>>,
      method: "GET" | "POST",
      url: string,
      payload?: Record<string, unknown>,
      key?: string,
    ) =>
      runtime.app.inject({
        method,
        url,
        headers: {
          ...f.authentication.headers,
          ...(key === undefined ? {} : { "idempotency-key": key }),
        },
        ...(payload === undefined ? {} : { payload }),
      });
    const first = await open();
    const body = {
      title: "生产项目存储夹具",
      briefText: "只保存需求，不提交任何生成。",
    };
    const createdReply = await inject(
      first,
      "POST",
      root,
      body,
      "create-project",
    );
    assert.equal(createdReply.statusCode, 200, createdReply.body);
    const created = createdReply.json<CreativeProjectBriefMutationResponse>();
    assert.equal(f.legacyAuthorizations(), 0);
    const projectPath = `${root}/${created.project.projectId}`;
    const conceptReply = await inject(
      first,
      "POST",
      `${projectPath}/concepts`,
      {
        briefRevision: 1,
        name: "保存的概念图输入",
        prompt: "明确确认的输入",
        expectedProjectRevision: created.project.revision,
      },
      "concept-1",
    );
    assert.equal(conceptReply.statusCode, 200, conceptReply.body);
    const concept = conceptReply.json<CreativeProjectConceptMutationResponse>();
    const deniedChat = await inject(first, "GET", "/api/v1/threads");
    assert.equal(deniedChat.statusCode, 403, deniedChat.body);
    assert.equal(f.legacyAuthorizations(), 1);
    revoked = true;
    const deniedRead = await inject(first, "GET", projectPath);
    assert.equal(deniedRead.statusCode, 403, deniedRead.body);
    revoked = false;
    await f.close(first);
    const reopened = await open();
    const readProject = await inject(reopened, "GET", projectPath);
    assert.equal(readProject.statusCode, 200, readProject.body);
    assert.deepEqual(readProject.json(), { project: concept.project });
    const readInput = await inject(
      reopened,
      "GET",
      `${projectPath}/concepts/${concept.asset.assetId}/revisions/1`,
    );
    assert.equal(readInput.statusCode, 200, readInput.body);
    assert.deepEqual(readInput.json(), {
      assetRevision: concept.assetRevision,
    });
    const replay = await inject(reopened, "POST", root, body, "create-project");
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json(), { ...created, disposition: "replayed" });
    assert.ok(
      decisions.some((item) => item.action === "creativeProject:create"),
    );
    assert.ok(
      decisions.some((item) => item.action === "creativeProject:write"),
    );
    assert.ok(decisions.some((item) => item.action === "creativeProject:read"));
    assert.ok(f.authentication.reads() >= 7);
    const stored = await f.observer.query<{
      owner_principal_id: string;
      record_json: Record<string, unknown>;
    }>(
      `SELECT owner_principal_id,record_json FROM "${f.schema}".creative_projects WHERE project_id=$1`,
      [created.project.projectId],
    );
    assert.equal(
      stored.rows[0]!.owner_principal_id,
      pluginRouteActor.principalId,
    );
    assert.equal(
      stored.rows[0]!.record_json.createdByActorId,
      pluginRouteActor.actorId,
    );
    for (const table of ["run_snapshots", "threads", "messages", "outbox"]) {
      const count = await f.observer.query<{ count: string }>(
        `SELECT count(*) AS count FROM "${f.schema}".${table}`,
      );
      assert.equal(count.rows[0]!.count, "0");
    }
    const paidTables = await f.observer.query<{ count: string }>(
      "SELECT count(*) AS count FROM information_schema.tables WHERE table_schema=$1 AND table_name IN ('plugin_credit_entries','extension_credit_admissions','external_operations')",
      [f.schema],
    );
    assert.equal(paidTables.rows[0]!.count, "0");
  },
);
