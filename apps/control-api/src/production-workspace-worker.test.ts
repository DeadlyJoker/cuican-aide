import assert from "node:assert/strict";
import test from "node:test";

import {
  WorkspaceListCommandFactoryError,
  WorkspaceListDispatchError,
} from "@crewon/application";
import {
  RUNTIME_WORKER_WORKSPACE_DISPATCH_PATH,
  RUNTIME_WORKER_WORKSPACE_FREEZE_COMMAND_PATH,
} from "@crewon/contracts";

import { resolveProductionWorkspaceWorkers } from "./production-workspace-environment.ts";
import {
  ProductionWorkspaceWorkerClient,
  RuntimeWorkspaceWorkerClientError,
  TenantRoutedProductionWorkspaceWorker,
  type ProductionWorkspaceWorkerRegistry,
} from "./workspace-runtime-worker-client.ts";
import {
  TOKEN,
  dispatchResponse,
  factoryInput,
  freezeResponse,
  jsonResponse,
  lease,
  operation,
} from "./workspace-runtime-worker-client.test-support.ts";

const ROUTE = {
  tenantId: "tenant-1",
  runtimeBindingId: "runtime-binding-1",
  workspaceBindingId: "workspace-1",
} as const;

test("production Worker requires HTTPS unless loopback is explicit test transport", async () => {
  const config = {
    ...ROUTE,
    origin: "http://127.0.0.1:3211",
    token: TOKEN,
  };
  assert.throws(
    () => new ProductionWorkspaceWorkerClient(config),
    (error) =>
      error instanceof RuntimeWorkspaceWorkerClientError &&
      error.code === "runtime_workspace_worker_origin_invalid",
  );
  await new ProductionWorkspaceWorkerClient(config, {
    allowTestLoopback: true,
  }).close();
  await new ProductionWorkspaceWorkerClient({
    ...config,
    origin: "https://workspace.internal.example",
  }).close();
});

test("production Worker authenticates strict wire and fences the frozen route echo", async () => {
  const requests: Array<{ authorization: string | null; path: string }> = [];
  const worker = client(async (input, init = {}) => {
    requests.push({
      authorization: new Headers(init.headers).get("authorization"),
      path: new URL(String(input)).pathname,
    });
    return jsonResponse(freezeResponse());
  });
  assert.deepEqual(
    await worker.create(factoryInput(), new AbortController().signal),
    freezeResponse().command,
  );
  assert.deepEqual(requests, [
    {
      authorization: `Bearer ${TOKEN}`,
      path: RUNTIME_WORKER_WORKSPACE_FREEZE_COMMAND_PATH,
    },
  ]);

  const drift = client(async () =>
    jsonResponse({
      ...freezeResponse(),
      command: {
        ...freezeResponse().command,
        runtimeBindingId: "runtime-binding-drift",
      },
    }),
  );
  await assert.rejects(
    drift.create(factoryInput(), new AbortController().signal),
    (error) =>
      error instanceof WorkspaceListCommandFactoryError &&
      error.kind === "invalidAuthority",
  );
});

test("registry dispatches only the exact frozen tenant and binding route", async () => {
  const resolved: unknown[] = [];
  let closed = 0;
  const worker = client(async (input, init = {}) => {
    const phase = JSON.parse(
      Buffer.from(init.body as Uint8Array).toString("utf8"),
    ).phase;
    return String(input).endsWith(RUNTIME_WORKER_WORKSPACE_DISPATCH_PATH)
      ? jsonResponse(dispatchResponse(phase))
      : jsonResponse(freezeResponse());
  });
  const registry: ProductionWorkspaceWorkerRegistry = {
    resolveForCreate: (input) => {
      resolved.push(input);
      return input.tenantId === ROUTE.tenantId ? worker : null;
    },
    resolve: (route) => {
      resolved.push(route);
      return JSON.stringify(route) === JSON.stringify(ROUTE) ? worker : null;
    },
    close: () => {
      closed += 1;
      return worker.close();
    },
  };
  const routed = new TenantRoutedProductionWorkspaceWorker(registry);
  await routed.create(factoryInput(), new AbortController().signal);
  await routed.execute(
    operation("prepared"),
    lease("execute"),
    new AbortController().signal,
  );
  assert.deepEqual(resolved, [
    { tenantId: "tenant-1", spaceId: "space-1", threadId: "thread-1" },
    ROUTE,
  ]);
  await assert.rejects(
    routed.execute(
      {
        ...operation("prepared"),
        command: {
          ...operation("prepared").command,
          workspaceBindingId: "workspace-drift",
        },
      },
      lease("execute"),
      new AbortController().signal,
    ),
    (error) =>
      error instanceof WorkspaceListDispatchError &&
      error.certainty === "notSent",
  );
  await routed.close();
  await routed.close();
  assert.equal(closed, 1);
});

test("registry resolution preserves caller cancellation", async () => {
  const never = new Promise<ProductionWorkspaceWorkerClient | null>(() => {});
  const routed = new TenantRoutedProductionWorkspaceWorker({
    resolveForCreate: () => never,
    resolve: () => never,
    close: () => {},
  });
  const abort = new AbortController();
  const reason = new Error("caller-cancelled");
  const pending = routed.create(factoryInput(), abort.signal);
  abort.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
});

test("production environment requires one authenticated active route per tenant", async () => {
  assert.throws(
    () => resolveProductionWorkspaceWorkers({}),
    /CREWON_WORKSPACE_TENANT_ROUTES_JSON_required/u,
  );
  const route = {
    ...ROUTE,
    origin: "https://workspace.internal.example",
    token: TOKEN,
  };
  const registry = resolveProductionWorkspaceWorkers({
    CREWON_WORKSPACE_TENANT_ROUTES_JSON: JSON.stringify([route]),
  });
  assert.ok(
    (await registry.resolve(ROUTE)) instanceof ProductionWorkspaceWorkerClient,
  );
  assert.equal(
    await registry.resolve({ ...ROUTE, workspaceBindingId: "other" }),
    null,
  );
  await registry.close();

  for (const routes of [
    [{ ...route, origin: "http://127.0.0.1:3211" }],
    [route, { ...route, workspaceBindingId: "workspace-2" }],
  ]) {
    assert.throws(
      () =>
        resolveProductionWorkspaceWorkers({
          CREWON_WORKSPACE_TENANT_ROUTES_JSON: JSON.stringify(routes),
        }),
      /CREWON_WORKSPACE_TENANT_ROUTES_JSON_invalid/u,
    );
  }
});

function client(fetch: typeof globalThis.fetch) {
  return new ProductionWorkspaceWorkerClient(
    {
      ...ROUTE,
      origin: "http://127.0.0.1:3211",
      token: TOKEN,
    },
    { allowTestLoopback: true, fetch },
  );
}
