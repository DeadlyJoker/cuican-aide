import { describe, expect, it, vi } from "vitest";

import type {
  DesktopWorkspaceAuthorityPort,
  DesktopWorkspaceStatus,
} from "../desktop/desktopWorkspaceAuthorityAdapter";
import {
  DesktopWorkspaceAuthorityConflictError,
  DesktopWorkspaceNativeMutationError,
} from "../desktop/desktopWorkspaceAuthorityAdapter";
import type { ControlWorkspaceState } from "./controlWorkspaceRuntime";
import {
  ControlWorkspaceRuntimeComposition,
  type ControlWorkspaceRuntimePort,
} from "./useControlWorkspaceRuntime";

describe("ControlWorkspaceRuntimeComposition", () => {
  it("projects unavailable, Team read-only, and native desktop authority without legacy fallback", async () => {
    const unavailable = composition({ controlConfigured: false });
    const readOnly = composition({ controlConfigured: true });
    const desktopAuthority = authority();
    const desktop = composition({
      controlConfigured: true,
      nativeAuthority: desktopAuthority.port,
    });

    expect(unavailable.value.getSnapshot().mutationAuthority).toBe(
      "unavailable",
    );
    expect(readOnly.value.getSnapshot()).toEqual(
      expect.objectContaining({
        mutationAuthority: "readOnly",
        nativeWorkspace: null,
      }),
    );
    expect(desktop.value.getSnapshot()).toEqual(
      expect.objectContaining({
        mutationAuthority: "unavailable",
        nativeWorkspace: {
          availability: "unavailable",
          displayName: null,
        },
      }),
    );

    await desktop.value.refreshNativeAuthority();
    expect(desktop.value.getSnapshot()).toEqual(
      expect.objectContaining({
        mutationAuthority: "desktop",
        nativeWorkspace: {
          availability: "available",
          displayName: "cuican-aide",
        },
      }),
    );
  });

  it("keeps only the latest native authority read and ignores a late result", async () => {
    const first = deferred<DesktopWorkspaceStatus>();
    const second = deferred<DesktopWorkspaceStatus>();
    const native = authority();
    native.status.mockReset();
    native.status.mockReturnValueOnce(first.promise);
    native.status.mockReturnValueOnce(second.promise);
    const test = composition({
      controlConfigured: true,
      nativeAuthority: native.port,
    });

    const firstRead = test.value.refreshNativeAuthority();
    const secondRead = test.value.refreshNativeAuthority();
    second.resolve(status({ current: { displayName: "new" }, revision: 8 }));
    await secondRead;
    first.resolve(status({ current: { displayName: "stale" }, revision: 7 }));
    await firstRead;

    expect(test.value.getSnapshot().nativeWorkspace).toEqual({
      availability: "available",
      displayName: "new",
    });
  });

  it("selects the Control Thread, freezes maxEntries, and reuses the selected scope for recovery actions", async () => {
    const test = composition({ controlConfigured: true });

    await test.value.selectThread("thread-1");
    await test.value.create();
    await test.value.reconcile("execution-1");
    await test.value.cancel("execution-1");

    expect(test.runtime.selectThread).toHaveBeenCalledWith("thread-1");
    expect(test.runtime.create).toHaveBeenCalledWith("thread-1", 200);
    expect(test.runtime.reconcile).toHaveBeenCalledWith(
      "thread-1",
      "execution-1",
    );
    expect(test.runtime.cancel).toHaveBeenCalledWith("thread-1", "execution-1");
  });

  it("uses one key per native action, re-reads authority, and restores the current Control selection", async () => {
    const before = status();
    const selected = status({
      current: { displayName: "selected" },
      revision: 5,
      supervisorGeneration: 8,
    });
    const cleared = status({
      current: null,
      revision: 6,
      supervisorGeneration: 9,
    });
    const native = authority();
    native.status
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(selected)
      .mockResolvedValueOnce(cleared);
    native.selectAndRegister.mockResolvedValue({
      outcome: "committed",
      snapshot: selected,
    });
    native.clear.mockResolvedValue({ outcome: "committed", snapshot: cleared });
    const keys: string[] = [];
    const test = composition({
      controlConfigured: true,
      nativeAuthority: native.port,
      idempotencyKey: (operation) => {
        const key = `workspace.${operation}:frozen-key`;
        keys.push(key);
        return key;
      },
    });

    await test.value.selectThread("thread-current");
    await test.value.refreshNativeAuthority();
    await test.value.selectNativeWorkspace();
    await test.value.clearNativeWorkspace();

    expect(native.selectAndRegister).toHaveBeenCalledWith({
      expectedRevision: 4,
      idempotencyKey: "workspace.select:frozen-key",
    });
    expect(native.clear).toHaveBeenCalledWith({
      expectedRevision: 5,
      idempotencyKey: "workspace.clear:frozen-key",
    });
    expect(keys).toEqual([
      "workspace.select:frozen-key",
      "workspace.clear:frozen-key",
    ]);
    expect(test.runtime.selectThread.mock.calls).toEqual([
      ["thread-current"],
      ["thread-current"],
      ["thread-current"],
    ]);
    expect(test.value.getSnapshot()).toEqual(
      expect.objectContaining({
        mutationAuthority: "desktop",
        nativeBusy: false,
        nativeWorkspace: { availability: "available", displayName: null },
      }),
    );
  });

  it("rehydrates the main Thread authority before Workspace recovery", async () => {
    const before = status();
    const after = status({
      current: { displayName: "selected" },
      revision: 5,
      supervisorGeneration: 8,
    });
    const native = authority();
    native.status.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    native.selectAndRegister.mockResolvedValue({
      outcome: "committed",
      snapshot: after,
    });
    const order: string[] = [];
    const rehydrateThreadAuthority = vi.fn(async () => {
      order.push("thread");
    });
    const test = composition({
      controlConfigured: true,
      nativeAuthority: native.port,
      rehydrateThreadAuthority,
    });
    test.runtime.selectThread.mockImplementation(async () => {
      order.push("workspace");
    });

    await test.value.selectThread("thread-current");
    order.length = 0;
    await test.value.refreshNativeAuthority();
    await test.value.selectNativeWorkspace();

    expect(order).toEqual(["thread", "workspace"]);
    expect(rehydrateThreadAuthority).toHaveBeenCalledWith("thread-current");
  });

  it("does not let a late native recovery overwrite a newer Thread selection", async () => {
    const before = status();
    const after = status({
      current: { displayName: "selected" },
      revision: 5,
    });
    const native = authority();
    native.status.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    native.selectAndRegister.mockResolvedValue({
      outcome: "committed",
      snapshot: after,
    });
    const release = deferred<void>();
    const entered = deferred<void>();
    const test = composition({
      controlConfigured: true,
      nativeAuthority: native.port,
      rehydrateThreadAuthority: async () => {
        entered.resolve();
        await release.promise;
      },
    });

    await test.value.selectThread("thread-old");
    await test.value.refreshNativeAuthority();
    const mutation = test.value.selectNativeWorkspace();
    await entered.promise;
    await test.value.selectThread("thread-new");
    release.resolve();
    await mutation;

    expect(test.runtime.selectThread.mock.calls).toEqual([
      ["thread-old"],
      ["thread-new"],
    ]);
  });

  it("keeps a committed native snapshot and projects safe error when main authority recovery fails", async () => {
    const before = status();
    const after = status({
      current: { displayName: "selected" },
      revision: 5,
      supervisorGeneration: 8,
    });
    const native = authority();
    native.status.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    native.selectAndRegister.mockResolvedValue({
      outcome: "committed",
      snapshot: after,
    });
    const rehydrateThreadAuthority = vi.fn(async () => {
      throw new Error("raw secret-bearing failure");
    });
    const test = composition({
      controlConfigured: true,
      nativeAuthority: native.port,
      rehydrateThreadAuthority,
    });

    await test.value.selectThread("thread-current");
    await test.value.refreshNativeAuthority();
    await test.value.selectNativeWorkspace();

    expect(test.value.getSnapshot()).toEqual(
      expect.objectContaining({
        control: expect.objectContaining({ status: "error" }),
        nativeWorkspace: {
          availability: "available",
          displayName: "selected",
        },
        mutationAuthority: "unavailable",
        safeError: "rehydrationFailed",
      }),
    );
    expect(JSON.stringify(test.value.getSnapshot())).not.toContain(
      "raw secret-bearing failure",
    );
    expect(test.runtime.selectThread).toHaveBeenCalledTimes(1);
  });

  it("does not rehydrate on user cancellation and clears safe error", async () => {
    const before = status();
    const native = authority();
    native.status.mockResolvedValueOnce(before);
    native.selectAndRegister.mockResolvedValue({
      outcome: "userCanceled",
      snapshot: before,
    });
    const rehydrateThreadAuthority = vi.fn(async () => undefined);
    const test = composition({
      controlConfigured: true,
      nativeAuthority: native.port,
      rehydrateThreadAuthority,
    });

    await test.value.selectThread("thread-current");
    await test.value.refreshNativeAuthority();
    await test.value.selectNativeWorkspace();

    expect(rehydrateThreadAuthority).not.toHaveBeenCalled();
    expect(test.value.getSnapshot().safeError).toBeNull();
  });

  it("projects native conflicts and unknown outcomes as bounded safe errors", async () => {
    for (const [failure, expected] of [
      [
        new DesktopWorkspaceAuthorityConflictError(status({ revision: 5 })),
        "nativeConflict",
      ],
      [new Error("raw secret-bearing unknown"), "nativeUnknown"],
    ] as const) {
      const native = authority();
      native.status.mockResolvedValueOnce(status());
      native.selectAndRegister.mockRejectedValue(failure);
      const test = composition({
        controlConfigured: true,
        nativeAuthority: native.port,
      });
      await test.value.refreshNativeAuthority();

      await expect(test.value.selectNativeWorkspace()).rejects.toBe(failure);

      expect(test.value.getSnapshot().safeError).toBe(expected);
      expect(test.value.getSnapshot().mutationAuthority).toBe(
        expected === "nativeUnknown" ? "unavailable" : "desktop",
      );
      expect(JSON.stringify(test.value.getSnapshot())).not.toContain(
        "raw secret-bearing",
      );
    }
  });

  it("distinguishes an active-authority fence from transitioning and unknown outcomes", async () => {
    for (const [failure, safeError, mutationAuthority] of [
      [
        new DesktopWorkspaceNativeMutationError({
          schemaVersion: "crewon.desktop-workspace-error.v0",
          status: 409,
          code: "desktop_workspace_active_authority",
          certainty: "notSent",
        }),
        "nativeActiveAuthority",
        "desktop",
      ],
      [
        new DesktopWorkspaceNativeMutationError({
          schemaVersion: "crewon.desktop-workspace-error.v0",
          status: 409,
          code: "desktop_workspace_transitioning",
          certainty: "notSent",
        }),
        "nativeUnavailable",
        "unavailable",
      ],
    ] as const) {
      const native = authority();
      native.status.mockResolvedValueOnce(status());
      native.selectAndRegister.mockRejectedValue(failure);
      const test = composition({
        controlConfigured: true,
        nativeAuthority: native.port,
      });
      await test.value.refreshNativeAuthority();

      await expect(test.value.selectNativeWorkspace()).rejects.toBe(failure);

      expect(test.value.getSnapshot()).toEqual(
        expect.objectContaining({ safeError, mutationAuthority }),
      );
      expect(JSON.stringify(test.value.getSnapshot())).not.toContain(
        failure.code,
      );
    }
  });

  it("projects a missing or failing native command as unavailable and never blocks Control read-only state", async () => {
    const native = authority();
    native.status.mockRejectedValue(new Error("command missing"));
    const desktop = composition({
      controlConfigured: true,
      nativeAuthority: native.port,
    });

    await desktop.value.refreshNativeAuthority();

    expect(desktop.value.getSnapshot()).toEqual(
      expect.objectContaining({
        mutationAuthority: "unavailable",
        nativeWorkspace: {
          availability: "unavailable",
          displayName: null,
        },
      }),
    );
    expect(desktop.runtime.create).not.toHaveBeenCalled();
  });

  it("invalidates late native status after close", async () => {
    const pending = deferred<DesktopWorkspaceStatus>();
    const native = authority();
    native.status.mockReturnValue(pending.promise);
    const test = composition({
      controlConfigured: true,
      nativeAuthority: native.port,
    });
    const refresh = test.value.refreshNativeAuthority();

    test.value.close();
    pending.resolve(status({ current: { displayName: "late" } }));
    await refresh;

    expect(test.runtime.close).toHaveBeenCalledOnce();
    expect(test.value.getSnapshot().nativeWorkspace).toEqual({
      availability: "unavailable",
      displayName: null,
    });
  });
});

