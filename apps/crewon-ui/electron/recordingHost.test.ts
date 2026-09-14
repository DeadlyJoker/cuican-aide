import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateRecordingExport } from "@crewon/contracts/recording";
import type {
  RecordingSourceEvent,
  RecordingSkillImportRequest,
  RecordingSkillImportResult,
} from "../src/lib/desktop/recordingBridge.ts";

const electron = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => unknown;
  class Emitter {
    listeners = new Map<string, Listener[]>();
    on(name: string, listener: Listener) {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
      return this;
    }
    once(name: string, listener: Listener) {
      const once: Listener = (...args) => {
        this.listeners.set(
          name,
          (this.listeners.get(name) ?? []).filter((entry) => entry !== once),
        );
        return listener(...args);
      };
      return this.on(name, once);
    }
    emit(name: string, ...args: unknown[]) {
      for (const listener of [...(this.listeners.get(name) ?? [])])
        listener(...args);
    }
  }
  class WebContents extends Emitter {
    mainFrame = {};
    url = "about:blank";
    destroyed = false;
    session = Object.assign(new Emitter(), {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
    });
    send = vi.fn((channel: string, payload: unknown) => {
      if (channel === "crewon:recording:verify-screenshot")
        events.get("crewon:recording:screenshot-verified")?.(
          { sender: this, senderFrame: this.mainFrame },
          { ...(payload as object), safe: true },
        );
    });
    setWindowOpenHandler = vi.fn();
    getURL = () => this.url;
    isDestroyed = () => this.destroyed;
    close = vi.fn(() => {
      this.destroyed = true;
    });
    loadURL = vi.fn(async (url: string) => {
      this.url = url;
    });
    capturePage = vi.fn(async (_bounds: unknown) => ({
      toPNG: () => Buffer.from("fixture-png"),
    }));
  }
  const windows: BrowserWindow[] = [];
  const views: WebContentsView[] = [];
  class BrowserWindow extends Emitter {
    webContents = new WebContents();
    contentView = { addChildView: vi.fn(), removeChildView: vi.fn() };
    show = vi.fn();
    focus = vi.fn();
    isDestroyed = () => false;
    getContentBounds = () => ({ x: 0, y: 0, width: 1180, height: 820 });
    loadURL = vi.fn(async (_url: string) => undefined);
    loadFile = vi.fn(async (_path: string) => undefined);
    constructor(readonly options: unknown = {}) {
      super();
      windows.push(this);
    }
  }
  class WebContentsView {
    webContents = new WebContents();
    setVisible = vi.fn();
    setBounds = vi.fn();
    constructor(readonly options: unknown = {}) {
      views.push(this);
    }
  }
  const handlers = new Map<string, Listener>();
  const events = new Map<string, Listener>();
  return {
    BrowserWindow,
    WebContentsView,
    WebContents,
    windows,
    views,
    handlers,
    events,
    ipcMain: {
      handle: vi.fn((name: string, listener: Listener) =>
        handlers.set(name, listener),
      ),
      on: vi.fn((name: string, listener: Listener) =>
        events.set(name, listener),
      ),
    },
    dialog: { showSaveDialog: vi.fn(async () => ({ canceled: true })) },
  };
});

vi.mock("electron", () => electron);
import { RecordingHost } from "./recordingHost.ts";

