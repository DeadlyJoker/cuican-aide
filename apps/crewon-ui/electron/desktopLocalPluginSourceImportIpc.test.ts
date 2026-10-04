import { EventEmitter } from "node:events";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import { bindDesktopLocalPluginSourceImportIpc } from "./desktopLocalPluginSourceImportIpc.ts";
import { runRuntimeStoppedMutation } from "./runtimeStoppedMutation.ts";
import type { RuntimeStoppedMutationOptions } from "./runtimeStoppedMutation.ts";
import type { DesktopLocalPluginSourceImporter } from "./desktopLocalPluginSourceImport.ts";
import type { DesktopLocalPluginSourcePreview } from "../src/lib/desktop/desktopLocalPluginSourceImportProtocol.ts";

const PREVIEW = "crewon:plugin-sources:preview-v1";
const CONFIRM = "crewon:plugin-sources:confirm-v1";
const CANCEL = "crewon:plugin-sources:cancel-v1";
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

/** Named IPC/lifecycle ports. Package verification has separate real-filesystem coverage. */
function fixture(rendererUrl = RENDERER) {
  const events = new EventEmitter();
  let destroyed = false;
  const contents = Object.assign(events, {
    mainFrame: { url: rendererUrl },
    isDestroyed: () => destroyed,
    send: vi.fn(),
  });
  const window = { webContents: contents, isDestroyed: () => destroyed };
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
  const listeners = new Set<() => void | Promise<void>>();
  const management = new Set<() => void>();
  const invalidated = () => {
    for (const listener of listeners) void listener();
  };
  const stop = vi.fn(async () => {
    invalidated();
  });
  const start = vi.fn(async () => {
    for (const listener of management) listener();
  });
  const assertReady = vi.fn();
  const runtime = {
    mutateWhileStopped<T>(options: RuntimeStoppedMutationOptions<T>) {
      return runRuntimeStoppedMutation(options, { stop, start, assertReady });
    },
    onSessionInvalidated(listener: () => void | Promise<void>) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onLocalManagementAccessChanged(listener: () => void) {
      management.add(listener);
      return () => {
        management.delete(listener);
      };
    },
  };
  let assertCurrent = () => {};
  const preview: DesktopLocalPluginSourcePreview = {
    previewId: "opaque-main-ticket",
    expiresAt: Date.now() + 60_000,
    pluginId: "example.local-plugin",
    publisherId: "example.publisher",
    version: "1.0.0",
    packageDigest: `sha256:${"a".repeat(64)}`,
    title: "Named IPC fixture",
    description: "No real package or execution",
    totalBytes: 1,
    fileCount: 1,
    nodeEntry: null,
    uiEntry: { path: "ui.mjs", mode: "trustedModule" },
    publicAssetCandidates: ["ui.mjs"],
  };
  const confirm = {
    previewId: preview.previewId,
    pluginId: preview.pluginId,
    publisherId: preview.publisherId,
    version: preview.version,
    packageDigest: preview.packageDigest,
    publicAssets: ["ui.mjs"],
    trustNodeExecution: false,
    trustUiModule: true,
  };
  const core: DesktopLocalPluginSourceImporter = {
    claimPreview: vi.fn((input) => {
      assertCurrent();
      return Object.freeze(structuredClone(input));
    }),
    previewDirectory: vi.fn(async () => {
      assertCurrent();
      return preview;
    }),
    confirmPreview: vi.fn(async () => {
      assertCurrent();
      return {
        sourceId: "local-import-named",
        pluginId: preview.pluginId,
        publisherId: preview.publisherId,
        version: preview.version,
        packageDigest: preview.packageDigest,
        restartRequired: true as const,
      };
    }),
    cancelPreview: vi.fn(),
    close: vi.fn(async () => {}),
  };
  const chooseDirectory = vi.fn(
    async (): Promise<string | null> => "/human/developer/plugin",
  );
  const createImporter = vi.fn(
    (
      options: Parameters<
        typeof import("./desktopLocalPluginSourceImport.ts").createDesktopLocalPluginSourceImporter
      >[0],
    ) => {
      assertCurrent = options.assertCurrent;
      return core;
    },
  );
  const owner = bindDesktopLocalPluginSourceImportIpc({
    window: window as unknown as BrowserWindow,
    ipc: ipc as unknown as IpcMain,
    dataDirectory: "/owned/native/data",
    rendererUrl,
    runtime,
    chooseDirectory,
    diagnostic: vi.fn(),
    createImporter,
  });
  const event = () =>
    ({
      sender: contents,
      senderFrame: contents.mainFrame,
    }) as unknown as IpcMainInvokeEvent;
  const invoke = (channel: string, ...args: unknown[]) =>
    Promise.resolve().then(() => handlers.get(channel)!(event(), ...args));
  return {
    contents,
    handlers,
    owner,
    event,
    invoke,
    chooseDirectory,
    createImporter,
    core,
    preview,
    confirm,
    stop,
    start,
    assertReady,
    invalidated,
    destroy() {
      destroyed = true;
      contents.emit("destroyed");
    },
  };
}

