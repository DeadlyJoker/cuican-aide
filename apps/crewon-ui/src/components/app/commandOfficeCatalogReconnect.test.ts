import { describe, expect, it, vi } from "vitest";

import {
  OFFICE_CATALOG_BACKEND_RESTART_AFTER_ATTEMPTS,
  officeCatalogReconnectDelayMs,
  scheduleOfficeCatalogReconnect,
  shouldRestartBackendAfterOfficeCatalogFailures,
} from "./commandOfficeCatalogReconnect";

describe("command Office catalog reconnect", () => {
  it("backs off catalog retries and caps the delay", () => {
    expect([0, 1, 2, 3, 8].map(officeCatalogReconnectDelayMs)).toEqual([
      1_000, 2_000, 5_000, 10_000, 10_000,
    ]);
  });

  it("retries an unavailable visible Office catalog without reconnecting the app server", () => {
    const scheduledHandlers: Array<() => void> = [];
    const onReconnect = vi.fn();
    const clearTimeout = vi.fn();

    const cleanup = scheduleOfficeCatalogReconnect({
      active: true,
      attempt: 2,
      clearTimeout,
      connectionState: "connected",
      onReconnect,
      setTimeout: (handler, timeout) => {
        scheduledHandlers.push(handler);
        expect(timeout).toBe(5_000);
        return 42 as ReturnType<typeof setTimeout>;
      },
      status: "unavailable",
    });

    expect(scheduledHandlers).toHaveLength(1);
    scheduledHandlers[0]();
    expect(onReconnect).toHaveBeenCalledWith(3);

    cleanup?.();
    expect(clearTimeout).toHaveBeenCalledWith(42);
  });

  it("does not poll while hidden, loading, ready, or app-server disconnected", () => {
    const setTimeout = vi.fn();
    const base = {
      attempt: 0,
      clearTimeout: vi.fn(),
      onReconnect: vi.fn(),
      setTimeout,
    };

    expect(
      scheduleOfficeCatalogReconnect({
        ...base,
        active: false,
        connectionState: "connected",
        status: "unavailable",
      }),
    ).toBeUndefined();
    expect(
      scheduleOfficeCatalogReconnect({
        ...base,
        active: true,
        connectionState: "connected",
        status: "loading",
      }),
    ).toBeUndefined();
    expect(
      scheduleOfficeCatalogReconnect({
        ...base,
        active: true,
        connectionState: "connected",
        status: "ready",
      }),
    ).toBeUndefined();
    expect(
      scheduleOfficeCatalogReconnect({
        ...base,
        active: true,
        connectionState: "disconnected",
        status: "unavailable",
      }),
    ).toBeUndefined();
    expect(setTimeout).not.toHaveBeenCalled();
  });

  it("requests one backend restart after repeated catalog failures", () => {
    expect(OFFICE_CATALOG_BACKEND_RESTART_AFTER_ATTEMPTS).toBe(4);
    expect(
      shouldRestartBackendAfterOfficeCatalogFailures({
        attempt: 3,
        restartRequested: false,
      }),
    ).toBe(false);
    expect(
      shouldRestartBackendAfterOfficeCatalogFailures({
        attempt: 4,
        restartRequested: false,
      }),
    ).toBe(true);
    expect(
      shouldRestartBackendAfterOfficeCatalogFailures({
        attempt: 8,
        restartRequested: true,
      }),
    ).toBe(false);
  });
});
