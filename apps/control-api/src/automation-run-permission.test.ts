import { parseCreateAutomationRequest } from "@crewon/contracts";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveAutomationSkillForRun,
  type DomainStore,
  type AutomationStore,
  type AutomationInvocationResult,
} from "@crewon/application";
import {
  matchesAutomationRunPermissionMode,
  parseAutomationDefinition,
  skillJson,
} from "@crewon/domain";
import { ControlApiClient } from "@crewon/control-client";
import { validateAutomationInvocationResult } from "../../../packages/store/src/automation-store-invocation-validation.ts";
import { buildControlApi } from "./control-api.ts";
import { AutomationScheduler } from "./automation-scheduler.ts";
import {
  setup,
  actor,
  digest,
} from "./automation-skill-schedules.test-support.ts";

for (const backend of ["memory", "sqlite"] as const) {
  for (const mode of [undefined, "requestApproval", "approveForMe"] as const) {
    test(`${backend}: Skill schedule freezes ${mode ?? "default"} through restart, scheduler and receipt replay`, async (context) => {
      const f = await setup(context, backend);
      const command = {
        ...f.command,
        ...(mode === undefined ? {} : { toolPermissionMode: mode }),
      };
      const created = await f
        .services()
        .automations.createAutomation(actor, command);
      assert.equal(
        created.record.definition.toolPermissionMode,
        mode ?? "requestApproval",
      );
      await f.restart();
      const services = f.services();
      assert.equal(
        (await services.automations.createAutomation(actor, command))
          .disposition,
        "replayed",
      );
      await assert.rejects(
        services.automations.createAutomation(actor, {
          ...command,
          toolPermissionMode:
            mode === "approveForMe" ? "requestApproval" : "approveForMe",
        }),
        /idempotency.*conflict/,
      );
      const scheduler = new AutomationScheduler(
        { store: f.store, ...services, now: f.now },
        { scanIntervalMs: null },
      );
      context.after(() => scheduler.close());
      await scheduler.wake();
      assert.equal(scheduler.lastFailureCode(), null);
      const work = await f.store.listPendingWorkItems(100);
      assert.equal(work.length, 1);
      const run = await f.store.loadRun({
        tenantId: actor.tenantId,
        runId: work[0]!.runId,
      });
      assert.equal(run?.toolPermissionMode, mode ?? "requestApproval");
      assert.ok(
        await resolveAutomationSkillForRun(
          { store: f.store, digester: digest },
          actor,
          run!.runId,
        ),
      );
      await scheduler.wake();
      assert.deepEqual(await f.store.listPendingWorkItems(100), work);
      assert.equal(
        (
          await services.automations.getAutomation(
            actor,
            created.record.definition.automationId,
          )
        ).toolPermissionMode,
        mode ?? "requestApproval",
      );
    });
  }
}

