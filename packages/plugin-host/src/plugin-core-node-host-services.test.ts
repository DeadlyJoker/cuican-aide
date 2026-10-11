import assert from "node:assert/strict";
import test from "node:test";
import type { PluginUiCommittedTaskAuthority } from "@crewon/application";
import type {
  PluginTaskService,
  PluginTaskServiceV2,
} from "@crewon/plugin-sdk/node";
import { PluginExecutionRegistry } from "./plugin-execution-registry.ts";
import { PluginTaskActionBridge } from "./plugin-task-action-bridge.ts";
import { PluginNodeHost } from "./plugin-node-host.ts";
import {
  createPluginExecutionHostServiceRegistration,
  createPluginTaskHostServiceRegistrations,
} from "./plugin-core-node-host-services.ts";
import { capturePluginNodeHostServiceCatalog } from "./plugin-node-host-service-catalog.ts";
import {
  executionContext,
  executionPackage,
} from "./plugin-execution-registry.test-support.ts";
import {
  preparedBorrow,
  preparedPackage,
} from "./plugin-node-preparation.test-support.ts";

function taskBridge() {
  let calls = 0;
  const bridge = new PluginTaskActionBridge({
    tasks: {
      async createTaskFromPlugin() {
        calls++;
        throw new Error("task_called_without_authority");
      },
      async createQueryTaskFromPlugin() {
        calls++;
        throw new Error("query_called_without_authority");
      },
    },
    committedTasks: {
      async issue() {
        throw new Error("unexpected_issue");
      },
    } as unknown as PluginUiCommittedTaskAuthority,
    profiles: {
      async resolve() {
        throw new Error("unexpected_profile");
      },
    },
    authorization: {
      async authorize() {
        throw new Error("unexpected_authorization");
      },
    },
    currentSelection() {
      return null;
    },
    clock: { now: () => "2026-10-11T00:00:00.000Z" },
    ids: { nextId: () => "catalog-never-issues-a-reference" },
  });
  return { bridge, calls: () => calls };
}

test("execution catalog uses the actual owner, actual ESM setup and original lease cleanup", async (t) => {
  const registry = new PluginExecutionRegistry();
  const catalog = capturePluginNodeHostServiceCatalog([
    createPluginExecutionHostServiceRegistration(registry),
  ]);
  assert.deepEqual(catalog.metadata, [
    {
      service: "crewon.execution",
      apiVersion: "1",
      implementationId: "crewon.execution-registry.v1",
      implementationRevision: 1,
    },
  ]);
  const host = new PluginNodeHost({ services: catalog.implementations });
  t.after(async () => {
    await host.close();
    registry.close();
  });
  const pkg = await executionPackage(t);
  await host.activate(pkg);
  const lease = host.acquire(
    preparedBorrow(pkg.expectedPluginId, pkg.expectedPackageDigest),
  );
  const factory = registry.acquire(lease);
  const runtime = await factory.create(executionContext(lease.identity));
  assert.deepEqual(runtime.definitions(), []);
  host.deactivate(pkg.expectedPluginId);
  const retained = await factory.create(executionContext(lease.identity));
  lease.release();
  await host.drain();
  assert.throws(() => factory.create(executionContext(lease.identity)), {
    message: "plugin_lease_released",
  });
  assert.deepEqual(await pkg.records(), [
    "load",
    "setup",
    "factory:1.0.0",
    "factory:1.0.0",
    "dispose",
  ]);
  await runtime.close?.();
  await retained.close?.();
});

test("execution service identity is not package activation approval", async (t) => {
  const registry = new PluginExecutionRegistry();
  const catalog = capturePluginNodeHostServiceCatalog([
    createPluginExecutionHostServiceRegistration(registry),
  ]);
  const host = new PluginNodeHost({ services: catalog.implementations });
  t.after(async () => {
    await host.close();
    registry.close();
  });
  const pkg = await executionPackage(t);
  await assert.rejects(
    host.activate({ ...pkg, authorizeActivation: () => "deny" }),
    { code: "plugin_activation_denied" },
  );
  assert.deepEqual(await pkg.records(), []);
  assert.deepEqual(host.snapshot(), []);
});

