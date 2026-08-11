import assert from "node:assert/strict";
import test from "node:test";

import {
  deviceGatewayReadinessLine,
  resolveDeviceGatewayListenConfig,
} from "./device-gateway-main-config.ts";

const LOCAL = {
  kind: "standaloneWorkspace",
  gatewayId: "gateway-local-1",
} as const;
const TEAM = { kind: "team", gatewayId: "gateway-team-1" } as const;

test("allows port zero only for explicit loopback standalone Workspace", () => {
  assert.deepEqual(
    resolveDeviceGatewayListenConfig(
      {
        CREWON_DEVICE_GATEWAY_HOST: "127.0.0.1",
        CREWON_DEVICE_GATEWAY_PORT: "0",
      },
      LOCAL,
    ),
    { host: "127.0.0.1", port: 0 },
  );
  assert.throws(
    () =>
      resolveDeviceGatewayListenConfig(
        { CREWON_DEVICE_GATEWAY_PORT: "0" },
        TEAM,
      ),
    /CREWON_DEVICE_GATEWAY_PORT_ephemeral_forbidden/u,
  );
  assert.throws(
    () =>
      resolveDeviceGatewayListenConfig(
        {
          CREWON_DEVICE_GATEWAY_HOST: "0.0.0.0",
          CREWON_DEVICE_GATEWAY_PORT: "0",
        },
        LOCAL,
      ),
    /CREWON_DEVICE_GATEWAY_PORT_ephemeral_forbidden/u,
  );
});

test("projects only the exact nonsecret loopback readiness address", () => {
  assert.equal(
    deviceGatewayReadinessLine(
      {
        host: "127.0.0.1",
        port: 43_125,
        path: "/device/v1",
      },
      LOCAL,
    ),
    "CrewON Device Gateway listening on wss://127.0.0.1:43125/device/v1",
  );
  assert.throws(() =>
    deviceGatewayReadinessLine(
      { host: "::", port: 43_125, path: "/device/v1" },
      LOCAL,
    ),
  );
  assert.throws(() =>
    deviceGatewayReadinessLine(
      { host: "127.0.0.1", port: 0, path: "/device/v1" },
      LOCAL,
    ),
  );
  assert.equal(
    deviceGatewayReadinessLine(
      { host: "::1", port: 8443, path: "/device/v1" },
      TEAM,
    ),
    "CrewON Device Gateway listening on wss://[::1]:8443/device/v1",
  );
});