function composition(config: {
  controlConfigured: boolean;
  nativeAuthority?: DesktopWorkspaceAuthorityPort | null;
  idempotencyKey?: (operation: "clear" | "select") => string;
  rehydrateThreadAuthority?: (threadId: string) => Promise<void>;
}) {
  const runtime = fakeRuntime();
  return {
    runtime,
    value: new ControlWorkspaceRuntimeComposition({
      controlConfigured: config.controlConfigured,
      nativeAuthority: config.nativeAuthority ?? null,
      runtime,
      idempotencyKey: config.idempotencyKey,
      rehydrateThreadAuthority: config.rehydrateThreadAuthority,
    }),
  };
}

function fakeRuntime() {
  const listeners = new Set<() => void>();
  const state: ControlWorkspaceState = {
    status: "available",
    threadId: null,
    threadRevision: null,
    threadStatus: null,
    operations: [],
    eventSequences: {},
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    selectThread: vi.fn(async (_threadId: string | null) => undefined),
    create: vi.fn(async (_threadId: string, _maxEntries: number) => undefined),
    reconcile: vi.fn(
      async (_threadId: string, _executionId: string) => undefined,
    ),
    cancel: vi.fn(async (_threadId: string, _executionId: string) => undefined),
    close: vi.fn(),
  } satisfies ControlWorkspaceRuntimePort;
}

function authority() {
  const statusMock = vi.fn(async () => status());
  const selectAndRegister =
    vi.fn<DesktopWorkspaceAuthorityPort["selectAndRegister"]>();
  const clear = vi.fn<DesktopWorkspaceAuthorityPort["clear"]>();
  return {
    status: statusMock,
    selectAndRegister,
    clear,
    port: {
      status: statusMock,
      selectAndRegister,
      clear,
    } satisfies DesktopWorkspaceAuthorityPort,
  };
}

function status(
  overrides: Partial<DesktopWorkspaceStatus> = {},
): DesktopWorkspaceStatus {
  return {
    schemaVersion: "crewon.desktop-workspace-status.v0",
    availability: "available",
    revision: 4,
    supervisorGeneration: 7,
    current: { displayName: "cuican-aide" },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
