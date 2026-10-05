import { EventEmitter } from "node:events";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
  bindDesktopLocalPluginExecutionSetupIpc,
  DESKTOP_PLUGIN_EXECUTION_OWNER_CHANGED,
  DESKTOP_PLUGIN_EXECUTION_STATUS_CHANGED,
} from "./desktopLocalPluginExecutionSetupIpc.ts";
import type { DesktopLocalPluginExecutionSetupOwner } from "./desktopLocalPluginExecutionSetup.ts";
import type {
  DesktopLocalPluginExecutionPreview,
  DesktopLocalPluginExecutionResult,
  DesktopLocalPluginExecutionStatus,
} from "../src/lib/desktop/desktopLocalPluginExecutionSetupProtocol.ts";

const PREVIEW = "crewon:plugin-execution:preview-v1";
const CONFIRM = "crewon:plugin-execution:confirm-v1";
const CANCEL = "crewon:plugin-execution:cancel-v1";
const STATUS = "crewon:plugin-execution:status-v1";
const RENDERER = "file:///application/dist/index.html";
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type NamedPreparation = Readonly<{
  owner: DesktopLocalPluginExecutionSetupOwner;
  claim: unknown;
  onStopInvalidation(stop: () => Promise<void>): Promise<void>;
}>;

/** Named IPC/owner/runtime ports only; no package, policy, filesystem or supplier preparation. */
function fixture(rendererUrl = RENDERER) {
  const events = new EventEmitter();
  const contents = Object.assign(events, {
    mainFrame: { url: rendererUrl },
    isDestroyed: () => false,
    send: vi.fn(),
  });
  const window = { webContents: contents, isDestroyed: () => false };
  const handlers = new Map<
    string,
    (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
  >();
  const ipc = {
    handle: (
      channel: string,
      handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
    ) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  };
  const invalidations = new Set<() => void | Promise<void>>();
  const management = new Set<() => void>();
  const invalidated = () => {
    for (const listener of invalidations) void listener();
  };
  const managementChanged = () => {
    for (const listener of management) listener();
  };
  const identity = Object.freeze({
    pluginId: "crewon.short-drama",
    publisherId: "example.publisher",
    version: "12.0.0",
    packageDigest: `sha256:${"a".repeat(64)}`,
    manifestDigest: `sha256:${"b".repeat(64)}`,
    implementationDigest: `sha256:${"c".repeat(64)}`,
    selectionRevision: 3,
    configurationRevision: 2,
    configurationDigest: `sha256:${"d".repeat(64)}`,
  });
  const preview: DesktopLocalPluginExecutionPreview = Object.freeze({
    ...identity,
    previewId: "p".repeat(43),
    expiresAt: Date.now() + 60_000,
    baseUrl: "https://comfy.example.invalid/",
    preset: "krea2-portrait",
    networkPaths: [{ method: "POST" as const, path: "/prompt" }],
    approvalRequirement: "none",
  });
  const result: DesktopLocalPluginExecutionResult = Object.freeze({
    ...identity,
    state: "prepared",
    runtimeStatus: "ready",
    stage: "mappingCommitted",
  });
  const confirmation = Object.freeze({
    previewId: preview.previewId,
    approveExecution: true,
  });
  const claim = Object.freeze({ namedClaim: "Main-owned accepted consent" });
  const bootstrap = Object.freeze({ namedBootstrap: "not issued authority" });
  let assertCurrent = () => {};
  let committed = false;
  const core = {
    preview: vi.fn(async () => {
      assertCurrent();
      return preview;
    }),
    claimPreview: vi.fn((_request: unknown) => {
      assertCurrent();
      return claim;
    }),
    cancelPreview: vi.fn(),
    policyCommitted: vi.fn((_claim: unknown) => committed),
    close: vi.fn(async () => {}),
  };
  const firstStop = vi.fn(async () => invalidated());
  const secondStop = vi.fn(async () => invalidated());
  const policyWrite = vi.fn(() => {
    committed = true;
  });
  const mappingWrite = vi.fn();
  const prepare = vi.fn(async (input: NamedPreparation) => {
    await input.onStopInvalidation(firstStop);
    policyWrite();
    managementChanged();
    await input.onStopInvalidation(secondStop);
    mappingWrite();
    managementChanged();
    return result;
  });
  const runtime = {
    currentPluginBootstrap: vi.fn(async () => bootstrap),
    preparePluginExecutionSetup: prepare,
    onSessionInvalidated(listener: () => void | Promise<void>) {
      invalidations.add(listener);
      return () => invalidations.delete(listener);
    },
    onLocalManagementAccessChanged(listener: () => void) {
      management.add(listener);
      return () => management.delete(listener);
    },
  };
  const createOwner = vi.fn(
    (input: { dataDirectory: string; assertCurrent(): void }) => {
      assertCurrent = input.assertCurrent;
      return core as unknown as DesktopLocalPluginExecutionSetupOwner;
    },
  );
  const diagnostic = vi.fn();
  const owner = bindDesktopLocalPluginExecutionSetupIpc({
    window: window as unknown as BrowserWindow,
    ipc: ipc as unknown as IpcMain,
    dataDirectory: "/named/owned/data",
    rendererUrl,
    runtime: runtime as unknown as Parameters<
      typeof bindDesktopLocalPluginExecutionSetupIpc
    >[0]["runtime"],
    diagnostic,
    createOwner,
  });
  const event = () =>
    ({
      sender: contents,
      senderFrame: contents.mainFrame,
    }) as unknown as IpcMainInvokeEvent;
  const invoke = (channel: string, ...args: unknown[]) =>
    Promise.resolve().then(() => handlers.get(channel)!(event(), ...args));
  return {
    owner,
    core,
    createOwner,
    runtime,
    contents,
    handlers,
    event,
    invoke,
    preview,
    confirmation,
    claim,
    result,
    bootstrap,
    prepare,
    firstStop,
    secondStop,
    policyWrite,
    mappingWrite,
    invalidated,
    managementChanged,
    invalidations,
    management,
    diagnostic,
  };
}

describe("Native execution setup IPC lifecycle", () => {
  it("previews public pins without stopping or mutating policy/mapping", async () => {
    const f = fixture();
    try {
      await expect(
        f.invoke(STATUS, { pluginId: f.preview.pluginId }),
      ).resolves.toBeNull();
      await expect(
        f.invoke(PREVIEW, { pluginId: f.preview.pluginId }),
      ).resolves.toEqual(f.preview);
      expect(f.core.preview).toHaveBeenCalledWith({
        bootstrap: f.bootstrap,
        pluginId: f.preview.pluginId,
      });
      expect(f.prepare).not.toHaveBeenCalled();
      expect(f.firstStop).not.toHaveBeenCalled();
      expect(f.policyWrite).not.toHaveBeenCalled();
      expect(f.mappingWrite).not.toHaveBeenCalled();
      expect(JSON.stringify(f.preview)).not.toContain("/named/owned");
    } finally {
      await f.owner.close();
    }
  });

  it.each([PREVIEW, CONFIRM, CANCEL, STATUS])(
    "guards every %s sender before owner work",
    async (channel) => {
      for (const kind of [
        "foreign window",
        "subframe",
        "other file",
        "other dev path",
      ] as const) {
        const f = fixture(
          kind === "other dev path"
            ? "http://127.0.0.1:9999/index.html"
            : RENDERER,
        );
        try {
          const event = f.event();
          if (kind === "foreign window") Object.assign(event, { sender: {} });
          if (kind === "subframe") Object.assign(event, { senderFrame: {} });
          if (kind === "other file")
            f.contents.mainFrame.url = "file:///tmp/other.html";
          if (kind === "other dev path")
            f.contents.mainFrame.url = "http://127.0.0.1:9999/other.html";
          await expect(
            Promise.resolve().then(() => f.handlers.get(channel)!(event, {})),
          ).rejects.toThrow("sender_invalid");
          expect(f.createOwner).not.toHaveBeenCalled();
          expect(f.runtime.currentPluginBootstrap).not.toHaveBeenCalled();
          expect(f.prepare).not.toHaveBeenCalled();
        } finally {
          await f.owner.close();
        }
      }
    },
  );

  it.each([PREVIEW, STATUS])(
    "rejects non-exact requests on %s without reading getters",
    async (channel) => {
      const accessor = vi.fn(() => "crewon.short-drama");
      const getter = Object.defineProperty({}, "pluginId", {
        enumerable: true,
        get: accessor,
      });
      const malformed = [
        undefined,
        null,
        "crewon.short-drama",
        {},
        { pluginId: "other.plugin" },
        { pluginId: "crewon.short-drama", baseUrl: "https://other.invalid/" },
        Object.assign(Object.create({ inherited: true }), {
          pluginId: "crewon.short-drama",
        }),
        getter,
      ];
      const f = fixture();
      try {
        for (const request of malformed)
          await expect(f.invoke(channel, request)).rejects.toThrow(
            request !== null &&
              typeof request === "object" &&
              Object.getOwnPropertyDescriptor(request, "pluginId")?.value ===
                "other.plugin"
              ? "desktop_plugin_execution_setup_plugin_unsupported"
              : "desktop_local_plugin_source_import_shape",
          );
        await expect(f.invoke(channel)).rejects.toThrow("request_invalid");
        await expect(
          f.invoke(channel, { pluginId: f.preview.pluginId }, "extra"),
        ).rejects.toThrow("request_invalid");
        expect(accessor).not.toHaveBeenCalled();
        expect(f.runtime.currentPluginBootstrap).not.toHaveBeenCalled();
        expect(f.createOwner).not.toHaveBeenCalled();
      } finally {
        await f.owner.close();
      }
    },
  );

  it("keeps cancel exact and forwards only an opaque preview ID", async () => {
    const f = fixture();
    const getter = vi.fn(() => f.preview.previewId);
    try {
      await f.invoke(PREVIEW, { pluginId: f.preview.pluginId });
      for (const request of [
        null,
        f.preview.previewId,
        { previewId: "short" },
        { previewId: f.preview.previewId, approveExecution: true },
        Object.assign(Object.create(null), { previewId: f.preview.previewId }),
        Object.defineProperty({}, "previewId", {
          enumerable: true,
          get: getter,
        }),
      ]) {
        await expect(f.invoke(CANCEL, request)).rejects.toThrow(
          "request_invalid",
        );
      }
      await expect(f.invoke(CANCEL)).rejects.toThrow("request_invalid");
      await expect(
        f.invoke(CANCEL, { previewId: f.preview.previewId }, "extra"),
      ).rejects.toThrow("request_invalid");
      expect(getter).not.toHaveBeenCalled();
      expect(f.core.cancelPreview).not.toHaveBeenCalled();
      await f.invoke(CANCEL, { previewId: f.preview.previewId });
      expect(f.core.cancelPreview).toHaveBeenCalledWith({
        previewId: f.preview.previewId,
      });
      await expect(f.invoke(CONFIRM, f.confirmation)).rejects.toThrow(
        "request_invalid",
      );
      expect(f.prepare).not.toHaveBeenCalled();
    } finally {
      await f.owner.close();
    }
  });

  it("cannot mutate without a preview or an accepted exact owner claim", async () => {
    const f = fixture();
    try {
      await expect(f.invoke(CONFIRM, f.confirmation)).rejects.toThrow(
        "request_invalid",
      );
      await f.invoke(PREVIEW, { pluginId: f.preview.pluginId });
      await expect(f.invoke(CONFIRM)).rejects.toThrow("request_invalid");
      await expect(f.invoke(CONFIRM, f.confirmation, "extra")).rejects.toThrow(
        "request_invalid",
      );
      f.core.claimPreview.mockImplementation(() => {
        throw new Error("named_owner_claim_rejected");
      });
      const untrusted = {
        previewId: f.preview.previewId,
        approveExecution: false,
        policy: "renderer supplied",
      };
      await expect(f.invoke(CONFIRM, untrusted)).rejects.toThrow(
        "named_owner_claim_rejected",
      );
      expect(f.core.claimPreview).toHaveBeenCalledWith(untrusted);
      expect(f.prepare).not.toHaveBeenCalled();
      await expect(
        f.invoke(STATUS, { pluginId: f.preview.pluginId }),
      ).resolves.toBeNull();
    } finally {
      await f.owner.close();
    }
  });

  it("retains pending and committed receipts across both own stops and Settings cancellation", async () => {
    const f = fixture();
    const first = deferred<void>(),
      second = deferred<void>();
    f.firstStop.mockImplementation(async () => {
      f.invalidated();
      await first.promise;
    });
    f.secondStop.mockImplementation(async () => {
      f.invalidated();
      await second.promise;
    });
    await f.invoke(PREVIEW, { pluginId: f.preview.pluginId });
    const pending = f.invoke(CONFIRM, f.confirmation);
    try {
      await vi.waitFor(() => expect(f.firstStop).toHaveBeenCalledTimes(1));
      await expect(
        f.invoke(STATUS, { pluginId: f.preview.pluginId }),
      ).resolves.toEqual({
        previewId: f.preview.previewId,
        pluginId: f.preview.pluginId,
        state: "pending",
      });
      await expect(
        f.invoke(PREVIEW, { pluginId: f.preview.pluginId }),
      ).rejects.toThrow("busy");
      await f.invoke(CANCEL, { previewId: f.preview.previewId });
      expect(f.core.cancelPreview).toHaveBeenCalledWith({
        previewId: f.preview.previewId,
      });
      await expect(
        f.invoke(STATUS, { pluginId: f.preview.pluginId }),
      ).resolves.toMatchObject({ state: "pending" });
      first.resolve();
      await vi.waitFor(() => expect(f.secondStop).toHaveBeenCalledTimes(1));
      await expect(
        f.invoke(STATUS, { pluginId: f.preview.pluginId }),
      ).resolves.toMatchObject({ state: "pending" });
      expect(f.core.close).not.toHaveBeenCalled();
      second.resolve();
      await expect(pending).resolves.toEqual(f.result);
      expect(f.prepare).toHaveBeenCalledWith(
        expect.objectContaining({ owner: f.core, claim: f.claim }),
      );
      expect(f.core.claimPreview).toHaveBeenCalledWith(f.confirmation);
      expect(f.policyWrite).toHaveBeenCalledTimes(1);
      expect(f.mappingWrite).toHaveBeenCalledTimes(1);
      expect(f.contents.send).toHaveBeenCalledWith(
        DESKTOP_PLUGIN_EXECUTION_STATUS_CHANGED,
      );
      expect(f.contents.send).not.toHaveBeenCalledWith(
        DESKTOP_PLUGIN_EXECUTION_OWNER_CHANGED,
      );
      const firstRead = (await f.invoke(STATUS, {
        pluginId: f.preview.pluginId,
      })) as Extract<DesktopLocalPluginExecutionStatus, { state: "committed" }>;
      const secondRead = (await f.invoke(STATUS, {
        pluginId: f.preview.pluginId,
      })) as typeof firstRead;
      expect(firstRead).toEqual({
        previewId: f.preview.previewId,
        pluginId: f.preview.pluginId,
        state: "committed",
        result: f.result,
      });
      expect(firstRead).not.toBe(secondRead);
      expect(firstRead.result).not.toBe(secondRead.result);
      expect(Object.isFrozen(firstRead.result)).toBe(true);
      const rendererCopy = structuredClone(firstRead);
      Object.assign(rendererCopy.result, { packageDigest: "foreign" });
      await expect(
        f.invoke(STATUS, { pluginId: f.preview.pluginId }),
      ).resolves.toEqual(secondRead);
    } finally {
      first.resolve();
      second.resolve();
      await pending;
      await f.owner.close();
    }
  });

  it("ignores same-document and subframe navigation without withdrawing a valid preview", async () => {
    const f = fixture("http://127.0.0.1:9999/");
    try {
      f.contents.mainFrame.url += "?surface=desktop#settings";
      await f.invoke(PREVIEW, { pluginId: f.preview.pluginId });
      f.contents.emit("did-start-navigation", {
        isMainFrame: true,
        isSameDocument: true,
      });
      f.contents.emit("did-start-navigation", {
        isMainFrame: false,
        isSameDocument: false,
      });
      await expect(f.invoke(CONFIRM, f.confirmation)).resolves.toEqual(
        f.result,
      );
    } finally {
      await f.owner.close();
    }
  });

  it("rejects a late preview after navigation without publishing or mutating", async () => {
    const f = fixture(),
      returned = deferred<DesktopLocalPluginExecutionPreview>();
    f.core.preview.mockReturnValue(returned.promise);
    const pending = f.invoke(PREVIEW, { pluginId: f.preview.pluginId });
    await vi.waitFor(() => expect(f.core.preview).toHaveBeenCalledTimes(1));
    f.contents.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false,
    });
    returned.resolve(f.preview);
    await expect(pending).rejects.toThrow("owner_changed");
    await expect(f.invoke(CONFIRM, f.confirmation)).rejects.toThrow(
      "request_invalid",
    );
    expect(f.prepare).not.toHaveBeenCalled();
    await f.owner.close();
  });

  it.each(["external restart", "navigation", "crash"])(
    "does not resurrect a pending receipt after %s",
    async (kind) => {
      const f = fixture(),
        stopped = deferred<void>();
      f.firstStop.mockImplementation(async () => {
        f.invalidated();
        await stopped.promise;
      });
      await f.invoke(PREVIEW, { pluginId: f.preview.pluginId });
      const pending = f.invoke(CONFIRM, f.confirmation);
      const rejected = expect(pending).rejects.toThrow("owner_changed");
      await vi.waitFor(() => expect(f.firstStop).toHaveBeenCalledTimes(1));
      if (kind === "external restart") f.invalidated();
      else if (kind === "navigation")
        f.contents.emit("did-start-navigation", {
          isMainFrame: true,
          isSameDocument: false,
        });
      else f.contents.emit("render-process-gone");
      await expect(
        f.invoke(STATUS, { pluginId: f.preview.pluginId }),
      ).resolves.toBeNull();
      stopped.resolve();
      await rejected;
      await expect(
        f.invoke(STATUS, { pluginId: f.preview.pluginId }),
      ).resolves.toBeNull();
      expect(f.policyWrite).not.toHaveBeenCalled();
      expect(f.mappingWrite).not.toHaveBeenCalled();
      await f.owner.close();
    },
  );

  it("preserves a first-stage committed restart-required result without declaring the mapping committed", async () => {
    const f = fixture();
    const partial: DesktopLocalPluginExecutionResult = {
      ...f.result,
      state: "restartRequired",
      runtimeStatus: "restartRequired",
      stage: "policyCommitted",
    };
    f.prepare.mockImplementation(async (input) => {
      await input.onStopInvalidation(f.firstStop);
      f.policyWrite();
      return partial;
    });
    try {
      await f.invoke(PREVIEW, { pluginId: f.preview.pluginId });
      await expect(f.invoke(CONFIRM, f.confirmation)).resolves.toEqual(partial);
      await expect(
        f.invoke(STATUS, { pluginId: f.preview.pluginId }),
      ).resolves.toEqual({
        previewId: f.preview.previewId,
        pluginId: f.preview.pluginId,
        state: "committed",
        result: partial,
      });
      expect(f.secondStop).not.toHaveBeenCalled();
      expect(f.mappingWrite).not.toHaveBeenCalled();
    } finally {
      await f.owner.close();
    }
  });

  it.each([false, true])(
    "records fixed failure and policyCommitted=%s without leaking the thrown detail",
    async (policyCommitted) => {
      const f = fixture();
      f.prepare.mockImplementation(async (input) => {
        await input.onStopInvalidation(f.firstStop);
        if (policyCommitted) f.policyWrite();
        throw new Error("named_private_failure=/not-a-real-profile");
      });
      try {
        await f.invoke(PREVIEW, { pluginId: f.preview.pluginId });
        await expect(f.invoke(CONFIRM, f.confirmation)).rejects.toThrow(
          "named_private_failure",
        );
        const value = await f.invoke(STATUS, { pluginId: f.preview.pluginId });
        expect(value).toEqual({
          previewId: f.preview.previewId,
          pluginId: f.preview.pluginId,
          state: "failed",
          code: "desktop_plugin_execution_setup_failed",
          policyCommitted,
        });
        expect(JSON.stringify(value)).not.toContain("private_failure");
        expect(f.core.policyCommitted).toHaveBeenCalledWith(f.claim);
      } finally {
        await f.owner.close();
      }
    },
  );

  it("physically joins the held runtime flight and owner cleanup before close completes", async () => {
    const f = fixture(),
      stopped = deferred<void>(),
      cleanup = deferred<void>();
    f.firstStop.mockImplementation(async () => {
      f.invalidated();
      await stopped.promise;
    });
    f.core.close.mockReturnValue(cleanup.promise);
    await f.invoke(PREVIEW, { pluginId: f.preview.pluginId });
    const pending = f.invoke(CONFIRM, f.confirmation);
    const rejected = expect(pending).rejects.toThrow("owner_changed");
    await vi.waitFor(() => expect(f.firstStop).toHaveBeenCalledTimes(1));
    const retained = f.handlers.get(STATUS)!;
    let complete = false;
    const closing = f.owner.close().then(() => {
      complete = true;
    });
    await Promise.resolve();
    expect(complete).toBe(false);
    expect(f.handlers.size).toBe(0);
    expect(f.invalidations.size).toBe(0);
    expect(f.management.size).toBe(0);
    await expect(
      Promise.resolve().then(() =>
        retained(f.event(), { pluginId: f.preview.pluginId }),
      ),
    ).rejects.toThrow("sender_invalid");
    stopped.resolve();
    await Promise.resolve();
    expect(complete).toBe(false);
    cleanup.resolve();
    await rejected;
    await closing;
    expect(complete).toBe(true);
  });
});
