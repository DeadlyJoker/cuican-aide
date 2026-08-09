import assert from "node:assert/strict";
import test from "node:test";

import type {
  DeviceDispatchOperation,
  DeviceExecutionCommand,
  DeviceGatewayDispatchResolution,
} from "@crewon/contracts";

import {
  InMemoryDeviceConnectionRouteStore,
  type DeviceConnectionRoute,
} from "./device-connection-route-store.ts";
import {
  DeviceGatewayDispatchRouter,
  type DeviceGatewayPeerDispatchPort,
} from "./device-gateway-dispatch-router.ts";

test("forwards to the Gateway holding the current Device route fence", async () => {
  const routes = new InMemoryDeviceConnectionRouteStore(
    () => new Date("2026-08-09T00:00:00.000Z"),
  );
  await routes.claimConnection({
    deviceId: "device-1",
    gatewayId: "gateway-2",
    connectionId: "connection-2",
    leaseDurationMs: 30_000,
  });
  const calls: string[] = [];
  let second: DeviceGatewayDispatchRouter;
  const peers: DeviceGatewayPeerDispatchPort = {
    dispatch: (route, operation, input) => {
      calls.push(`forward:${route.gatewayId}:${route.epoch}`);
      return second.dispatchExpected(route, operation, input);
    },
  };
  const first = router({
    gatewayId: "gateway-1",
    connectionId: null,
    routes,
    peers,
    calls,
  });
  second = router({
    gatewayId: "gateway-2",
    connectionId: "connection-2",
    routes,
    peers,
    calls,
  });

  assert.deepEqual(await first.execute(command()), completed());
  assert.deepEqual(calls, ["forward:gateway-2:1", "local:gateway-2:execute"]);
});

test("rejects a forwarded operation after the Device route epoch changes", async () => {
  const routes = new InMemoryDeviceConnectionRouteStore(
    () => new Date("2026-08-09T00:00:00.000Z"),
  );
  const stale = await routes.claimConnection({
    deviceId: "device-1",
    gatewayId: "gateway-1",
    connectionId: "connection-1",
    leaseDurationMs: 30_000,
  });
  const target = router({
    gatewayId: "gateway-1",
    connectionId: "connection-1",
    routes,
    peers: unavailablePeers(),
    calls: [],
  });
  await routes.claimConnection({
    deviceId: "device-1",
    gatewayId: "gateway-2",
    connectionId: "connection-2",
    leaseDurationMs: 30_000,
  });

  await assert.rejects(
    target.dispatchExpected(stale, "cancel", command()),
    hasCode("device_connection_route_stale"),
  );
});

function router(config: {
  gatewayId: string;
  connectionId: string | null;
  routes: InMemoryDeviceConnectionRouteStore;
  peers: DeviceGatewayPeerDispatchPort;
  calls: string[];
}): DeviceGatewayDispatchRouter {
  return new DeviceGatewayDispatchRouter({
    gatewayId: config.gatewayId,
    routes: config.routes,
    sessions: {
      session: () =>
        config.connectionId === null
          ? null
          : { hello: { connectionId: config.connectionId } },
    },
    local: {
      execute: async () => localResolution(config, "execute"),
      reconcile: async () => localResolution(config, "reconcile"),
      cancel: async () => localResolution(config, "cancel"),
    },
    peers: config.peers,
  });
}

function localResolution(
  config: { gatewayId: string; calls: string[] },
  operation: DeviceDispatchOperation,
): DeviceGatewayDispatchResolution {
  config.calls.push(`local:${config.gatewayId}:${operation}`);
  return completed();
}

function unavailablePeers(): DeviceGatewayPeerDispatchPort {
  return {
    async dispatch(
      _route: DeviceConnectionRoute,
    ): Promise<DeviceGatewayDispatchResolution> {
      throw new Error("peer dispatch not expected");
    },
  };
}

function command(): DeviceExecutionCommand {
  return {
    schemaVersion: "crewon.device-command.v0",
    protocolVersion: 1,
    deviceId: "device-1",
    leaseId: "lease-1",
    leaseEpoch: 1,
    expiresAt: "2099-08-09T00:00:00.000Z",
    runId: "run-1",
    stepId: "step-1",
    attemptId: "attempt-1",
    executionId: "execution-1",
    workspaceBindingId: "workspace-1",
    capability: "workspace.read",
    actionDigest: `sha256:${"a".repeat(64)}`,
    arguments: { path: "relative/file.txt" },
    payloadRef: null,
    limits: {
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
      maxArtifactBytes: 16 * 1024 * 1024,
    },
    idempotencyKey: `device:${"a".repeat(64)}`,
    traceContext: { traceparent: null, tracestate: null },
    authorization: {
      schemaVersion: "crewon.device-authorization.v0",
      scheme: "ed25519",
      keyId: "control-key-1",
      issuedAt: "2026-08-09T00:00:00.000Z",
      expiresAt: "2026-08-09T00:05:00.000Z",
      approvalProof: null,
      signature: "A".repeat(86),
    },
  };
}

function completed(): DeviceGatewayDispatchResolution {
  return {
    status: "completed",
    executionId: "execution-1",
    providerReceiptId: "receipt-1",
    terminal: {
      schemaVersion: "crewon.device-event.v0",
      protocolVersion: 1,
      deviceId: "device-1",
      executionId: "execution-1",
      receiptId: "receipt-1",
      sequence: 2,
      observedAt: "2026-08-09T00:00:01.000Z",
      type: "execution.completed",
      data: {
        output: "done",
        artifactRef: null,
        outputDigest: `sha256:${"b".repeat(64)}`,
        stdoutDigest: `sha256:${"c".repeat(64)}`,
        stderrDigest: `sha256:${"d".repeat(64)}`,
        exitCode: 0,
        exitSignal: null,
      },
    },
    output: [],
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && "code" in error && error.code === code;
}
