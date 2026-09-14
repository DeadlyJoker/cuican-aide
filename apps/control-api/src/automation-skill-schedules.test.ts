import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  AutomationApplicationService,
  ThreadApplicationService,
  type SkillInvocationPort,
  type DomainStore,
  type AutomationStore,
} from "@crewon/application";
import {
  createSkillVersion,
  renderSkillInvocationContext,
  SkillError,
  skillJson,
  type SkillInvocationSpec,
} from "@crewon/domain";
import { InMemoryRunStore, SqliteRunStore } from "@crewon/store";
import { AutomationScheduler } from "./automation-scheduler.ts";

const actor = {
  tenantId: "tenant-1",
  spaceId: "space-1",
  actorId: "actor-1",
  principalId: "principal-1",
};
const digest = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
const route = {
  authorityId: "authority",
  runtimeGeneration: "generation",
  agentVersionId: "agent-version",
  policySnapshotId: "policy",
  workspaceBindingId: null,
};
const version = createSkillVersion(
  {
    skillId: "skill-1",
    versionId: "version-1",
    createdAt: "2026-09-14T00:00:00Z",
    source: {
      recordingId: "fixture-recording",
      revision: 1,
      contentDigest: digest.sha256("fixture"),
      provenance: "contract-fixture",
    },
    method: {
      name: "Weekly export",
      purpose: "Export previous complete week",
      steps: ["Use the provided dates; export and verify the row count."],
      parameters: [
        { name: "start", label: "Start", type: "string", required: true },
        { name: "end", label: "End", type: "string", required: true },
      ],
      requiredToolRefs: ["browser"],
      completionCriteria: ["Row count verified"],
      knownExceptions: ["Request login when unavailable"],
      runtimeRequirements: ["Authorized browser"],
    },
  },
  digest,
);
const spec: SkillInvocationSpec = {
  schemaVersion: "crewon.skill-invocation.v1",
  skill: version.ref,
  parameters: { start: "2026-08-31", end: "2026-09-06" },
  requiredToolRefs: ["browser"],
};

