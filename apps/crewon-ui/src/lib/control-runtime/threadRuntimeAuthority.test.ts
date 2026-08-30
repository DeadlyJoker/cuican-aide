import { describe, expect, it } from "vitest";

import { selectThreadRuntimeAuthority } from "./threadRuntimeAuthority";

describe("Thread runtime authority", () => {
  it("fails closed when no Control session was configured", () => {
    expect(
      selectThreadRuntimeAuthority({
        controlClientConfigured: false,
        controlConnected: false,
        controlConnectionState: "disconnected",
        controlRuntime: null,
      }),
    ).toEqual({
      client: null,
      connected: false,
      connectionState: "disconnected",
      legacyManagesThreads: false,
    });
  });

  it("does not fall back to the legacy runtime while Control is connecting", () => {
    expect(
      selectThreadRuntimeAuthority({
        controlClientConfigured: true,
        controlConnected: false,
        controlConnectionState: "connecting",
        controlRuntime: { kind: "control" },
      }),
    ).toEqual({
      client: null,
      connected: false,
      connectionState: "connecting",
      legacyManagesThreads: false,
    });
  });

  it("reports a failed Control connection as disconnected", () => {
    expect(
      selectThreadRuntimeAuthority({
        controlClientConfigured: true,
        controlConnected: false,
        controlConnectionState: "disconnected",
        controlRuntime: { kind: "control" },
      }),
    ).toEqual({
      client: null,
      connected: false,
      connectionState: "disconnected",
      legacyManagesThreads: false,
    });
  });

  it("selects Control as the only Thread authority after connect", () => {
    const control = { kind: "control" } as const;

    expect(
      selectThreadRuntimeAuthority({
        controlClientConfigured: true,
        controlConnected: true,
        controlConnectionState: "connected",
        controlRuntime: control,
      }),
    ).toEqual({
      client: control,
      connected: true,
      connectionState: "connected",
      legacyManagesThreads: false,
    });
  });
});
