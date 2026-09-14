import { recordingCaptureEvent } from "./recordingCaptureEvent.ts";
import { RecordingScreenshotVerifier } from "./recordingScreenshotVerifier.ts";
import type {
  RecordingExecutionSession,
  RecordingExecutionLease,
} from "./recordingExecutionSession.ts";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BrowserWindow,
  WebContentsView,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
} from "electron";
import type {
  RecordingState,
  RecordingSkillImportResult,
  RecordingSkillImportRequest,
} from "../src/lib/desktop/recordingBridge.ts";
import { RecordingStore, type ObservedStep } from "./recordingStore.ts";
import { recordingPage, teachingUrl } from "./recordingNavigation.ts";
import { recordingLayoutSvg, safeRecordingText } from "./recordingSource.ts";

export function isRecordingSender(
  event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">,
  window: BrowserWindow | null,
): boolean {
  return (
    window !== null &&
    !window.isDestroyed() &&
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame
  );
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("recording_request_invalid");
  return value as Record<string, unknown>;
};
const string = (value: unknown): string => {
  if (typeof value !== "string" || value.length > 8192)
    throw new Error("recording_request_invalid");
  return value;
};

/** Owns a single explicit teaching instance. No Control/Worker execution authority. */
export class RecordingHost {
  readonly store: RecordingStore;
  readonly screenshots = new RecordingScreenshotVerifier(
    () => this.#generation,
  );
  #window: BrowserWindow | null = null;
  #view: WebContentsView | null = null;
  #generation: string | null = null;
  #captureReady = false;
  #controlEpoch = 0;
  #authorizedOrigin: string | null = null;
  #error: string | null = null;
  #initialized: Promise<void> | null = null;
  #opening: Promise<void> | null = null;
  #sessionId: string | null = null;
  #documentGeneration = 0;
  #executionRevoked = new Set<(reason: string) => void>();
  #execution: {
    leaseId: string;
    ownerId: string;
    abort: AbortController;
  } | null = null;
  #pending = 0;
  #eventQueue: Promise<unknown> = Promise.resolve();
  #skillImportAvailable = false;
  #handoffPreparing = false;
  #handoff: {
    requestId: string;
    finish: (result: RecordingSkillImportResult) => void;
  } | null = null;
  constructor(
    readonly options: {
      ownerWindow: BrowserWindow;
      directory: string;
      moduleDirectory: string;
      rendererUrl?: string;
    },
  ) {
    this.store = new RecordingStore(options.directory);
    this.#register();
    options.ownerWindow.webContents.on(
      "did-start-navigation",
      (_event, _url, _inPlace, isMainFrame) => {
        if (!isMainFrame) return;
        this.#skillImportAvailable = false;
        this.#handoff?.finish({
          ok: false,
          message: "主窗口已切换，请重新打开 Skill 导入入口。",
        });
      },
    );
  }
  #guard(event: IpcMainInvokeEvent) {
    if (!isRecordingSender(event, this.#window))
      throw new Error("recording_sender_denied");
  }
  #register() {
    const handle = (
      method: string,
      operation: (...args: unknown[]) => unknown,
    ) =>
      ipcMain.handle(`crewon:recording:${method}`, (event, ...args) => {
        this.#guard(event);
        return Promise.resolve(operation(...args)).catch((error) => {
          this.#error =
            error instanceof Error ? error.message : "recording_failed";
          throw error;
        });
      });
    ipcMain.handle("crewon:recording:open", (event) => {
      if (
        !isRecordingSender(event, this.options.ownerWindow) &&
        !isRecordingSender(event, this.#window)
      )
        throw new Error("recording_sender_denied");
      return this.open();
    });
    ipcMain.handle(
      "crewon:recording:skill-listening",
      (event, available: unknown) => {
        if (
          !isRecordingSender(event, this.options.ownerWindow) ||
          typeof available !== "boolean"
        )
          throw new Error("recording_sender_denied");
        this.#skillImportAvailable = available;
      },
    );
    ipcMain.handle(
      "crewon:recording:skill-result",
      (event, requestId: unknown, result: unknown) => {
        if (!isRecordingSender(event, this.options.ownerWindow))
          throw new Error("recording_sender_denied");
        if (!this.#handoff || requestId !== this.#handoff.requestId) return;
        const data = object(result);
        if (
          typeof data.ok !== "boolean" ||
          typeof data.message !== "string" ||
          data.message.length > 500
        )
          throw new Error("recording_request_invalid");
        this.#handoff.finish({
          ok: data.ok,
          message: data.message,
          ...(typeof data.skillId === "string"
            ? { skillId: data.skillId }
            : {}),
        });
      },
    );
    handle("handoff", async () => {
      const recording = this.store.current;
      if (
        !this.#skillImportAvailable ||
        this.#handoff ||
        this.#handoffPreparing
      )
        throw new Error("recording_skill_import_unavailable");
      if (
        !recording ||
        recording.status === "recording" ||
        !recording.steps.length
      )
        throw new Error("recording_pause_before_export");
      this.#handoffPreparing = true;
      try {
        const evidence: RecordingSkillImportRequest["evidence"] = [];
        for (const entry of recording.evidence) {
          const data = await this.store.evidence(entry.evidenceId);
          evidence.push({
            evidenceId: entry.evidenceId,
            mediaType: entry.mediaType,
            dataBase64: data.slice(data.indexOf(",") + 1),
          });
        }
        if (
          recording.recordingId !== this.store.current?.recordingId ||
          recording.revision !== this.store.current.revision
        )
          throw new Error("recording_revision_conflict");
        const requestId = randomUUID();
        return await new Promise<RecordingSkillImportResult>((resolve) => {
          const timer = setTimeout(
            () =>
              this.#handoff?.requestId === requestId &&
              this.#handoff.finish({
                ok: false,
                message:
                  "Skill 导入结果尚未确认；请先检查主窗口，避免重复导入。",
              }),
            60000,
          );
          this.#handoff = {
            requestId,
            finish: (result) => {
              clearTimeout(timer);
              this.#handoff = null;
              resolve(result);
            },
          };
          this.options.ownerWindow.webContents.send(
            "crewon:recording:skill-request",
            { requestId, recording, evidence },
          );
        });
      } finally {
        this.#handoffPreparing = false;
      }
    });
    handle("state", async () => {
      await this.store.checkBudget();
      if (this.store.current?.status !== "recording") this.#disarm();
      return this.state();
    });
    handle("start", async (value) => {
      const url = teachingUrl(value);
      this.revokeExecution("recording-started");
      this.#controlEpoch++;
      this.#disarm();
      await this.store.start(new URL(url).origin);
      this.#authorizedOrigin = new URL(url).origin;
      this.#error = null;
      await this.#navigate(url);
      return this.state();
    });
    handle("navigate", async (value) => {
      await this.#navigate(teachingUrl(value));
      return this.state();
    });
    handle("control", async (value) => {
      const request = object(value);
      if (!["pause", "resume", "finish"].includes(String(request.command)))
        throw new Error("recording_request_invalid");
      this.revokeExecution("recording-control");
      this.#controlEpoch++;
      if (request.command !== "resume") this.#disarm();
      const url = this.#view?.webContents.getURL();
      const origin =
        url && /^https?:/.test(url) ? new URL(url).origin : undefined;
      await this.store.control(
        request.command as "pause" | "resume" | "finish",
        Number(request.expectedRevision),
        origin,
        string(request.recordingId),
      );
      if (request.command === "resume") {
        this.#authorizedOrigin = origin ?? null;
        this.#arm();
      }
      this.#error = null;
      return this.state();
    });
    handle("edit", async (value) => {
      const request = object(value);
      if (!["delete", "annotate"].includes(String(request.operation)))
        throw new Error("recording_request_invalid");
      const note =
        request.note === null ? null : safeRecordingText(request.note);
      if (request.note !== null && note === null)
        throw new Error("recording_note_sensitive_or_too_long");
      await this.store.edit({
        stepId: string(request.stepId),
        operation: request.operation as "delete" | "annotate",
        note,
        expectedRevision: Number(request.expectedRevision),
      });
      return this.state();
    });
    handle("select", async (id) => {
      await this.store.select(string(id));
      this.#disarm();
      return this.state();
    });
    handle("remove", async (id) => {
      await this.store.remove(string(id));
      if (!this.store.current) this.#disarm();
      return this.state();
    });
    handle("evidence", (id) => this.store.evidence(string(id)));
    handle("export", async () => {
      const recording = this.store.current;
      if (!recording || recording.status === "recording")
        throw new Error("recording_pause_before_export");
      const result = await dialog.showSaveDialog(this.#window!, {
        title: "导出浏览器教学",
        defaultPath: `${recording.recordingId}.json`,
        filters: [{ name: "RecordingExport JSON", extensions: ["json"] }],
      });
      if (result.canceled || !result.filePath) return { cancelled: true };
      await writeFile(result.filePath, JSON.stringify(recording, null, 2), {
        mode: 0o600,
      });
      return { cancelled: false };
    });
    handle("bounds", (value) => {
      const b = object(value);
      const { width, height } = this.#window!.getContentBounds();
      const coordinates = ["x", "y", "width", "height"].map((key) => b[key]);
      if (coordinates.some((n) => !Number.isSafeInteger(n) || Number(n) < 0))
        throw new Error("recording_bounds_invalid");
      const bounds = {
        x: Number(b.x),
        y: Number(b.y),
        width: Number(b.width),
        height: Number(b.height),
      };
      if (
        bounds.width < 1 ||
        bounds.height < 1 ||
        bounds.x + bounds.width > width + 1 ||
        bounds.y + bounds.height > height + 1
      )
        throw new Error("recording_bounds_invalid");
      this.#view?.setBounds(bounds);
      this.#view?.setVisible(true);
    });
    ipcMain.on("crewon:recording:armed", (event, generation: unknown) => {
      const view = this.#view;
      if (
        view &&
        event.sender === view.webContents &&
        event.senderFrame === view.webContents.mainFrame &&
        generation === this.#generation &&
        generation !== null
      ) {
        this.#captureReady = true;
        view.setVisible(true);
      }
    });
    ipcMain.on("crewon:recording:event", (sender, payload: unknown) => {
      const view = this.#view;
      if (
        !view ||
        view.webContents.isDestroyed() ||
        sender.sender !== view.webContents ||
        sender.senderFrame !== view.webContents.mainFrame
      )
        return;
      try {
        const message = object(payload);
        if (message.generation !== this.#generation || !this.#generation)
          return;
        if (JSON.stringify(payload).length > 8192 || this.#pending >= 5) {
          this.#fail("recording_source_overflow");
          return;
        }
        const generation = this.#generation;
        const epoch = this.#controlEpoch;
        const url = view.webContents.getURL();
        this.#pending++;
        void this.#enqueue(() =>
          this.#capture(message.event, generation, epoch, url),
        )
          .catch(() => this.#fail("recording_capture_failed"))
          .finally(() => this.#pending--);
      } catch {
        this.#fail("recording_source_invalid");
      }
    });
  }
  state(): RecordingState {
    const url = this.#view?.webContents.getURL();
    return {
      skillImportAvailable: this.#skillImportAvailable,
      captureReady: this.#captureReady,
      recording: this.store.current,
      pageOrigin: url && /^https?:/.test(url) ? new URL(url).origin : null,
      error: this.#error,
      recordings: this.store.list(),
    };
  }
  async open(): Promise<void> {
    if (this.#window && !this.#window.isDestroyed()) {
      this.#window.show();
      this.#window.focus();
      return;
    }
    if (this.#opening) return this.#opening;
    this.#opening = this.#open().finally(() => {
      this.#opening = null;
    });
    return this.#opening;
  }
  async #open() {
    this.#initialized ??= this.store.initialize();
    await this.#initialized;
    const window = new BrowserWindow({
      width: 1180,
      height: 820,
      minWidth: 680,
      minHeight: 560,
      title: "CrewON · 浏览器教学",
      backgroundColor: "#f5f5f5",
      webPreferences: {
        preload: join(this.options.moduleDirectory, "recordingPreload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    this.#window = window;
    const view = new WebContentsView({
      webPreferences: {
        preload: join(this.options.moduleDirectory, "recordingPagePreload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        partition: "persist:crewon-teaching",
      },
    });
    this.#view = view;
    this.#sessionId = `teaching-${randomUUID()}`;
    this.#documentGeneration = 0;
    window.contentView.addChildView(view);
    view.setVisible(false);
    view.webContents.session.setPermissionRequestHandler(
      (_webContents, _permission, callback) => callback(false),
    );
    view.webContents.session.setPermissionCheckHandler(() => false);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    view.webContents.setWindowOpenHandler(() => {
      void this.#unsupported("new-window-not-recorded");
      return { action: "deny" };
    });
    view.webContents.on("will-navigate", (event, url) => {
      try {
        teachingUrl(url);
      } catch {
        event.preventDefault();
        void this.#unsupported("unsupported-navigation");
        return;
      }
      this.#disarm();
      void this.#pauseForOrigin(new URL(url).origin);
    });
    view.webContents.on(
      "did-start-navigation",
      (_event, _url, _inPlace, isMainFrame) => {
        if (isMainFrame) {
          this.#documentGeneration++;
          this.revokeExecution("page-generation-changed");
          this.#disarm();
        }
      },
    );
    const navigated = async (url: string) => {
      await this.#pauseForOrigin(new URL(url).origin);
      if (this.store.current?.status === "recording")
        await this.store.append(this.#step("navigate", url));
      this.#arm();
    };
    view.webContents.on("did-navigate", (_event, url) => {
      void this.#enqueue(() => navigated(url)).catch(() =>
        this.#fail("recording_navigation_failed"),
      );
    });
    view.webContents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (isMainFrame)
        void this.#enqueue(() => navigated(url)).catch(() =>
          this.#fail("recording_navigation_failed"),
        );
    });
    view.webContents.on("dom-ready", () => this.#arm());
    view.webContents.on("did-stop-loading", () => this.#arm());
    view.webContents.on("preload-error", () =>
      this.#fail("recording_source_unavailable"),
    );
    view.webContents.on("render-process-gone", () =>
      this.#fail("recording_page_crashed"),
    );
    view.webContents.on(
      "did-fail-load",
      (_event, code, _description, _url, isMainFrame) => {
        if (isMainFrame && code !== -3)
          this.#fail("recording_page_load_failed");
      },
    );
    view.webContents.session.on(
      "will-download",
      (_event, item, webContents) => {
        if (
          webContents !== view.webContents ||
          this.store.current?.status !== "recording"
        )
          return;
        const current = this.store.current;
        const relatedStepId = current.steps.at(-1)?.stepId ?? null;
        // Listen before persistence so a fast completion cannot be lost.
        let outcome: "completed" | "cancelled" | "unknown" = "unknown";
        let done = false;
        item.once("done", (_e, state) => {
          done = true;
          outcome =
            state === "completed"
              ? "completed"
              : state === "cancelled"
                ? "cancelled"
                : "unknown";
        });
        item.setSaveDialogOptions({ title: "保存教学下载" });
        const appended = this.store.append({
          ...this.#step("download", view.webContents.getURL()),
          relatedStepId,
          outcome: "unknown",
        });
        void appended
          .then(async (value) => {
            const step = value.steps.at(-1);
            if (!step || step.kind !== "download") return;
            const update = () =>
              void this.store
                .updateDownload(current.recordingId, step.stepId, outcome)
                .catch(() => this.#fail("recording_download_save_failed"));
            if (done) update();
            else item.once("done", () => update());
          })
          .catch(() => this.#fail("recording_download_save_failed"));
      },
    );
    window.on("close", () => {
      this.revokeExecution("window-closed");
      this.#controlEpoch++;
      this.#disarm();
      void this.store.interrupt().catch(() => undefined);
    });
    window.on("closed", () => {
      this.#disarm();
      if (!view.webContents.isDestroyed()) view.webContents.close();
      this.#window = null;
      this.#view = null;
      this.#sessionId = null;
    });
    if (this.options.rendererUrl)
      await window.loadURL(this.options.rendererUrl);
    else
      await window.loadFile(
        join(this.options.moduleDirectory, "../dist/index.html"),
      );
  }
  getExecutionSession(sessionId?: string): RecordingExecutionSession | null {
    if (
      !this.#sessionId ||
      !this.#view ||
      this.#view.webContents.isDestroyed() ||
      (sessionId !== undefined && sessionId !== this.#sessionId)
    )
      return null;
    const status = this.store.current?.status;
    const mode =
      status === "recording" || status === "paused" || status === "interrupted"
        ? status
        : this.#execution
          ? "executing"
          : "idle";
    return {
      sessionId: this.#sessionId,
      webContents: this.#view.webContents,
      generation: this.#documentGeneration,
      mode,
    };
  }
  acquireExecution(request: {
    sessionId: string;
    ownerId: string;
    expectedGeneration: number;
  }): RecordingExecutionLease {
    const session = this.getExecutionSession(request.sessionId);
    if (
      !session ||
      session.mode !== "idle" ||
      session.generation !== request.expectedGeneration ||
      !request.ownerId
    )
      throw new Error("recording_execution_unavailable");
    this.#disarm();
    const leaseId = randomUUID();
    const abort = new AbortController();
    this.#execution = { leaseId, ownerId: request.ownerId, abort };
    return {
      leaseId,
      sessionId: session.sessionId,
      generation: session.generation,
      signal: abort.signal,
    };
  }
  releaseExecution(leaseId: string) {
    if (this.#execution?.leaseId === leaseId) this.revokeExecution("released");
  }
  subscribeExecutionRevoked(listener: (reason: string) => void) {
    this.#executionRevoked.add(listener);
    return () => {
      this.#executionRevoked.delete(listener);
    };
  }
  revokeExecution(reason: string) {
    this.#execution?.abort.abort(reason);
    this.#execution = null;
    for (const listener of this.#executionRevoked) listener(reason);
  }
  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#eventQueue.then(operation);
    this.#eventQueue = result.catch(() => undefined);
    return result;
  }
  #disarm() {
    this.#generation = null;
    this.#captureReady = false;
    if (this.#view && !this.#view.webContents.isDestroyed())
      this.#view.webContents.send("crewon:recording:arm", { generation: null });
  }
  #arm() {
    const view = this.#view;
    if (
      !view ||
      view.webContents.isDestroyed() ||
      this.store.current?.status !== "recording"
    )
      return;
    const url = view.webContents.getURL();
    if (!/^https?:/.test(url) || new URL(url).origin !== this.#authorizedOrigin)
      return;
    this.#generation ??= randomUUID();
    view.webContents.send("crewon:recording:arm", {
      generation: this.#generation,
    });
  }
  async #pauseForOrigin(origin: string) {
    if (origin === this.#authorizedOrigin) return;
    this.#disarm();
    const value = this.store.current;
    if (value?.status === "recording") {
      await this.store.control("pause", value.revision);
      this.#error = "页面来源已变化，检查地址后点击继续以授权当前页面。";
    }
  }
  async #navigate(url: string) {
    if (!this.#view) throw new Error("recording_window_unavailable");
    this.revokeExecution("user-navigation");
    this.#disarm();
    await this.#pauseForOrigin(new URL(url).origin);
    try {
      this.#view.setVisible(false);
      await this.#view.webContents.loadURL(url);
      if (this.store.current?.status !== "recording")
        this.#view.setVisible(true);
    } catch {
      this.#fail("recording_page_load_failed");
    }
  }
  #step(kind: ObservedStep["kind"], url: string): ObservedStep {
    return {
      kind,
      page: recordingPage(url),
      target: null,
      input: null,
      note: null,
      outcome: "observed",
      reason: null,
      relatedStepId: null,
    };
  }
  async #unsupported(reason: string) {
    const url = this.#view?.webContents.getURL();
    if (url && this.store.current?.status === "recording")
      await this.store.append({ ...this.#step("unsupported", url), reason });
  }
  #fail(reason: string) {
    this.#error = reason;
    this.#disarm();
    void this.store.interrupt().catch(() => undefined);
  }
  async #capture(raw: unknown, generation: string, epoch: number, url: string) {
    const event = recordingCaptureEvent(raw);
    const view = this.#view;
    if (!view || this.#controlEpoch !== epoch) return;
    let evidence: string | Buffer | undefined;
    // Capture only a source-checked standard control. Never encode a full page image.
    if (
      this.#generation === generation &&
      view.webContents.getURL() === url &&
      event.screenshotSafe &&
      event.layout &&
      event.target &&
      (await this.screenshots.verify(
        view.webContents,
        generation,
        event.target.selector,
      ))
    ) {
      const { x, y, targetWidth: width, targetHeight: height } = event.layout;
      if (
        [x, y, width, height].every(Number.isFinite) &&
        x >= 0 &&
        y >= 0 &&
        width > 0 &&
        height > 0 &&
        width <= 512 &&
        height <= 256 &&
        x + width <= event.layout.width &&
        y + height <= event.layout.height
      ) {
        const frame = await view.webContents.capturePage({
          x: Math.round(x),
          y: Math.round(y),
          width: Math.max(1, Math.round(width)),
          height: Math.max(1, Math.round(height)),
        });
        if (
          await this.screenshots.verify(
            view.webContents,
            generation,
            event.target.selector,
          )
        ) {
          const png = frame.toPNG();
          if (png.byteLength <= 16384) evidence = png;
        }
      }
    }
    if (this.#generation !== generation || view.webContents.getURL() !== url)
      evidence = undefined;
    if (!evidence && event.layout) evidence = recordingLayoutSvg(event.layout);
    if (this.#controlEpoch !== epoch) return;
    await this.store.append(
      {
        ...this.#step(event.kind, url),
        target: event.target,
        input: event.input,
        reason:
          event.reason ??
          (evidence && Buffer.isBuffer(evidence)
            ? null
            : "screenshot-unavailable"),
      },
      evidence,
    );
    if (event.kind === "unsupported" && event.reason === "source-rate-limit")
      this.#fail("recording_source_overflow");
    if (this.store.current?.status !== "recording") this.#disarm();
  }
}