type Sender = {
  sender: InstanceType<typeof electron.WebContents>;
  senderFrame: object;
};
function sender(
  contents: InstanceType<typeof electron.WebContents>,
  frame: object = contents.mainFrame,
): Sender {
  return { sender: contents, senderFrame: frame };
}
async function invoke(
  method: string,
  from: Sender,
  ...args: unknown[]
): Promise<unknown> {
  const handle = electron.handlers.get(`crewon:recording:${method}`);
  if (!handle) throw new Error(`missing IPC fixture: ${method}`);
  return await handle(from, ...args);
}
function click(
  patch: Partial<RecordingSourceEvent> = {},
): RecordingSourceEvent {
  return {
    kind: "click",
    target: {
      tag: "button",
      selector:
        "html:nth-of-type(1) > body:nth-of-type(1) > button:nth-of-type(1)",
      description: "button",
      role: "button",
      accessibleName: "Export sales",
    },
    input: null,
    reason: null,
    screenshotSafe: false,
    layout: null,
    ...patch,
  };
}
const layout = {
  width: 800,
  height: 600,
  x: 10,
  y: 10,
  targetWidth: 100,
  targetHeight: 30,
};
const cleanups: Array<() => Promise<void>> = [];
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "crewon-recording-host-"));
  const owner = new electron.BrowserWindow();
  const host = new RecordingHost({
    ownerWindow: owner as never,
    directory,
    moduleDirectory: "/fixture/preloads",
  });
  await host.open();
  const window = electron.windows.at(-1)!;
  const view = electron.views.at(-1)!;
  cleanups.push(async () => {
    owner.webContents.emit("did-start-navigation", {}, "", false, true);
    await host.store.checkBudget();
    await rm(directory, { recursive: true, force: true });
  });
  const generation = () => {
    const value = view.webContents.send.mock.calls
      .filter(([channel]) => channel === "crewon:recording:arm")
      .at(-1)?.[1] as { generation: string | null } | undefined;
    if (!value?.generation) throw new Error("source is not armed");
    return value.generation;
  };
  const source = (
    event: unknown,
    token = generation(),
    from = sender(view.webContents),
  ) => {
    electron.events.get("crewon:recording:event")!(from, {
      generation: token,
      event,
    });
  };
  const start = async () => {
    await invoke(
      "start",
      sender(window.webContents),
      "https://fixture.test/start",
    );
    view.webContents.emit("dom-ready");
    return generation();
  };
  return { directory, owner, host, window, view, start, source, generation };
}

