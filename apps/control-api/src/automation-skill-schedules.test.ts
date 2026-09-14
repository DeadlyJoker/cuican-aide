import assert from "node:assert/strict";
import { test } from "node:test";
import { AutomationApplicationService } from "@crewon/application";
import { skillJson } from "@crewon/domain";
import { AutomationScheduler } from "./automation-scheduler.ts";
import {
  setup,
  actor,
  digest,
  route,
  spec,
  version,
} from "./automation-skill-schedules.test-support.ts";
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

for (const explicitMode of [false, true]) {
  test(`F04 manual-only Skill dates (${explicitMode ? "explicit" : "default"}) validate at creation and freeze actual run time`, async (context) => {
    const f = await setup(context, "sqlite");
    const service = f.services().automations;
    const { executionMode: _mode, ...command } = f.command;
    const created = await service.createAutomation(actor, {
      ...command,
      ...(explicitMode ? { executionMode: "manualOnly" as const } : {}),
      schedule: {
        ...f.command.schedule,
        scheduleType: "once",
        nextRunAt: "9999-12-31T23:59:59Z",
        intervalSeconds: 0,
      },
    });
    assert.deepEqual(f.calls[0]?.invocation.parameters, {
      start: "2026-09-07",
      end: "2026-09-13",
    });
    assert.equal(
      created.record.definition.schedule.nextRunAt,
      "9999-12-31T23:59:59Z",
    );
    f.setNow("2026-09-20T17:00:00.000Z");
    const result = await service.runAutomationNow(actor, {
      kind: "automation.runNow",
      idempotencyKey: "manual-date-run",
      automationId: created.record.definition.automationId,
      expectedAutomationRevision: 1,
      expectedThreadRevision: 1,
    });
    assert.equal(result.binding.scheduledFor, f.now());
    assert.deepEqual(result.binding.skillInvocation?.parameters, {
      start: "2026-09-14",
      end: "2026-09-20",
    });
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
    f.services().automations.createAutomation(actor, {
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

test("F04-R03/R04 readiness returns specific recoverable state and validates delivery scope without a Run", async (context) => {
  const f = await setup(context);
  const service = f.services().automations;
  const created = await service.createAutomation(actor, f.command);
  const id = created.record.definition.automationId;
  f.setFailure("skill_access_denied");
  assert.deepEqual(await service.checkAutomationReadiness(actor, id), {
    state: "blocked",
    code: "skill_access_denied",
  });
  f.setFailure(null);
  assert.deepEqual(await service.checkAutomationReadiness(actor, id), {
    state: "ready",
    code: null,
  });
  assert.equal((await f.store.listPendingWorkItems(100)).length, 0);
  const target = {
    schemaVersion: "crewon.delivery-target.v1" as const,
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    threadId: "another-thread",
    targetId: "thread-deliveries" as const,
  };
  await assert.rejects(
    service.createAutomation(actor, {
      ...f.command,
      idempotencyKey: "wrong-target",
      skillInvocation: { ...spec, deliveryTarget: target },
    }),
    /automation_delivery_target_mismatch/,
  );
});

test("F04-R05/R06 SQLite: persisted Run resolves exact occurrence parameters after restart and cancellation", async (context) => {
  const f = await setup(context, "sqlite");
  const service = f.services().automations;
  const created = await service.createAutomation(actor, f.command);
  const command = {
    kind: "automation.runNow" as const,
    idempotencyKey: "manual-first",
    automationId: created.record.definition.automationId,
    expectedAutomationRevision: 1 as const,
    expectedThreadRevision: 1,
  };
  const invoked = await service.runAutomationNow(actor, command);
  const { resolveAutomationSkillForRun, RunApplicationService } = await import(
    "@crewon/application"
  );
  const expected = {
    ...spec,
    parameters: { start: "2026-09-07", end: "2026-09-13" },
  };
  assert.deepEqual(invoked.binding.skillInvocation, expected);
  f.setNow("2026-10-05T00:00:00.000Z");
  await f.restart();
  const resolved = await resolveAutomationSkillForRun(
    { store: f.store, digester: digest },
    actor,
    invoked.runState.runId,
  );
  assert.deepEqual(resolved?.invocation, expected);
  assert.equal(resolved?.scheduledFor, "2026-09-13T16:05:00.000Z");
  await assert.rejects(
    resolveAutomationSkillForRun(
      { store: f.store, digester: digest },
      { ...actor, spaceId: "other-space" },
      invoked.runState.runId,
    ),
    /run_not_found/,
  );
  const runs = new RunApplicationService({
    store: f.store,
    clock: { now: f.now },
    ids: { nextId: (kind) => `cancel-${kind}` },
    authorization: { authorize: async () => ({ outcome: "allow" }) },
  });
  const canceled = await runs.transitionRun(actor, {
    kind: "run.requestCancel",
    runId: invoked.runState.runId,
    expectedRevision: 1,
    idempotencyKey: "cancel-existing",
  });
  assert.equal(canceled.state.cancelRequested, true);
  // Receipt replay after cancellation is historical identity, not a new queued execution.
  assert.equal(
    (await f.services().automations.runAutomationNow(actor, command)).binding
      .runId,
    invoked.runState.runId,
  );
  assert.equal((await f.store.listPendingWorkItems(100)).length, 1);
  const forged = new Proxy(f.store, {
    get(target, property) {
      if (property === "loadRun")
        return async () => ({
          ...invoked.runState,
          origin: {
            kind: "automation",
            binding: {
              ...invoked.binding,
              skillInvocation: {
                ...expected,
                parameters: { start: "1999-01-01", end: "1999-01-07" },
              },
            },
          },
        });
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await assert.rejects(
    resolveAutomationSkillForRun(
      { store: forged, digester: digest },
      actor,
      invoked.runState.runId,
    ),
    /automation_skill_invocation_mismatch/,
  );
});

test("F04-R01 legacy run-only authorization does not acquire a new automation:read requirement", async (context) => {
  const f = await setup(context);
  const {
    skillInvocation: _skill,
    parameterBindings: _bindings,
    ...legacy
  } = f.command;
  const created = await f
    .services()
    .automations.createAutomation(actor, legacy);
  let sequence = 0;
  const actions: string[] = [];
  const automations = new AutomationApplicationService({
    store: f.store,
    clock: { now: f.now },
    digester: digest,
    ids: { nextId: (kind) => `run-only-${kind}-${++sequence}` },
    routeResolver: { resolveRoute: async () => route },
    authorization: {
      authorize: async (request) => {
        actions.push(request.action);
        return {
          outcome: request.action === "automation:read" ? "deny" : "allow",
        };
      },
    },
  });
  const { buildControlApi } = await import("./control-api.ts");
  const app = buildControlApi({
    automations,
    outboxWakeup: { wake: async () => undefined },
    identity: { resolveActor: async () => actor },
    heartbeatIntervalMs: null,
  } as unknown as Parameters<typeof buildControlApi>[0]);
  context.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/automations/${created.record.definition.automationId}:run-now`,
    headers: { "idempotency-key": "legacy-run-only" },
    payload: { expectedThreadRevision: 1, expectedAutomationRevision: 1 },
  });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(actions.includes("automation:read"), false);
});