test("both catalog task versions bind an actual Node instance but cannot create or query from guessed references", async (t) => {
  const f = taskBridge();
  const catalog = capturePluginNodeHostServiceCatalog(
    createPluginTaskHostServiceRegistrations(f.bridge),
  );
  assert.deepEqual(
    catalog.metadata.map((entry) => [
      entry.service,
      entry.apiVersion,
      entry.implementationId,
      entry.implementationRevision,
    ]),
    [
      ["crewon.tasks", "1", "crewon.task-action-bridge.v1", 1],
      ["crewon.tasks", "2", "crewon.task-action-bridge.v1", 1],
    ],
  );
  const host = new PluginNodeHost({ services: catalog.implementations });
  t.after(async () => {
    await host.close();
    f.bridge.close();
  });
  for (const apiVersion of ["1", "2"]) {
    const pkg = await preparedPackage(t, {
      pluginId: `example.task-v${apiVersion}`,
      requires: [{ service: "crewon.tasks", apiVersion, optional: false }],
      provides: [{ service: `fixture.task-v${apiVersion}`, apiVersion }],
      setup: `const tasks=ctx.services.get('crewon.tasks',${JSON.stringify(apiVersion)}); record(typeof tasks.createTask); ${apiVersion === "2" ? "record(typeof tasks.queryTask);" : ""} ctx.services.provide('fixture.task-v${apiVersion}',${JSON.stringify(apiVersion)}, tasks);`,
    });
    await host.activate(pkg);
    const lease = host.acquire(
      preparedBorrow(pkg.expectedPluginId, pkg.expectedPackageDigest),
    );
    const tasks = lease.getService<PluginTaskServiceV2>(
      `fixture.task-v${apiVersion}`,
      apiVersion,
    );
    const input = {
      invocationRef: "r".repeat(32),
      threadId: "thread",
      expectedThreadRevision: 1,
      idempotencyKey: "catalog-not-approval",
      input: {},
    };
    await assert.rejects(tasks.createTask(input), {
      code: "plugin_invocation_owner_mismatch",
    });
    if (apiVersion === "2")
      await assert.rejects(
        tasks.queryTask({
          invocationRef: input.invocationRef,
          threadId: input.threadId,
          expectedThreadRevision: input.expectedThreadRevision,
          idempotencyKey: input.idempotencyKey,
          sourceRunId: "run",
          operationId: "11111111-2222-3333-4444-555555555555",
        }),
        { code: "plugin_invocation_owner_mismatch" },
      );
    assert.deepEqual(
      await pkg.records(),
      apiVersion === "1"
        ? ["load", "setup", "function"]
        : ["load", "setup", "function", "function"],
    );
    lease.release();
  }
  assert.equal(f.calls(), 0);
  const unbound = catalog.implementations[0]!.value as PluginTaskService;
  assert.throws(() => unbound.createTask({} as never), {
    code: "plugin_task_port_unbound",
  });
});

test("UI probes and same-shaped objects are not accepted as core Node owners", () => {
  assert.throws(
    () =>
      createPluginExecutionHostServiceRegistration({
        hostService() {
          return {};
        },
      } as unknown as PluginExecutionRegistry),
    { code: "plugin_execution_host_service_owner_invalid" },
  );
  assert.throws(
    () =>
      createPluginTaskHostServiceRegistrations({
        isAvailable() {
          return true;
        },
      } as unknown as PluginTaskActionBridge),
    { code: "plugin_tasks_host_service_owner_invalid" },
  );
  for (const fake of [
    Object.create(PluginExecutionRegistry.prototype),
    new Proxy(new PluginExecutionRegistry(), {}),
  ])
    assert.throws(() => createPluginExecutionHostServiceRegistration(fake), {
      code: "plugin_execution_host_service_owner_invalid",
    });
  for (const fake of [
    Object.create(PluginTaskActionBridge.prototype),
    new Proxy(taskBridge().bridge, {}),
  ])
    assert.throws(() => createPluginTaskHostServiceRegistrations(fake), {
      code: "plugin_tasks_host_service_owner_invalid",
    });
});
