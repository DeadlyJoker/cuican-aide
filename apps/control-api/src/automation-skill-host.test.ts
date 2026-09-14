import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import {
  compileAgentVersion,
  createAgentVersionAsset,
} from "@crewon/agent-version";
import {
  compileAgentVersionReleaseBundle,
  type DemonstratedSkillRecord,
} from "@crewon/application";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { createSkillVersion } from "@crewon/domain";
import { SqliteDemonstratedSkillStore, SqliteRunStore } from "@crewon/store";
import { NodeSha256ContentDigester } from "./standalone-adapters.ts";
import { createStandaloneControlApi } from "./standalone-composition.ts";

const actor = {
  principalId: "host-principal",
  actorId: "host-owner",
  tenantId: "host-tenant",
  spaceId: "host-space",
};
const digester = new NodeSha256ContentDigester();
const createdAt = "2026-09-01T00:00:00.000Z";
const headers = {
  "authorization": `Bearer ${"s".repeat(32)}`,
  "origin": "http://localhost:3000",
  "x-csrf-token": "c".repeat(32),
  "x-crewon-automation-version": "1",
};

async function hostFixture(t: TestContext, requiredTool = "browser") {
  const directory = mkdtempSync(join(tmpdir(), "f04-real-skill-host-"));
  const databasePath = join(directory, "state.sqlite");
  const runs = new SqliteRunStore(databasePath);
  const skillStore = new SqliteDemonstratedSkillStore(databasePath, digester);
  const agent = compileAgentVersion(
    {
      schemaVersion: "crewon.agent-version-source.v0",
      agentVersionId: "host-agent",
      runtimeGeneration: "ts-v0",
      policySnapshotId: "host-policy",
      instructions: null,
      model: {
        adapterName: "direct-responses",
        adapterVersion: "1",
        modelId: "host-model",
        contextWindowTokens: 128000,
        autoCompactAtTokens: 96000,
      },
      execution: { streamMaxRetries: 2, maxToolRounds: 16 },
      resources: { workspaceRequired: false, governedContextDigest: null },
      tools: [
        {
          schemaVersion: "crewon.tool-definition.v0",
          kind: "function",
          name: "browser",
          description: "Browser",
          execution: "serial",
          inputSchema: { type: "object" },
        },
      ],
    },
    digester,
  );
  await runs.registerAgentVersion(
    createAgentVersionAsset({
      tenantId: actor.tenantId,
      createdAt,
      version: agent,
    }),
  );
  const bundle = compileAgentVersionReleaseBundle(
    {
      tenantId: actor.tenantId,
      defaultAgentVersionId: agent.agentVersionId,
      deployments: [
        {
          schemaVersion: "crewon.agent-version-deployment.v0",
          tenantId: actor.tenantId,
          agentVersionId: agent.agentVersionId,
          contentDigest: agent.contentDigest,
          materializationDigest: digester.sha256("host-test-materialization"),
          authorityId: "host-authority",
          workspaceBindingId: null,
        },
      ],
    },
    digester,
  );
  await runs.activateAgentVersionRelease({
    bundle,
    expectedActiveReleaseId: null,
    activation: {
      schemaVersion: "crewon.agent-version-release-activation.v0",
      tenantId: actor.tenantId,
      releaseId: bundle.releaseId,
      activationId: "host-release",
      previousReleaseId: null,
      operator: {
        principalId: actor.principalId,
        actorId: actor.actorId,
        spaceId: actor.spaceId,
      },
      activatedAt: createdAt,
    },
  });
  // Seed an already activated version as the precondition of scheduling. This is
  // synthetic test data, not evidence of a real trial, model call or browser action.
  // Every save/read/execute admission below uses the production standalone host.
  const record: DemonstratedSkillRecord = {
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    ownerActorId: actor.actorId,
    skillId: "host-skill",
    revision: 1,
    draft: {
      name: "Export a date",
      purpose: "Export the selected date",
      steps: ["Select the date and verify the output"],
      parameters: [
        { name: "date", label: "Date", type: "string", required: true },
      ],
      requiredToolRefs: [requiredTool],
      completionCriteria: ["Output matches the date"],
      knownExceptions: ["Request login when unavailable"],
      runtimeRequirements: ["Authorized browser"],
    },
    source: {
      recordingId: "host-fixture",
      revision: 1,
      contentDigest: digester.sha256("host-fixture"),
      provenance: "contract-fixture",
    },
    disabled: false,
    deleted: false,
    activatedVersionIds: [],
    createdAt,
    updatedAt: createdAt,
  };
  await skillStore.saveSkill(record, 0);
  const version = createSkillVersion(
    {
      skillId: record.skillId,
      versionId: "v1",
      method: record.draft,
      source: record.source,
      createdAt,
    },
    digester,
  );
  await skillStore.putVersion(record, version);
  await skillStore.saveSkill(
    { ...record, revision: 2, activatedVersionIds: [version.ref.versionId] },
    1,
  );
  const open = () =>
    createStandaloneControlApi({
      databasePath,
      actor,
      defaultAgentVersionId: agent.agentVersionId,
      sessionToken: "s".repeat(32),
      csrfToken: "c".repeat(32),
      allowedOrigins: [headers.origin],
      artifactStore: new InMemoryArtifactStore(),
      artifactEncryptionKeyId: "host-artifact-key",
      heartbeatIntervalMs: null,
      outboxScanIntervalMs: null,
      automationScanIntervalMs: null,
    });
  let host = open();
  t.after(async () => {
    await host.app.close();
    await skillStore.close();
    await runs.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const created = await host.app.inject({
    method: "POST",
    url: "/api/v1/threads",
    headers: { ...headers, "idempotency-key": "host-thread" },
    payload: { title: "Skill schedule" },
  });
  assert.equal(created.statusCode, 201, created.body);
  const threadId = created.json().thread.threadId as string;
  const body = {
    threadId,
    expectedThreadRevision: 1,
    title: "Fixed Skill date",
    prompt: "Use the fixed Skill",
    agentVersionId: null,
    schedule: {
      scheduleType: "once",
      nextRunAt: "2026-09-07T16:00:00.000Z",
      intervalSeconds: 0,
      time: "00:00",
      weekday: 2,
      timezone: "Asia/Shanghai",
    },
    skillInvocation: {
      schemaVersion: "crewon.skill-invocation.v1",
      skill: version.ref,
      parameters: { date: "template-date" },
      requiredToolRefs: [requiredTool],
    },
    parameterBindings: { date: "runDate" },
  };
  return {
    get host() {
      return host;
    },
    runs,
    databasePath,
    skillStore,
    record,
    version,
    threadId,
    body,
    async restart() {
      await host.app.close();
      host = open();
    },
    async save() {
      return host.app.inject({
        method: "POST",
        url: "/api/v1/automations",
        headers: { ...headers, "idempotency-key": "host-schedule" },
        payload: body,
      });
    },
    async disable(disabled: boolean) {
      const current = await skillStore.getSkill(record);
      assert.ok(current);
      const response = await host.app.inject({
        method: "POST",
        url: `/api/v1/skills/${record.skillId}/disable`,
        headers,
        payload: { expectedRevision: current.revision, disabled },
      });
      assert.equal(response.statusCode, 200, response.body);
    },
  };
}

test("F04 real standalone Skill host: scheduled Run admission, persisted date, revocation and restart use SQLite authority", async (t) => {
  const f = await hostFixture(t);
  const saved = await f.save();
  assert.equal(saved.statusCode, 201, saved.body);
  const automationId = saved.json().automation.automationId as string;
  const view = () =>
    f.host.app.inject({ url: `/api/v1/automations/${automationId}`, headers });
  assert.deepEqual((await view()).json().automation.skillReadiness, {
    state: "ready",
    code: null,
  });
  const before = await f.runs.listPendingWorkItems(100);
  assert.equal(before.length, 0);

  await f.disable(true);
  await f.host.automationScheduler.wake();
  assert.equal(f.host.automationScheduler.lastFailureCode(), "skill_disabled");
  assert.deepEqual(await f.runs.listPendingWorkItems(100), before);
  assert.deepEqual((await view()).json().automation.skillReadiness, {
    state: "blocked",
    code: "skill_disabled",
  });
  assert.equal(
    (
      await f.runs.listMessages(
        { tenantId: actor.tenantId, threadId: f.threadId },
        0,
        100,
      )
    ).length,
    0,
  );

  await f.disable(false);
  const current = await f.skillStore.getSkill(f.record);
  assert.ok(current);
  const edited = await f.host.app.inject({
    method: "PATCH",
    url: `/api/v1/skills/${f.record.skillId}`,
    headers,
    payload: {
      expectedRevision: current.revision,
      method: {
        ...current.draft,
        steps: ["Unsealed replacement draft must not execute"],
      },
    },
  });
  assert.equal(edited.statusCode, 200, edited.body);
  await f.host.automationScheduler.wake();
  assert.equal(f.host.automationScheduler.lastFailureCode(), null);
  const work = await f.runs.listPendingWorkItems(100);
  assert.equal(work.length, 1);
  const runId = work[0]!.runId;
  const lookup = () =>
    f.host.app.inject({
      url: `/api/v1/runs/${runId}/skill-invocation`,
      headers,
    });
  const admitted = await lookup();
  assert.equal(admitted.statusCode, 200, admitted.body);
  assert.deepEqual(admitted.json(), {
    threadId: f.threadId,
    skillVersionRef: f.version.ref,
    parameters: { date: "2026-09-08" },
  });
  const messages = await f.runs.listMessages(
    { tenantId: actor.tenantId, threadId: f.threadId },
    0,
    100,
  );
  assert.equal(messages.length, 1);
  assert.match(messages[0]!.content, /2026-09-08/);
  assert.doesNotMatch(messages[0]!.content, /Unsealed replacement/);
  assert.equal(
    (await f.host.app.inject({ url: `/api/v1/runs/${runId}/skill-invocation` }))
      .statusCode,
    401,
  );

  await f.disable(true);
  const revoked = await lookup();
  assert.equal(revoked.statusCode, 403, revoked.body);
  assert.equal(revoked.json().error.code, "skill_disabled");
  await f.restart();
  await f.host.automationScheduler.wake();
  // The persisted occurrence receipt is replayed without issuing a second Run.
  assert.equal(f.host.automationScheduler.lastFailureCode(), null);
  assert.deepEqual(await f.runs.listPendingWorkItems(100), work);
  assert.equal((await lookup()).statusCode, 403);
  await f.disable(false);
  assert.deepEqual((await lookup()).json(), admitted.json());
  const cancel = await f.host.app.inject({
    method: "POST",
    url: `/api/v1/runs/${runId}:cancel`,
    headers: { ...headers, "idempotency-key": "host-cancel" },
    payload: { expectedRevision: 1 },
  });
  assert.equal(cancel.statusCode, 200, cancel.body);
  assert.equal(
    (await f.runs.loadRun({ tenantId: actor.tenantId, runId }))
      ?.cancelRequested,
    true,
  );
});

test("F04 standalone Skill host rejects undeclared AgentVersion tools before storing the schedule", async (t) => {
  const f = await hostFixture(t, "unavailable-tool");
  const saved = await f.save();
  assert.equal(saved.statusCode, 403, saved.body);
  assert.equal(saved.json().error.code, "skill_tool_unavailable");
  assert.equal((await f.runs.listPendingWorkItems(100)).length, 0);
  const listed = await f.host.app.inject({
    url: "/api/v1/automations",
    headers,
  });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.deepEqual(listed.json().data, []);
});

test("F04 SQLite transaction rejects disable after save admission without persisting a schedule or receipt", async (t) => {
  const f = await hostFixture(t);
  const commit = SqliteRunStore.prototype.commitAutomationCreate;
  let interleave = true;
  t.mock.method(
    SqliteRunStore.prototype,
    "commitAutomationCreate",
    async function (this: SqliteRunStore, input: Parameters<typeof commit>[0]) {
      if (interleave) {
        interleave = false;
        await f.disable(true);
      }
      return commit.call(this, input);
    },
  );
  const rejected = await f.save();
  assert.equal(rejected.statusCode, 403, rejected.body);
  assert.equal(rejected.json().error.code, "skill_disabled");
  assert.deepEqual(
    (await f.host.app.inject({ url: "/api/v1/automations", headers })).json()
      .data,
    [],
  );
  assert.equal((await f.runs.listPendingWorkItems(100)).length, 0);
  await f.disable(false);
  const retry = await f.save();
  assert.equal(retry.statusCode, 201, retry.body);
  await f.disable(true);
  const receipt = await f.save();
  assert.equal(receipt.statusCode, 200, receipt.body);
  assert.deepEqual(receipt.json().automation, retry.json().automation);
});

test("F04 SQLite transaction rejects disable after execution admission without a Run and preserves retry identity", async (t) => {
  const f = await hostFixture(t);
  assert.equal((await f.save()).statusCode, 201);
  const commit = SqliteRunStore.prototype.commitAutomationInvocation;
  let interleave = true;
  t.mock.method(
    SqliteRunStore.prototype,
    "commitAutomationInvocation",
    async function (this: SqliteRunStore, input: Parameters<typeof commit>[0]) {
      if (interleave) {
        interleave = false;
        await f.disable(true);
      }
      return commit.call(this, input);
    },
  );
  await f.host.automationScheduler.wake();
  assert.equal(f.host.automationScheduler.lastFailureCode(), "skill_disabled");
  assert.equal((await f.runs.listPendingWorkItems(100)).length, 0);
  assert.equal(
    (
      await f.runs.listMessages(
        { tenantId: actor.tenantId, threadId: f.threadId },
        0,
        100,
      )
    ).length,
    0,
  );
  assert.equal(
    (
      await f.host.app.inject({
        url: `/api/v1/threads/${f.threadId}/active-run`,
        headers,
      })
    ).json().run,
    null,
  );
  await f.disable(false);
  await f.host.automationScheduler.wake();
  assert.equal(f.host.automationScheduler.lastFailureCode(), null);
  const work = await f.runs.listPendingWorkItems(100);
  assert.equal(work.length, 1);
  await f.disable(true);
  await f.restart();
  await f.host.automationScheduler.wake();
  assert.equal(f.host.automationScheduler.lastFailureCode(), null);
  assert.deepEqual(await f.runs.listPendingWorkItems(100), work);
});

for (const mutation of [
  "missing-authority",
  "changed-version",
  "digest-column",
  "revision-column",
] as const) {
  test(`F04 SQLite transaction fails closed on ${mutation} after execution admission`, async (t) => {
    const f = await hostFixture(t);
    const saved = await f.save();
    assert.equal(saved.statusCode, 201, saved.body);
    const database = new DatabaseSync(f.databasePath);
    t.after(() => database.close());
    const commit = SqliteRunStore.prototype.commitAutomationInvocation;
    t.mock.method(
      SqliteRunStore.prototype,
      "commitAutomationInvocation",
      async function (
        this: SqliteRunStore,
        input: Parameters<typeof commit>[0],
      ) {
        if (mutation === "missing-authority")
          database.exec("DROP TABLE demonstrated_skill_versions");
        else if (mutation === "digest-column")
          database
            .prepare(
              "UPDATE demonstrated_skill_versions SET content_digest = ?",
            )
            .run(digester.sha256("changed indexed digest"));
        else if (mutation === "revision-column")
          database.exec(
            "UPDATE demonstrated_skills SET revision = revision + 1",
          );
        else {
          const changed = createSkillVersion(
            {
              skillId: f.version.ref.skillId,
              versionId: f.version.ref.versionId,
              createdAt: f.version.createdAt,
              source: f.version.source,
              method: {
                ...f.version.method,
                steps: ["A different method must not enter this Run"],
              },
            },
            digester,
          );
          database
            .prepare(
              "UPDATE demonstrated_skill_versions SET version_json = ?, content_digest = ?",
            )
            .run(JSON.stringify(changed), changed.ref.contentDigest);
        }
        return commit.call(this, input);
      },
    );
    const response = await f.host.app.inject({
      method: "POST",
      url: `/api/v1/automations/${saved.json().automation.automationId}:run-now`,
      headers: { ...headers, "idempotency-key": "fence-invalid-authority" },
      payload: { expectedAutomationRevision: 1, expectedThreadRevision: 1 },
    });
    assert.equal(response.statusCode, 409, response.body);
    const codes = {
      "missing-authority": "skill_authority_unavailable",
      "changed-version": "skill_ref_mismatch",
      "digest-column": "skill_digest_mismatch",
      "revision-column": "skill_store_corrupt",
    };
    assert.equal(response.json().error.code, codes[mutation]);
    assert.equal((await f.runs.listPendingWorkItems(100)).length, 0);
    assert.equal(
      (
        await f.runs.listMessages(
          { tenantId: actor.tenantId, threadId: f.threadId },
          0,
          100,
        )
      ).length,
      0,
    );
  });
}
