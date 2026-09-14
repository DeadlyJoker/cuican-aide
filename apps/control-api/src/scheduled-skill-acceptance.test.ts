import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ModelTransportPort } from "@crewon/agent-kernel";
import type { DemonstratedSkillRecord } from "@crewon/application";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { ControlApiClient } from "@crewon/control-client";
import { createSkillVersion } from "@crewon/domain";
import {
  activateStandaloneRuntimeAgentVersionRelease,
  createStandaloneRuntimeWorker,
  type RuntimeWorkerCompositionConfig,
} from "@crewon/runtime-worker";
import {
  SqliteDeliveryStore,
  SqliteDemonstratedSkillStore,
} from "@crewon/store";
import {
  prepareScheduledSkillAcceptance,
  type ScheduledSkillAcceptanceOptions,
  type ScheduledSkillToolPermissionMode,
} from "../../crewon-ui/scripts/browser-execution/scheduled-skill-acceptance.ts";
import { NodeSha256ContentDigester } from "./standalone-adapters.ts";
import { createStandaloneControlApi } from "./standalone-composition.ts";

// These are real Control HTTP/SQLite/scheduler/Worker composition tests with a
// deliberately fake model transport and a seeded activation precondition. They
// verify scheduling/provenance/replay, not real trial eligibility or XLSX output.
// The independent F05 script supplies the real reviewed trial and actual model.
for (const mode of ["requestApproval", "approveForMe"] as const) {
  test(`scheduler acceptance preserves ${mode} through due Run, Worker completion and replay`, async (t) => {
    const fixture = await setup(t, { activated: true, mode });
    const result = await prepareScheduledSkillAcceptance(fixture.options);
    assert.equal(result.invocationReceiptCount, 1);
    assert.equal(result.toolPermissionMode, mode);
    assert.deepEqual(
      result.binding.skillInvocation,
      fixture.options.invocation,
    );
    assert.equal(result.scheduledFor, fixture.options.dueAt);
    const completed = await waitForCompletion(fixture.client, result.run.runId);
    assert.equal(completed.status, "completed");
    assert.equal(fixture.modelCalls(), 1);

    // Repeat after the Thread revision has changed and the Run is terminal.
    const replay = await prepareScheduledSkillAcceptance(fixture.options);
    assert.equal(
      replay.automation.automationId,
      result.automation.automationId,
    );
    assert.equal(replay.run.runId, result.run.runId);
    assert.equal(replay.invocationReceiptCount, 1);
    assert.equal(fixture.modelCalls(), 1);
    const changed =
      mode === "approveForMe" ? "requestApproval" : "approveForMe";
    await assert.rejects(
      prepareScheduledSkillAcceptance({
        ...fixture.options,
        toolPermissionMode: changed,
      }),
    );
    assert.equal(fixture.count("automations"), 1);
    assert.equal(fixture.count("run_snapshots"), 1);
    assert.equal(
      fixture.paths.filter((path) => path === "POST /api/v1/automations")
        .length,
      3,
    );
    assert.ok(
      fixture.paths.some(
        (path) =>
          path === `GET /api/v1/runs/${result.run.runId}/skill-invocation`,
      ),
    );
    assert.ok(
      !fixture.paths.some((path) =>
        /run-now|\/executions|POST \/api\/v1\/runs/.test(path),
      ),
    );
  });
}

test("scheduler helper uses real F03 activation and refuses an unreviewed fixture before creating any automation", async (t) => {
  const fixture = await setup(t, { activated: false, mode: "requestApproval" });
  await assert.rejects(
    prepareScheduledSkillAcceptance(fixture.options),
    /skill_reviewed_trial_required/,
  );
  assert.ok(
    fixture.paths.some(
      (path) => path === "POST /api/v1/skills/scheduler-fixture/activate",
    ),
  );
  assert.equal(fixture.count("automations"), 0);
  assert.equal(fixture.count("run_snapshots"), 0);
  assert.equal(fixture.modelCalls(), 0);
});

test("scheduler helper rejects wrong fixed version and target before activation or scheduling", async (t) => {
  const fixture = await setup(t, { activated: true, mode: "requestApproval" });
  fixture.paths.length = 0;
  await assert.rejects(
    prepareScheduledSkillAcceptance({
      ...fixture.options,
      fixedVersion: {
        ...fixture.options.fixedVersion,
        versionId: "other-version",
      },
    }),
    /fixed version mismatch/,
  );
  await assert.rejects(
    prepareScheduledSkillAcceptance({
      ...fixture.options,
      invocation: {
        ...fixture.options.invocation,
        deliveryTarget: {
          ...fixture.options.invocation.deliveryTarget!,
          threadId: "other-thread",
        },
      },
    }),
  );
  assert.deepEqual(fixture.paths, []);
  assert.equal(fixture.count("automations"), 0);
});

