import { describe, expect, it, vi } from "vitest";
import { createInstalledPluginTaskReceipts } from "./installedPluginTaskReceipts";
import type { InstalledPluginTaskReceiptEvent } from "./installedPluginTaskReceipt";
import { uiLease } from "./pluginUiLoader.test-support";

function event(
  index: number,
  pluginId = "example.task",
): InstalledPluginTaskReceiptEvent {
  const lease = uiLease();
  return {
    lease: { ...lease, descriptor: { ...lease.descriptor, pluginId } },
    receipt: {
      disposition: "committed",
      threadId: `thread-${index}`,
      threadRevision: 2,
      runId: `run-${index}`,
      messageId: `message-${index}`,
      configurationRevision: 1,
    },
  };
}

describe("host account-owned installed task recovery", () => {
  it("keeps confirmed tasks after a module unsubscribes and replays one task as one recovery entry", () => {
    const listener = vi.fn();
    const registry = createInstalledPluginTaskReceipts({
      assertCurrent: () => {},
      onDiagnostic: vi.fn(),
    });
    const stop = registry.subscribe(listener);
    registry.observe(event(1));
    stop();
    registry.observe(event(2));
    registry.observe({
      ...event(1),
      receipt: { ...event(1).receipt, disposition: "replayed" },
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(registry.snapshot().map((value) => value.receipt.runId)).toEqual([
      "run-1",
      "run-2",
    ]);
    expect(registry.snapshot()[0].receipt.disposition).toBe("replayed");
    expect(Object.isFrozen(registry.snapshot())).toBe(true);
    expect(Object.isFrozen(registry.snapshot()[0].lease.descriptor)).toBe(true);
  });

  it("bounds recovery by both plugin and account without mixing source identities", () => {
    const registry = createInstalledPluginTaskReceipts({
      assertCurrent: () => {},
      onDiagnostic: vi.fn(),
    });
    for (let index = 0; index < 20; index++) registry.observe(event(index));
    expect(registry.snapshot()).toHaveLength(8);
    expect(registry.snapshot().map((value) => value.receipt.runId)).toEqual(
      [19, 18, 17, 16, 15, 14, 13, 12].map((index) => `run-${index}`),
    );
    for (let index = 20; index < 60; index++)
      registry.observe(event(index, `example.task${index}`));
    expect(registry.snapshot()).toHaveLength(32);
    expect(
      new Set(registry.snapshot().map((value) => value.receipt.runId)).size,
    ).toBe(32);
  });

  it("rejects old-account observations and synchronously removes recovery on account invalidation", () => {
    let current = true;
    const registry = createInstalledPluginTaskReceipts({
      assertCurrent: () => {
        if (!current) throw new Error("old session");
      },
      onDiagnostic: vi.fn(),
    });
    const listener = vi.fn();
    registry.subscribe(listener);
    registry.observe(event(1));
    current = false;
    expect(() => registry.observe(event(2))).toThrow("old session");
    registry.invalidate();
    expect(registry.snapshot()).toEqual([]);
    registry.observe(event(3));
    registry.subscribe(listener);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(registry.snapshot()).toEqual([]);
  });

  it("does not let a subscriber failure erase a confirmed receipt or prevent another subscriber", () => {
    const diagnostic = vi.fn();
    const registry = createInstalledPluginTaskReceipts({
      assertCurrent: () => {},
      onDiagnostic: diagnostic,
    });
    registry.subscribe(() => {
      throw new Error("view closed");
    });
    const second = vi.fn();
    registry.subscribe(second);
    registry.observe(event(1));
    expect(registry.snapshot()).toHaveLength(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(diagnostic).toHaveBeenCalledTimes(1);
  });

  it("withdraws synchronously if a listener invalidates the account while publishing", () => {
    const registry = createInstalledPluginTaskReceipts({
      assertCurrent: () => {},
      onDiagnostic: vi.fn(),
    });
    registry.subscribe(() => registry.invalidate());
    const second = vi.fn();
    registry.subscribe(second);
    registry.observe(event(1));
    expect(registry.snapshot()).toEqual([]);
    expect(second).not.toHaveBeenCalled();
  });
});