function intercept(
  store: DomainStore & AutomationStore,
  method: string,
  replacement: (...args: any[]) => unknown,
): DomainStore & AutomationStore {
  return new Proxy(store, {
    get(target, property) {
      if (property === method) return replacement;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

for (const backend of ["memory", "sqlite"] as const) {
  test(`${backend}: transaction rejects substituted permission without partial Run; resolver and receipt reject drift`, async (context) => {
    const f = await setup(context, backend);
    const created = await f
      .services()
      .automations.createAutomation(actor, f.command);
    const command = {
      kind: "automation.runNow" as const,
      automationId: created.record.definition.automationId,
      expectedAutomationRevision: 1 as const,
      expectedThreadRevision: 1,
      idempotencyKey: "invoke",
    };
    const forged = intercept(f.store, "commitAutomationInvocation", (input) =>
      f.store.commitAutomationInvocation({
        ...input,
        runEvent: {
          ...input.runEvent,
          data: { ...input.runEvent.data, toolPermissionMode: "approveForMe" },
        },
      }),
    );
    await assert.rejects(
      f
        .services(undefined, forged)
        .automations.runAutomationNow(actor, command),
      /automation_invocation_authority_mismatch/,
    );
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
    const result = await f
      .services()
      .automations.runAutomationNow(actor, command);
    const changed: AutomationInvocationResult = {
      ...result,
      runEvent: {
        ...result.runEvent,
        data: { ...result.runEvent.data, toolPermissionMode: "approveForMe" },
      },
      runState: { ...result.runState, toolPermissionMode: "approveForMe" },
    };
    assert.throws(
      () => validateAutomationInvocationResult(changed),
      /automation_invocation_authority_mismatch/,
    );
    const receipts = intercept(
      f.store,
      "loadAutomationInvocationReceipt",
      async () => changed,
    );
    await assert.rejects(
      f
        .services(undefined, receipts)
        .automations.runAutomationNow(actor, command),
      /automation_invocation_receipt_invalid/,
    );
    const runs = intercept(f.store, "loadRun", async () => changed.runState);
    await assert.rejects(
      resolveAutomationSkillForRun(
        { store: runs, digester: digest },
        actor,
        result.runState.runId,
      ),
      /automation_run_binding_invalid/,
    );
  });
}

test("old v1 definition and receipt omit mode without changing their digest; only requestApproval is effective", async (context) => {
  const f = await setup(context);
  const created = await f
    .services()
    .automations.createAutomation(actor, f.command);
  const result = await f
    .services()
    .automations.runAutomationNow(actor, {
      kind: "automation.runNow",
      automationId: created.record.definition.automationId,
      expectedAutomationRevision: 1,
      expectedThreadRevision: 1,
      idempotencyKey: "legacy-run",
    });
  const { toolPermissionMode: _mode, ...oldDefinition } =
    result.record.definition;
  const parsed = parseAutomationDefinition(oldDefinition);
  assert.deepEqual(parsed, oldDefinition);
  assert.equal(
    digest.sha256(skillJson(parsed)),
    digest.sha256(skillJson(oldDefinition)),
  );
  assert.equal(matchesAutomationRunPermissionMode(parsed, undefined), true);
  assert.equal(
    matchesAutomationRunPermissionMode(parsed, "requestApproval"),
    true,
  );
  assert.equal(
    matchesAutomationRunPermissionMode(parsed, "approveForMe"),
    false,
  );
  const record = {
    ...result.record,
    definition: parsed,
    definitionDigest: digest.sha256(skillJson(parsed)),
  };
  const binding = {
    ...result.binding,
    definitionDigest: record.definitionDigest,
  };
  const origin = { kind: "automation" as const, binding };
  const { toolPermissionMode: _eventMode, ...eventData } = result.runEvent.data;
  const { toolPermissionMode: _runMode, ...runState } = result.runState;
  const old = {
    ...result,
    record,
    binding,
    message: { ...result.message, origin },
    historyItem: { ...result.historyItem, origin },
    runEvent: { ...result.runEvent, data: { ...eventData, origin } },
    runState: { ...runState, origin },
    workItem: {
      ...result.workItem,
      payload: { ...result.workItem.payload, binding },
    },
  };
  assert.doesNotThrow(() => validateAutomationInvocationResult(old));
});

test("HTTP and real client preserve explicit mode and reject widening, v0 mode, changed create key and response drift", async (context) => {
  const f = await setup(context);
  const app = buildControlApi({
    ...f.services(),
    identity: { resolveActor: async () => actor },
    outboxWakeup: { wake: async () => {} },
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
  const body = {
    ...rest,
    agentVersionId: null,
    toolPermissionMode: "approveForMe" as const,
  };
  const headers = {
    "content-type": "application/json",
    "idempotency-key": "http-mode",
    "x-crewon-automation-version": "1",
  };
  for (const toolPermissionMode of ["fullAccess", null, "unknown"]) {
    const rejected = await app.inject({
      method: "POST",
      url: "/api/v1/automations",
      headers,
      payload: { ...body, toolPermissionMode },
    });
    assert.equal(rejected.statusCode, 400, rejected.body);
  }
  const { skillInvocation: _skill, parameterBindings: _bindings, ...v0 } = body;
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/automations",
        headers,
        payload: v0,
      })
    ).statusCode,
    400,
  );
  let drift = false;
  let driftMode: unknown;
  const client = new ControlApiClient({
    baseUrl: "http://control.test",
    csrfToken: "fixture",
    fetch: async (url, init) => {
      const requestHeaders: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        requestHeaders[key] = value;
      });
      const reply = await app.inject({
        method: (init?.method as "GET" | "POST") ?? "GET",
        url: new URL(String(url)).pathname,
        headers: requestHeaders,
        ...(init?.body ? { payload: String(init.body) } : {}),
      });
      const response = reply.json();
      if (drift && response.automation)
        response.automation.toolPermissionMode = driftMode;
      return new Response(JSON.stringify(response), {
        status: reply.statusCode,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const created = await client.createAutomation(
    parseCreateAutomationRequest(body),
    "http-mode",
  );
  assert.equal(created.automation.toolPermissionMode, "approveForMe");
  assert.equal(
    (await client.getAutomation(created.automation.automationId)).automation
      .toolPermissionMode,
    "approveForMe",
  );
  const changed = await app.inject({
    method: "POST",
    url: "/api/v1/automations",
    headers,
    payload: { ...body, toolPermissionMode: "requestApproval" },
  });
  assert.equal(changed.statusCode, 409, changed.body);
  drift = true;
  for (driftMode of [undefined, "fullAccess", null, "unknown"]) {
    await assert.rejects(
      client.createAutomation(parseCreateAutomationRequest(body), "http-mode"),
      /control_client_automation_(create_response|view)_invalid/,
    );
  }
  drift = false;
  const invoked = await client.runAutomationNow(
    created.automation.automationId,
    { expectedAutomationRevision: 1, expectedThreadRevision: 1 },
    "http-run",
  );
  assert.equal(invoked.automation.toolPermissionMode, "approveForMe");
  assert.equal(
    (
      await f.store.loadRun({
        tenantId: actor.tenantId,
        runId: invoked.run.runId,
      })
    )?.toolPermissionMode,
    "approveForMe",
  );
});