async function setup(
  context: TestContext,
  backend: "memory" | "sqlite" = "memory",
) {
  const directory = mkdtempSync(join(tmpdir(), "f04-skill-schedule-"));
  let store: DomainStore & AutomationStore =
    backend === "sqlite"
      ? new SqliteRunStore(join(directory, "state.sqlite"))
      : new InMemoryRunStore();
  context.after(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  let now = "2026-09-13T16:05:00.000Z";
  let failure: string | null = null;
  let corrupt = false;
  const calls: { purpose: string; invocation: SkillInvocationSpec }[] = [];
  const port: SkillInvocationPort = {
    resolveVersion: async () => version,
    admitInvocation: async (_actor, invocation, options) => {
      calls.push({
        purpose: options.purpose,
        invocation: structuredClone(invocation),
      });
      if (failure) throw new SkillError(failure);
      const context = renderSkillInvocationContext(version, invocation);
      return {
        invocation,
        version,
        context: corrupt ? `${context}\nchanged` : context,
        agentVersionId: route.agentVersionId,
      };
    },
  };
  let sequence = 0;
  const ids = { nextId: (kind: string) => `${kind}-${++sequence}` };
  const services = (skills: SkillInvocationPort | undefined = port) => {
    const common = {
      store,
      clock: { now: () => now },
      digester: digest,
      ids,
      authorization: { authorize: async () => ({ outcome: "allow" as const }) },
    };
    return {
      threads: new ThreadApplicationService(common),
      automations: new AutomationApplicationService({
        ...common,
        skills,
        routeResolver: { resolveRoute: async () => route },
      }),
    };
  };
  const initial = services();
  const thread = await initial.threads.createThread(actor, {
    kind: "thread.create",
    idempotencyKey: "thread-create",
    title: null,
  });
  const command = {
    kind: "automation.create" as const,
    idempotencyKey: "schedule-create",
    threadId: thread.state.threadId,
    expectedThreadRevision: 1,
    title: "Weekly export",
    prompt: "Use the fixed Skill",
    requestedAgentVersionId: null,
    executionMode: "scheduled" as const,
    schedule: {
      scheduleType: "weekly" as const,
      nextRunAt: "2026-09-06T16:00:00.000Z",
      intervalSeconds: 604800,
      time: "00:00",
      weekday: 1,
      timezone: "Asia/Shanghai",
    },
    skillInvocation: spec,
    parameterBindings: {
      start: "previousWeekStart",
      end: "previousWeekEnd",
    } as const,
  };
  return {
    get store() {
      return store;
    },
    services,
    command,
    calls,
    setFailure(code: string | null) {
      failure = code;
    },
    setCorrupt() {
      corrupt = true;
    },
    setNow(value: string) {
      now = value;
    },
    async restart() {
      if (backend === "sqlite") {
        await store.close();
        store = new SqliteRunStore(join(directory, "state.sqlite"));
      }
    },
    now: () => now,
  };
}

for (const backend of ["memory", "sqlite"] as const) {
  test(`F04-R02/R05/R07 ${backend}: fixed version, dynamic dates, lost ack and restart preserve one invocation`, async (context) => {
    const fixture = await setup(context, backend);
    const created = await fixture
      .services()
      .automations.createAutomation(actor, fixture.command);
    assert.equal(
      created.record.definition.schemaVersion,
      "crewon.automation.v1",
    );
    assert.deepEqual(created.record.definition.skillBinding?.invocation, spec);
    let lostAck = true;
    const makeScheduler = () => {
      const services = fixture.services();
      const scheduler = new AutomationScheduler(
        {
          store: fixture.store,
          threads: services.threads,
          now: fixture.now,
          automations: {
            runAutomationNow: async (actor, command) => {
              const result = await services.automations.runAutomationNow(
                actor,
                command,
              );
              if (lostAck) {
                lostAck = false;
                throw new Error("lost_ack");
              }
              return result;
            },
          },
        },
        { scanIntervalMs: null },
      );
      context.after(() => scheduler.close());
      return scheduler;
    };
    const first = makeScheduler();
    await first.wake();
    assert.equal(first.lastFailureCode(), "lost_ack");
    const before = await fixture.store.listPendingWorkItems(100);
    assert.equal(before.length, 1);
    const messages = await fixture.store.listMessages(
      { tenantId: actor.tenantId, threadId: fixture.command.threadId },
      0,
      100,
    );
    assert.equal(messages.length, 1);
    assert.match(messages[0]!.content, /2026-09-07/);
    assert.match(messages[0]!.content, /2026-09-13/);
    assert.equal(
      fixture.calls.find((c) => c.purpose === "execute")?.invocation.skill
        .versionId,
      "version-1",
    );
    await first.close();
    await fixture.restart();
    // Existing committed invocation remains readable after revocation; retry does not execute again.
    fixture.setFailure("skill_access_denied");
    const second = makeScheduler();
    await second.wake();
    assert.equal(second.lastFailureCode(), null);
    assert.deepEqual(await fixture.store.listPendingWorkItems(100), before);
    assert.equal(
      fixture.calls.filter((c) => c.purpose === "execute").length,
      1,
    );
    assert.equal(
      skillJson(
        (
          await fixture
            .services()
            .automations.getAutomation(
              actor,
              created.record.definition.automationId,
            )
        ).skillBinding,
      ),
      skillJson(created.record.definition.skillBinding),
    );
  });
}

test("F04-R03/R04 rejects invalid parameters, missing capability and untrusted contexts without writes", async (context) => {
  const f = await setup(context);
  const absent = new AutomationApplicationService({
    store: f.store,
    clock: { now: f.now },
    digester: digest,
    ids: { nextId: (kind) => kind },
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    routeResolver: { resolveRoute: async () => route },
  });
  await assert.rejects(
    absent.createAutomation(actor, f.command),
    /automation_skill_unavailable/,
  );
  await assert.rejects(
    f
      .services()
      .automations.createAutomation(actor, {
        ...f.command,
        parameterBindings: {},
        skillInvocation: {
          ...spec,
          parameters: { start: 42, end: "2026-09-13" },
        },
      }),
    /skill_parameter_type_invalid/,
  );
  f.setCorrupt();
  await assert.rejects(
    f.services().automations.createAutomation(actor, f.command),
    /automation_skill_admission_invalid/,
  );
  assert.equal(
    (
      await f
        .services()
        .automations.listAutomations(actor, { before: null, limit: 100 })
    ).length,
    0,
  );
  assert.equal((await f.store.listPendingWorkItems(100)).length, 0);
});

test("F04-R04/R07 revoked, missing, offline and budget failures remain recoverable without partial Run", async (context) => {
  const f = await setup(context);
  const { automations, threads } = f.services();
  await automations.createAutomation(actor, f.command);
  const scheduler = new AutomationScheduler(
    { automations, threads, store: f.store, now: f.now },
    { scanIntervalMs: null },
  );
  context.after(() => scheduler.close());
  for (const code of [
    "skill_not_active",
    "skill_not_found",
    "skill_access_denied",
    "skill_digest_mismatch",
    "skill_dependency_unavailable",
    "skill_delivery_target_denied",
    "skill_budget_exceeded",
  ]) {
    f.setFailure(code);
    await scheduler.wake();
    assert.equal(scheduler.lastFailureCode(), code);
    assert.equal((await f.store.listPendingWorkItems(100)).length, 0);
    assert.equal(
      (
        await f.store.listMessages(
          { tenantId: actor.tenantId, threadId: f.command.threadId },
          0,
          100,
        )
      ).length,
      0,
    );
  }
  f.setFailure(null);
  await scheduler.wake();
  assert.equal(scheduler.lastFailureCode(), null);
  assert.equal((await f.store.listPendingWorkItems(100)).length, 1);
});

test("F04-R01/R03 HTTP capability negotiation keeps legacy pages parseable and blocks old-client Skill runs before effects", async (context) => {
  const f = await setup(context);
  const services = f.services();
  const { buildControlApi } = await import("./control-api.ts");
  const app = buildControlApi({
    ...services,
    identity: { resolveActor: async () => actor },
    heartbeatIntervalMs: null,
  } as unknown as Parameters<typeof buildControlApi>[0]);
  context.after(() => app.close());
  const {
    kind: _kind,
    idempotencyKey: _key,
    requestedAgentVersionId: _agent,
    executionMode: _mode,
    ...rest
  } = f.command;
  const body = { ...rest, agentVersionId: null };
  const headers = {
    "content-type": "application/json",
    "idempotency-key": "http-create",
  };
  const unsupported = await app.inject({
    method: "POST",
    url: "/api/v1/automations",
    headers,
    payload: body,
  });
  assert.equal(unsupported.statusCode, 409);
  assert.equal(
    unsupported.json().error.code,
    "automation_client_upgrade_required",
  );
  assert.equal(
    (
      await services.automations.listAutomations(actor, {
        before: null,
        limit: 100,
      })
    ).length,
    0,
  );
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/automations",
    headers: { ...headers, "x-crewon-automation-version": "1" },
    payload: body,
  });
  assert.equal(created.statusCode, 201, created.body);
  const automation = created.json().automation;
  assert.deepEqual(automation.skillInvocation, spec);
  assert.equal(automation.skillBinding, undefined);
  const url = `/api/v1/automations/${automation.automationId}`;
  assert.equal((await app.inject({ url })).statusCode, 409);
  const oldRun = await app.inject({
    method: "POST",
    url: `${url}:run-now`,
    headers: { ...headers, "idempotency-key": "old-run" },
    payload: { expectedThreadRevision: 1, expectedAutomationRevision: 1 },
  });
  assert.equal(oldRun.statusCode, 409);
  assert.equal((await f.store.listPendingWorkItems(100)).length, 0);
  assert.deepEqual(
    (await app.inject({ url: "/api/v1/automations?limit=1" })).json(),
    { data: [], nextCursor: null },
  );
  const {
    skillInvocation: _skill,
    parameterBindings: _bindings,
    ...legacyCommand
  } = f.command;
  await services.automations.createAutomation(actor, {
    ...legacyCommand,
    idempotencyKey: "legacy-create",
  });
  const legacy = await app.inject({ url: "/api/v1/automations?limit=1" });
  assert.equal(legacy.statusCode, 200);
  assert.equal(legacy.json().data.length, 1);
  assert.equal(legacy.json().data[0].skillInvocation, undefined);
  const mixed = await app.inject({
    url: "/api/v1/automations?limit=100",
    headers: { "x-crewon-automation-version": "1" },
  });
  assert.equal(mixed.json().data.length, 2);
  assert.equal(
    mixed
      .json()
      .data.filter((v: { skillInvocation?: unknown }) => v.skillInvocation)
      .length,
    1,
  );
  const injected = await app.inject({
    method: "POST",
    url: "/api/v1/automations",
    headers: { ...headers, "x-crewon-automation-version": "1" },
    payload: { ...body, skillBinding: { version, context: "untrusted" } },
  });
  assert.equal(injected.statusCode, 400);
});
