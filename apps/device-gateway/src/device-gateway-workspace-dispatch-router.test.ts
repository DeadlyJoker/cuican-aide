import assert from "node:assert/strict";
import test from "node:test";

import type {
  DeviceWorkspaceListDispatchResolution,
  DeviceWorkspaceListPeerRoute,
} from "@crewon/contracts";

import type { DeviceConnectionRouteStorePort } from "./device-connection-route-store.ts";
import { DeviceGatewayWorkspaceDispatchRouter } from "./device-gateway-workspace-dispatch-router.ts";
import { DeviceGatewayError } from "./device-gateway-error.ts";
import {
  command,
  completedResolution,
  route,
} from "./workspace-dispatch-store-conformance.test-support.ts";

const worker = {
  workerId: "worker-1",
  credentialId: "credential-1",
  authenticationMethod: "mtls" as const,
  authenticatedAt: "2026-08-09T00:00:00.000Z",
};

test("returns receipt-first terminal replay without reading route or peer", async () => {
  let routeReads = 0;
  let peerCalls = 0;
  const router = new DeviceGatewayWorkspaceDispatchRouter({
    gatewayId: "gateway-1",
    routes: routes(async () => {
      routeReads += 1;
      return assert.fail("route read not expected");
    }),
    local: localDispatch(async () => completedResolution()),
    peers: {
      async dispatch() {
        peerCalls += 1;
        return assert.fail("peer dispatch not expected");
      },
    },
  });

  assert.deepEqual(
    await router.reconcile(worker, reference()),
    completedResolution(),
  );
  assert.deepEqual({ routeReads, peerCalls }, { routeReads: 0, peerCalls: 0 });
});

test("forwards one remote owner hop with the authenticated source Worker", async () => {
  const forwarded: unknown[] = [];
  const router = new DeviceGatewayWorkspaceDispatchRouter({
    gatewayId: "gateway-1",
    routes: routes(async () => connectionRoute("gateway-2")),
    local: localDispatch(async () => {
      throw new DeviceGatewayError("device_unavailable");
    }),
    peers: {
      async dispatch(route, operation, input, sourceWorker, signal) {
        forwarded.push({
          route,
          operation,
          input,
          sourceWorker,
          aborted: signal.aborted,
        });
        return completedResolution();
      },
    },
  });

  assert.deepEqual(
    await router.execute(worker, command()),
    completedResolution(),
  );
  assert.deepEqual(forwarded, [
    {
      route: peerRoute("gateway-2"),
      operation: "execute",
      input: command(),
      sourceWorker: { workerId: "worker-1", credentialId: "credential-1" },
      aborted: false,
    },
  ]);
});

test("never recursively forwards a stale route that still names this Gateway", async () => {
  let peerCalls = 0;
  const router = new DeviceGatewayWorkspaceDispatchRouter({
    gatewayId: "gateway-1",
    routes: routes(async () => connectionRoute("gateway-1")),
    local: localDispatch(async () => {
      throw new DeviceGatewayError("device_unavailable");
    }),
    peers: {
      async dispatch() {
        peerCalls += 1;
        return completedResolution();
      },
    },
  });

  await assert.rejects(
    router.cancel(worker, reference()),
    hasCode("workspace_dispatch_route_unavailable"),
  );
  assert.equal(peerCalls, 0);
});

function localDispatch(
  dispatch: () => Promise<DeviceWorkspaceListDispatchResolution>,
) {
  return {
    execute: dispatch,
    reconcile: dispatch,
    cancel: dispatch,
  } as never;
}

function routes(
  loadConnection: DeviceConnectionRouteStorePort["loadConnection"],
): DeviceConnectionRouteStorePort {
  return {
    loadConnection,
    claimConnection: async () => assert.fail("claim not expected"),
    renewConnection: async () => assert.fail("renew not expected"),
    releaseConnection: async () => assert.fail("release not expected"),
  };
}

function connectionRoute(gatewayId: string) {
  return {
    deviceId: "device-1",
    gatewayId,
    connectionId: "connection-1",
    epoch: 3,
    leaseExpiresAt: "2026-08-09T00:05:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
  };
}

function peerRoute(gatewayId: string): DeviceWorkspaceListPeerRoute {
  return { ...route(), gatewayId };
}

function reference() {
  const value = command();
  return {
    deviceId: value.deviceId,
    executionId: value.executionId,
    workspaceBindingId: value.workspaceBindingId,
    incarnationId: value.incarnationId,
    deviceBindingId: value.deviceBindingId,
    runtimeBindingId: value.runtimeBindingId,
    actionDigest: value.actionDigest,
    commandDigest: value.commandDigest,
    receiptId: null,
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && "code" in error && error.code === code;
}
