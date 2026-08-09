import { describe, expect, it } from "vitest";

import { selectThreadRuntimeAuthority } from "./threadRuntimeAuthority";

describe("Thread runtime authority", () => {
  it("uses legacy only when no Control session was configured", () => {
    const legacy = { kind: "legacy" } as const;

    expect(
      selectThreadRuntimeAuthority({
        controlClientConfigured: false,
        controlConnected: false,
        controlRuntime: null,
        legacyConnected: true,
        legacyConnectionState: "connected",
        legacyRuntime: legacy,
      }),
    ).toEqual({
      client: legacy,
      connected: true,
      connectionState: "connected",
      legacyManagesThreads: true,
    });
  });

  it("fails closed instead of falling back while Control connects", () => {
    expect(
      selectThreadRuntimeAuthority({
        controlClientConfigured: true,
        controlConnected: false,
        controlRuntime: { kind: "control" },
        legacyConnected: true,
        legacyConnectionState: "connected",
        legacyRuntime: { kind: "legacy" },
      }),
    ).toEqual({
      client: null,
      connected: false,
      connectionState: "connecting",
      legacyManagesThreads: false,
    });
  });

  it("selects Control as the only Thread authority after connect", () => {
    const control = { kind: "control" } as const;

    expect(
      selectThreadRuntimeAuthority({
        controlClientConfigured: true,
        controlConnected: true,
        controlRuntime: control,
        legacyConnected: false,
        legacyConnectionState: "disconnected",
        legacyRuntime: { kind: "legacy" },
      }),
    ).toEqual({
      client: control,
      connected: true,
      connectionState: "connected",
      legacyManagesThreads: false,
    });
  });
});