async function setup(
  t: TestContext,
  choice: { activated: boolean; mode: ScheduledSkillToolPermissionMode },
) {
  const directory = mkdtempSync(join(tmpdir(), "f04-scheduler-acceptance-"));
  const databasePath = join(directory, "control.sqlite");
  const actor = {
    principalId: "scheduler-principal",
    actorId: "scheduler-owner",
    tenantId: "scheduler-tenant",
    spaceId: "scheduler-space",
  };
  const digester = new NodeSha256ContentDigester();
  let modelCalls = 0;
  const transport: ModelTransportPort = {
    adapterName: "fake-adapter",
    adapterVersion: "1",
    modelId: "scheduler-fixture-model",
    async *stream() {
      modelCalls++;
      yield { type: "completed", checkpoint: null };
    },
  };
  const config: RuntimeWorkerCompositionConfig = {
    runtimeTenantId: actor.tenantId,
    route: {
      authorityId: "scheduler-authority",
      runtimeGeneration: "ts-v0",
      agentVersionId: "scheduler-agent",
      policySnapshotId: "scheduler-policy",
      workspaceBindingId: null,
    },
    transport,
    agentInstructions: "Run the saved Skill parameters.",
    streamMaxRetries: 0,
    maxToolRounds: 4,
    autoCompactAtTokens: 96_000,
    modelContextWindowTokens: 128_000,
  };
  await activateStandaloneRuntimeAgentVersionRelease({
    ...config,
    databasePath,
    actor,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => "2026-09-01T00:00:00.000Z" },
    activationId: "scheduler-release-fixture",
  });
  const skills = new SqliteDemonstratedSkillStore(databasePath, digester);
  const createdAt = "2026-09-01T00:00:00.000Z";
  const record: DemonstratedSkillRecord = {
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    ownerActorId: actor.actorId,
    skillId: "scheduler-fixture",
    revision: 1,
    draft: {
      name: "Use a saved date",
      purpose: "Verify scheduled parameters",
      steps: ["Use the configured date"],
      parameters: [
        { name: "date", label: "Date", type: "string", required: true },
      ],
      requiredToolRefs: [],
      completionCriteria: ["The configured date is used"],
      knownExceptions: ["Missing date prevents completion"],
      runtimeRequirements: [],
    },
    source: {
      recordingId: "explicit-synthetic-scheduler-precondition",
      revision: 1,
      contentDigest: digester.sha256(
        "explicit-synthetic-scheduler-precondition",
      ),
      provenance: "contract-fixture",
    },
    disabled: false,
    deleted: false,
    activatedVersionIds: [],
    createdAt,
    updatedAt: createdAt,
  };
  await skills.saveSkill(record, 0);
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
  await skills.putVersion(record, version);
  if (choice.activated)
    await skills.saveSkill(
      { ...record, revision: 2, activatedVersionIds: [version.ref.versionId] },
      1,
    );
  const control = createStandaloneControlApi({
    databasePath,
    actor,
    defaultAgentVersionId: config.route.agentVersionId,
    sessionToken: "s".repeat(32),
    csrfToken: "c".repeat(32),
    allowedOrigins: ["http://localhost:3000"],
    artifactStore: new InMemoryArtifactStore(),
    artifactEncryptionKeyId: "scheduler-fixture-key",
    deliveryStore: new SqliteDeliveryStore({
      databasePath: join(directory, "deliveries.sqlite"),
      encryptionKey: new Uint8Array(32).fill(17),
    }),
    heartbeatIntervalMs: null,
    outboxScanIntervalMs: null,
    automationScanIntervalMs: 25,
  });
  const runtime = await createStandaloneRuntimeWorker({
    ...config,
    databasePath,
    scanIntervalMs: 25,
  });
  runtime.worker.start();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  t.after(async () => {
    await control.app.close();
    await runtime.close();
    await skills.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const baseUrl = await control.app.listen({ host: "127.0.0.1", port: 0 });
  const paths: string[] = [];
  const observedFetch: typeof fetch = (input, init) => {
    paths.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
    return fetch(input, init);
  };
  const client = new ControlApiClient({
    baseUrl,
    accessToken: "s".repeat(32),
    csrfToken: "c".repeat(32),
    origin: "http://localhost:3000",
    fetch: observedFetch,
  });
  const request: ScheduledSkillAcceptanceOptions["request"] = async (
    path,
    body,
    method = "POST",
    key,
  ) => {
    const response = await observedFetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "authorization": `Bearer ${"s".repeat(32)}`,
        "x-csrf-token": "c".repeat(32),
        "origin": "http://localhost:3000",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(key === undefined ? {} : { "idempotency-key": key }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    const result: unknown = await response.json();
    assert.ok(response.ok, JSON.stringify(result));
    return result;
  };
  const { thread } = await client.createThread(
    { title: "Scheduled acceptance fixture" },
    "scheduler-thread",
  );
  const catalog = await client.delivery.catalog(thread.threadId);
  const options: ScheduledSkillAcceptanceOptions = {
    client,
    request,
    fixedVersion: version.ref,
    threadId: thread.threadId,
    expectedThreadRevision: thread.revision,
    invocation: {
      schemaVersion: "crewon.skill-invocation.v1",
      skill: version.ref,
      parameters: { date: "2026-09-13" },
      requiredToolRefs: [],
      deliveryTarget: catalog.target,
    },
    title: "Acceptance fixture",
    idempotencyKey: "scheduler-acceptance-once",
    dueAt: new Date(Date.now() + 1_000).toISOString(),
    databasePath,
    toolPermissionMode: choice.mode,
    timeoutMs: 10_000,
  };
  return {
    options,
    client,
    paths,
    modelCalls: () => modelCalls,
    count: (table: "automations" | "run_snapshots") =>
      database.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count,
  };
}

async function waitForCompletion(client: ControlApiClient, runId: string) {
  const signal = AbortSignal.timeout(5_000);
  for (;;) {
    const { run } = await client.getRun(runId, { signal });
    if (["completed", "failed", "canceled", "needsHuman"].includes(run.status))
      return run;
    await delay(25, undefined, { signal });
  }
}