describe("Native plugin source import IPC ownership", () => {
  it("keeps selected filesystem paths in Main and forwards the exact consent", async () => {
    const f = fixture();
    try {
      const view = await f.invoke(PREVIEW);
      expect(view).toEqual(f.preview);
      expect(JSON.stringify(view)).not.toContain("/human");
      expect(f.core.previewDirectory).toHaveBeenCalledWith(
        "/human/developer/plugin",
      );
      await expect(f.invoke(CONFIRM, f.confirm)).resolves.toMatchObject({
        sourceId: "local-import-named",
        runtimeStatus: "ready",
        restartRequired: false,
      });
      expect(f.stop).toHaveBeenCalledTimes(1);
      expect(f.core.confirmPreview).toHaveBeenCalledWith(f.confirm);
      expect(f.core.close).toHaveBeenCalledTimes(1);
    } finally {
      await f.owner.close();
    }
  });

  it.each(["foreign sender", "iframe", "other file", "other dev path"])(
    "rejects %s before the directory dialog",
    async (kind) => {
      const f = fixture(
        kind === "other dev path"
          ? "http://127.0.0.1:9999/index.html"
          : RENDERER,
      );
      try {
        const event = f.event();
        if (kind === "foreign sender") Object.assign(event, { sender: {} });
        if (kind === "iframe") Object.assign(event, { senderFrame: {} });
        if (kind === "other file")
          f.contents.mainFrame.url = "file:///tmp/attacker.html";
        if (kind === "other dev path")
          f.contents.mainFrame.url = "http://127.0.0.1:9999/attacker.html";
        await expect(
          Promise.resolve().then(() => f.handlers.get(PREVIEW)!(event)),
        ).rejects.toThrow("sender_invalid");
        expect(f.chooseDirectory).not.toHaveBeenCalled();
      } finally {
        await f.owner.close();
      }
    },
  );

  it("accepts the configured development page and rejects renderer-supplied paths", async () => {
    const f = fixture("http://127.0.0.1:9999/");
    try {
      f.contents.mainFrame.url += "?surface=desktop#view-command";
      await expect(f.invoke(PREVIEW, "/renderer/path")).rejects.toThrow(
        "request_invalid",
      );
      expect(f.chooseDirectory).not.toHaveBeenCalled();
      await expect(f.invoke(PREVIEW)).resolves.toEqual(f.preview);
    } finally {
      await f.owner.close();
    }
  });

  it("treats Native chooser cancellation as no package work", async () => {
    const f = fixture();
    f.chooseDirectory.mockResolvedValue(null);
    try {
      await expect(f.invoke(PREVIEW)).resolves.toBeNull();
      expect(f.createImporter).not.toHaveBeenCalled();
    } finally {
      await f.owner.close();
    }
  });

  it("rechecks the document after the physical dialog and refuses another flight", async () => {
    const f = fixture();
    const chosen = deferred<string | null>();
    f.chooseDirectory.mockReturnValue(chosen.promise);
    const pending = f.invoke(PREVIEW);
    await vi.waitFor(() => expect(f.chooseDirectory).toHaveBeenCalledTimes(1));
    await expect(f.invoke(PREVIEW)).rejects.toThrow("busy");
    f.contents.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false,
    });
    chosen.resolve("/human/developer/plugin");
    await expect(pending).rejects.toThrow("owner_changed");
    expect(f.createImporter).not.toHaveBeenCalled();
    await f.owner.close();
  });

  it("joins the outstanding dialog before closing the IPC owner", async () => {
    const f = fixture();
    const chosen = deferred<string | null>();
    f.chooseDirectory.mockReturnValue(chosen.promise);
    const pending = f.invoke(PREVIEW);
    await vi.waitFor(() => expect(f.chooseDirectory).toHaveBeenCalledTimes(1));
    let complete = false;
    const closing = f.owner.close().then(() => {
      complete = true;
    });
    await Promise.resolve();
    expect(complete).toBe(false);
    chosen.resolve(null);
    await expect(pending).rejects.toThrow("owner_changed");
    await closing;
    expect(f.handlers.size).toBe(0);
  });

  it("withdraws a preview for external runtime invalidation", async () => {
    const f = fixture();
    await f.invoke(PREVIEW);
    f.invalidated();
    await expect(f.invoke(CONFIRM, f.confirm)).rejects.toThrow(
      "request_invalid",
    );
    expect(f.core.close).toHaveBeenCalledTimes(1);
    expect(f.core.confirmPreview).not.toHaveBeenCalled();
    await f.owner.close();
  });

  it("preserves the committed receipt when the original runtime cannot restart", async () => {
    const f = fixture();
    f.start.mockRejectedValue(new Error("named_runtime_restart_failure"));
    try {
      await f.invoke(PREVIEW);
      await expect(f.invoke(CONFIRM, f.confirm)).resolves.toMatchObject({
        sourceId: "local-import-named",
        runtimeStatus: "restartRequired",
        restartRequired: true,
      });
    } finally {
      await f.owner.close();
    }
  });

  it("joins the entire mutation including a held post-commit restart", async () => {
    const f = fixture();
    const startup = deferred<void>();
    f.start.mockReturnValue(startup.promise);
    await f.invoke(PREVIEW);
    const pending = f.invoke(CONFIRM, f.confirm);
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(1));
    let closed = false;
    const closing = f.owner.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    startup.resolve();
    await expect(pending).resolves.toMatchObject({
      sourceId: "local-import-named",
    });
    await closing;
  });

  it("ignores same-document navigation and cancels only an opaque preview", async () => {
    const f = fixture();
    try {
      await f.invoke(PREVIEW);
      f.contents.emit("did-start-navigation", {
        isMainFrame: true,
        isSameDocument: true,
      });
      await f.invoke(CANCEL, { previewId: f.preview.previewId });
      expect(f.core.cancelPreview).toHaveBeenCalledWith({
        previewId: f.preview.previewId,
      });
      expect(f.core.close).not.toHaveBeenCalled();
    } finally {
      await f.owner.close();
    }
  });
});
