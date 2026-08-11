import assert from "node:assert/strict";
import test from "node:test";

import { resolveDeviceGatewayRuntimeIdentity } from "./device-gateway-runtime-config.ts";

test("requires distinct explicit Team and local-only Workspace gateway identities", () => {
  assert.deepEqual(
    resolveDeviceGatewayRuntimeIdentity(
      { CREWON_DEVICE_GATEWAY_ID: "gateway-team-1" },
      "postgres",
    ),
    { kind: "team", gatewayId: "gateway-team-1" },
  );
  assert.deepEqual(resolveDeviceGatewayRuntimeIdentity({}, "sqlite"), {
    kind: "standaloneToolOnly",
  });
  assert.deepEqual(
    resolveDeviceGatewayRuntimeIdentity(
      {
        CREWON_DEVICE_GATEWAY_LOCAL_WORKSPACE_GATEWAY_ID: "gateway-local-1",
      },
      "sqlite",
    ),
    { kind: "standaloneWorkspace", gatewayId: "gateway-local-1" },
  );
});

test("fails closed on wrong authority or ambiguous gateway identity", () => {
  for (const [environment, authority, code] of [
    [{}, "postgres", "device_gateway_runtime_identity_invalid"],
    [
      { CREWON_DEVICE_GATEWAY_LOCAL_WORKSPACE_GATEWAY_ID: "gateway-local-1" },
      "postgres",
      "device_gateway_runtime_identity_invalid",
    ],
    [
      { CREWON_DEVICE_GATEWAY_ID: "gateway-team-1" },
      "sqlite",
      "device_gateway_runtime_identity_invalid",
    ],
    [
      {
        CREWON_DEVICE_GATEWAY_ID: "gateway-team-1",
        CREWON_DEVICE_GATEWAY_LOCAL_WORKSPACE_GATEWAY_ID: "gateway-local-1",
      },
      "sqlite",
      "device_gateway_runtime_identity_invalid",
    ],
    [
      { CREWON_DEVICE_GATEWAY_LOCAL_WORKSPACE_GATEWAY_ID: "bad gateway" },
      "sqlite",
      "device_gateway_id_invalid",
    ],
  ] as const) {
    assert.throws(
      () => resolveDeviceGatewayRuntimeIdentity(environment, authority),
      hasCode(code),
    );
  }
});

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && "code" in error && error.code === code;
}