beforeEach(() => {
  electron.windows.length = 0;
  electron.views.length = 0;
  electron.handlers.clear();
  electron.events.clear();
  vi.clearAllMocks();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("F02 R02/R03 host IPC identity and lifecycle", () => {
  it("grants controls only to the exact teaching window main frame", async () => {
    const f = await setup();
    const foreign = new electron.WebContents();
    for (const from of [
      sender(foreign),
      sender(f.window.webContents, {}),
      sender(f.view.webContents),
      sender(f.owner.webContents),
    ]) {
      await expect(invoke("state", from)).rejects.toThrow(
        "recording_sender_denied",
      );
      await expect(
        invoke("start", from, "https://fixture.test/start"),
      ).rejects.toThrow("recording_sender_denied");
      await expect(
        invoke("control", from, {
          command: "pause",
          recordingId: "rec-forged",
          expectedRevision: 1,
        }),
      ).rejects.toThrow("recording_sender_denied");
    }
    await expect(
      invoke("open", sender(f.owner.webContents, {})),
    ).rejects.toThrow("recording_sender_denied");
    await expect(invoke("open", sender(foreign))).rejects.toThrow(
      "recording_sender_denied",
    );
    await expect(
      invoke("open", sender(f.owner.webContents)),
    ).resolves.toBeUndefined();
    await expect(
      invoke("state", sender(f.window.webContents)),
    ).resolves.toMatchObject({ recording: null });
    expect(f.view.options).toMatchObject({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        preload: "/fixture/preloads/recordingPagePreload.cjs",
      },
    });
  });

  it("accepts source events only from the controlled view main frame and active generation", async () => {
    const f = await setup();
    const token = await f.start();
    f.source(click(), token, sender(new electron.WebContents()));
    f.source(click(), token, sender(f.window.webContents));
    f.source(click(), token, sender(f.view.webContents, {}));
    f.source(click(), "forged-generation");
    f.source(click(), token);
    await vi.waitFor(() => expect(f.host.store.current?.steps).toHaveLength(1));
    expect(f.host.store.current?.steps[0]?.target?.accessibleName).toBe(
      "Export sales",
    );
    expect(f.host.state().error).toBeNull();
  });

  it("drops in-flight and stale source capture on pause and requires a fresh generation after resume", async () => {
    const f = await setup();
    const oldGeneration = await f.start();
    let finishCapture!: (
      value: Awaited<ReturnType<typeof f.view.webContents.capturePage>>,
    ) => void;
    f.view.webContents.capturePage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCapture = resolve;
        }),
    );
    f.source(click({ screenshotSafe: true, layout }), oldGeneration);
    await vi.waitFor(() =>
      expect(f.view.webContents.capturePage).toHaveBeenCalledTimes(1),
    );
    await invoke("control", sender(f.window.webContents), {
      command: "pause",
      recordingId: f.host.store.current!.recordingId,
      expectedRevision: f.host.store.current!.revision,
    });
    f.source(click(), oldGeneration);
    finishCapture({ toPNG: () => Buffer.from("fixture-png") });
    await f.host.store.checkBudget();
    expect(f.host.store.current?.status).toBe("paused");
    expect(f.host.store.current?.steps).toEqual([]);
    await invoke("control", sender(f.window.webContents), {
      command: "resume",
      recordingId: f.host.store.current!.recordingId,
      expectedRevision: f.host.store.current!.revision,
    });
    expect(f.generation()).not.toBe(oldGeneration);
    f.source(click(), oldGeneration);
    f.source(click());
    await vi.waitFor(() => expect(f.host.store.current?.steps).toHaveLength(1));
    expect(f.host.store.current?.evidence).toEqual([]);
  });

  it("fails closed on malformed runtime-required input before persisting secret data", async () => {
    const f = await setup();
    await f.start();
    const secret = "sentinel-private-value";
    f.source({
      ...click(),
      kind: "input",
      input: { classification: "runtime-required", value: secret },
    });
    await vi.waitFor(() =>
      expect(f.host.store.current?.status).toBe("interrupted"),
    );
    expect(f.host.store.current?.steps).toEqual([]);
    expect(f.host.store.current?.evidence).toEqual([]);
    expect(f.view.webContents.capturePage).not.toHaveBeenCalled();
    const disk = await readFile(
      join(f.directory, f.host.store.current!.recordingId, "recording.json"),
      "utf8",
    );
    expect(disk).not.toContain(secret);
    expect((await validateRecordingExport(JSON.parse(disk))).status).toBe(
      "interrupted",
    );
  });

  it("preserves an accepted click before immediate navigation and discards its stale screenshot", async () => {
    const f = await setup();
    const oldGeneration = await f.start();
    let finishCapture!: (
      value: Awaited<ReturnType<typeof f.view.webContents.capturePage>>,
    ) => void;
    f.view.webContents.capturePage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCapture = resolve;
        }),
    );
    f.source(click({ screenshotSafe: true, layout }), oldGeneration);
    await vi.waitFor(() =>
      expect(f.view.webContents.capturePage).toHaveBeenCalledTimes(1),
    );
    const nextUrl = "https://fixture.test/next";
    f.view.webContents.emit("did-start-navigation", {}, nextUrl, false, true);
    f.view.webContents.url = nextUrl;
    f.view.webContents.emit("did-navigate", {}, nextUrl);
    finishCapture({ toPNG: () => Buffer.from("stale-private-frame") });
    await vi.waitFor(() => expect(f.host.store.current?.steps).toHaveLength(2));
    const recording = f.host.store.current!;
    expect(
      recording.steps.map(({ kind, page }) => [kind, page.routeTemplate]),
    ).toEqual([
      ["click", "https://fixture.test/start"],
      ["navigate", nextUrl],
    ]);
    expect(recording.steps.map((step) => step.sequence)).toEqual([1, 2]);
    expect(recording.evidence).toHaveLength(1);
    expect(recording.evidence[0]?.kind).toBe("redacted-layout");
    const evidence = await f.host.store.evidence(
      recording.evidence[0]!.evidenceId,
    );
    expect(
      Buffer.from(evidence.split(",")[1]!, "base64").toString(),
    ).not.toContain("stale-private-frame");
    await vi.waitFor(() => expect(f.generation()).not.toBe(oldGeneration));
  });

  it("persists the source's fixed sensitive-input reason without accepting secret values", async () => {
    const f = await setup();
    await f.start();
    f.source(
      click({
        kind: "input",
        input: { classification: "runtime-required" },
        reason: "sensitive-or-unbounded-input-omitted",
      }),
    );
    await vi.waitFor(() => expect(f.host.store.current?.steps).toHaveLength(1));
    expect(f.host.store.current?.status).toBe("recording");
    expect(f.host.store.current?.steps[0]?.input).toEqual({
      classification: "runtime-required",
    });
  });

  it("never encodes a frame rejected by the post-capture source check", async () => {
    const f = await setup();
    await f.start();
    const encode = vi.fn(() => Buffer.from("new-sensitive-overlay"));
    f.view.webContents.capturePage.mockImplementationOnce(async () => {
      f.view.webContents.send.mockImplementation((channel, payload) => {
        if (channel === "crewon:recording:verify-screenshot")
          electron.events.get("crewon:recording:screenshot-verified")!(
            sender(f.view.webContents),
            { ...(payload as object), safe: false },
          );
      });
      return { toPNG: encode };
    });
    f.source(click({ screenshotSafe: true, layout }));
    await vi.waitFor(() => expect(f.host.store.current?.steps).toHaveLength(1));
    expect(encode).not.toHaveBeenCalled();
    expect(f.host.store.current?.evidence[0]?.kind).toBe("redacted-layout");
  });

  it("associates a download after navigation disarms capture and then rearms the surviving page", async () => {
    const f = await setup();
    const first = await f.start();
    f.source(click());
    f.view.webContents.emit(
      "did-start-navigation",
      {},
      "https://fixture.test/export",
      false,
      true,
    );
    const item = Object.assign(new electron.WebContents(), {
      setSaveDialogOptions: vi.fn(),
    });
    f.view.webContents.session.emit(
      "will-download",
      {},
      item,
      f.view.webContents,
    );
    item.emit("done", {}, "completed");
    f.view.webContents.emit("did-stop-loading");
    await vi.waitFor(() =>
      expect(f.host.store.current?.steps.at(-1)).toMatchObject({
        kind: "download",
        outcome: "completed",
        relatedStepId: "step-1",
      }),
    );
    expect(f.generation()).not.toBe(first);
    f.source(click());
    await vi.waitFor(() => expect(f.host.store.current?.steps).toHaveLength(3));
  });

  it("does not append a queued download after an explicit pause", async () => {
    const f = await setup();
    await f.start();
    let release!: (
      value: Awaited<ReturnType<typeof f.view.webContents.capturePage>>,
    ) => void;
    f.view.webContents.capturePage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    f.source(click({ screenshotSafe: true, layout }));
    await vi.waitFor(() =>
      expect(f.view.webContents.capturePage).toHaveBeenCalledOnce(),
    );
    const item = Object.assign(new electron.WebContents(), {
      setSaveDialogOptions: vi.fn(),
    });
    f.view.webContents.session.emit(
      "will-download",
      {},
      item,
      f.view.webContents,
    );
    await invoke("control", sender(f.window.webContents), {
      command: "pause",
      recordingId: f.host.store.current!.recordingId,
      expectedRevision: f.host.store.current!.revision,
    });
    item.emit("done", {}, "completed");
    release({ toPNG: () => Buffer.from("late-frame") });
    await new Promise((resolve) => setImmediate(resolve));
    await f.host.store.checkBudget();
    expect(f.host.store.current?.status).toBe("paused");
    expect(f.host.store.current?.steps).toEqual([]);
  });

  it("requires an owner registration and exact request correlation for Skill handoff", async () => {
    const f = await setup();
    await f.start();
    f.source(click());
    await vi.waitFor(() => expect(f.host.store.current?.steps).toHaveLength(1));
    await invoke("control", sender(f.window.webContents), {
      command: "pause",
      recordingId: f.host.store.current!.recordingId,
      expectedRevision: f.host.store.current!.revision,
    });
    await expect(
      invoke("handoff", sender(f.window.webContents)),
    ).rejects.toThrow("recording_skill_import_unavailable");
    for (const from of [
      sender(f.window.webContents),
      sender(f.view.webContents),
      sender(f.owner.webContents, {}),
    ]) {
      await expect(invoke("skill-listening", from, true)).rejects.toThrow(
        "recording_sender_denied",
      );
    }
    await invoke("skill-listening", sender(f.owner.webContents), true);
    let settled = false;
    const handoff = invoke("handoff", sender(f.window.webContents)).then(
      (result) => {
        settled = true;
        return result;
      },
    );
    await vi.waitFor(() =>
      expect(f.owner.webContents.send).toHaveBeenCalledWith(
        "crewon:recording:skill-request",
        expect.any(Object),
      ),
    );
    const request = f.owner.webContents.send.mock.calls.find(
      ([channel]) => channel === "crewon:recording:skill-request",
    )?.[1] as RecordingSkillImportRequest;
    expect(await validateRecordingExport(request.recording)).toEqual(
      f.host.store.current,
    );
    const result: RecordingSkillImportResult = {
      ok: true,
      message: "Imported",
      skillId: "skill-fixture",
    };
    for (const from of [
      sender(f.window.webContents),
      sender(f.view.webContents),
      sender(f.owner.webContents, {}),
    ]) {
      await expect(
        invoke("skill-result", from, request.requestId, result),
      ).rejects.toThrow("recording_sender_denied");
    }
    await invoke(
      "skill-result",
      sender(f.owner.webContents),
      "wrong-request-id",
      result,
    );
    expect(settled).toBe(false);
    await invoke(
      "skill-result",
      sender(f.owner.webContents),
      request.requestId,
      result,
    );
    await expect(handoff).resolves.toEqual(result);
    expect(settled).toBe(true);
    f.owner.webContents.emit("did-start-navigation", {}, "", false, true);
    expect(f.host.state().skillImportAvailable).toBe(false);
    await expect(
      invoke("handoff", sender(f.window.webContents)),
    ).rejects.toThrow("recording_skill_import_unavailable");
  });
  it("execution lease stays separate from capture and revokes even while idle", async () => {
    const f = await setup();
    await f.start();
    const session = f.host.getExecutionSession()!;
    expect(() =>
      f.host.acquireExecution({
        sessionId: session.sessionId,
        ownerId: "task-one",
        expectedGeneration: session.generation,
      }),
    ).toThrow("recording_execution_unavailable");
    await invoke("control", sender(f.window.webContents), {
      command: "finish",
      recordingId: f.host.store.current!.recordingId,
      expectedRevision: 0,
    });
    const available = f.host.getExecutionSession()!;
    const listener = vi.fn();
    const unsubscribe = f.host.subscribeExecutionRevoked(listener);
    const lease = f.host.acquireExecution({
      sessionId: available.sessionId,
      ownerId: "task-one",
      expectedGeneration: available.generation,
    });
    expect(f.host.getExecutionSession()!.mode).toBe("executing");
    f.host.revokeExecution("user-takeover");
    expect(lease.signal.aborted).toBe(true);
    expect(listener).toHaveBeenCalledWith("user-takeover");
    f.host.revokeExecution("recording-started");
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    expect(() =>
      f.host.acquireExecution({
        sessionId: available.sessionId,
        ownerId: "task-one",
        expectedGeneration: -1,
      }),
    ).toThrow("recording_execution_unavailable");
  });
});
