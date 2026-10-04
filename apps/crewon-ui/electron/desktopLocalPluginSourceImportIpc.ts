import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import type {
  DesktopLocalPluginSourceConfirmation,
  DesktopLocalPluginSourceImportStatus,
} from "../src/lib/desktop/desktopLocalPluginSourceImportProtocol.ts";
import {
  createDesktopLocalPluginSourceImporter,
  type DesktopLocalPluginSourceImporter,
} from "./desktopLocalPluginSourceImport.ts";
import type { RuntimeSupervisor } from "./runtimeSupervisor.ts";

const CHANNELS = [
  "crewon:plugin-sources:preview-v1",
  "crewon:plugin-sources:confirm-v1",
  "crewon:plugin-sources:cancel-v1",
  "crewon:plugin-sources:status-v1",
] as const;
export const DESKTOP_PLUGIN_SOURCE_OWNER_CHANGED =
  "crewon:plugin-sources:owner-changed-v1";
export const DESKTOP_PLUGIN_SOURCE_STATUS_CHANGED =
  "crewon:plugin-sources:status-changed-v1";
type StatusSlot = {
  generation: number;
  value: DesktopLocalPluginSourceImportStatus;
};

/** Native directory paths never cross the isolated preload boundary. */
export function bindDesktopLocalPluginSourceImportIpc(
  input: Readonly<{
    window: BrowserWindow;
    ipc: IpcMain;
    dataDirectory: string;
    rendererUrl: string;
    runtime: Pick<
      RuntimeSupervisor,
      | "mutateWhileStopped"
      | "onSessionInvalidated"
      | "onLocalManagementAccessChanged"
    >;
    chooseDirectory(): Promise<string | null>;
    diagnostic(code: string): void;
    createImporter?: typeof createDesktopLocalPluginSourceImporter;
  }>,
): Readonly<{ close(): Promise<void> }> {
  const { window, ipc, runtime } = input;
  const contents = window.webContents;
  const createImporter =
    input.createImporter ?? createDesktopLocalPluginSourceImporter;
  let documentGeneration = 0;
  let importer: DesktopLocalPluginSourceImporter | null = null;
  let retiring: Promise<void> = Promise.resolve();
  let flight = false;
  let currentFlight: Promise<unknown> | null = null;
  let closed = false;
  let expectedStop = false;
  let holdOwnNotifications = false;
  // One bounded, memory-only receipt. Its document fence is separate from the
  // original runtime access, which still withdraws during every physical stop.
  let status: StatusSlot | null = null;

  const notify = () => {
    if (!window.isDestroyed() && !contents.isDestroyed())
      contents.send(DESKTOP_PLUGIN_SOURCE_OWNER_CHANGED);
  };
  const notifyStatus = () => {
    if (window.isDestroyed() || contents.isDestroyed()) return;
    try {
      contents.send(DESKTOP_PLUGIN_SOURCE_STATUS_CHANGED);
    } catch {
      // A diagnostic notification cannot rewrite the approval's commit outcome.
      input.diagnostic("desktop_plugin_source_status_notification_failed");
    }
  };
  const withdraw = () => {
    documentGeneration++;
    status = null;
    const previous = importer;
    importer = null;
    if (previous) {
      const join = previous.close();
      retiring = Promise.all([retiring, join]).then(() => undefined);
      void retiring.catch(() =>
        input.diagnostic("desktop_plugin_source_cleanup_failed"),
      );
    }
    notify();
    return retiring;
  };
  const guard = (event: IpcMainInvokeEvent) => {
    if (
      closed ||
      window.isDestroyed() ||
      contents.isDestroyed() ||
      event.sender !== contents ||
      event.senderFrame !== contents.mainFrame ||
      !sameRenderer(contents.mainFrame.url, input.rendererUrl)
    )
      throw new Error("desktop_plugin_source_sender_invalid");
    const generation = documentGeneration;
    const frame = event.senderFrame;
    return () => {
      if (
        closed ||
        generation !== documentGeneration ||
        window.isDestroyed() ||
        contents.isDestroyed() ||
        frame !== contents.mainFrame ||
        !sameRenderer(contents.mainFrame.url, input.rendererUrl)
      )
        throw new Error("desktop_plugin_source_owner_changed");
    };
  };
  const owner = (assertCurrent: () => void) => {
    assertCurrent();
    if (!importer)
      importer = createImporter({
        dataDirectory: input.dataDirectory,
        assertCurrent,
        // The original Supervisor queue already physically stopped this owner.
        beforeApprovalCommit: async () => assertCurrent(),
      });
    return importer;
  };
  const exclusive = <T>(
    event: IpcMainInvokeEvent,
    operation: (assertCurrent: () => void) => Promise<T>,
  ): Promise<T> => {
    const assertCurrent = guard(event);
    if (flight) throw new Error("desktop_plugin_source_busy");
    flight = true;
    const pending: Promise<T> = (async () => {
      try {
        await retiring;
        assertCurrent();
        return await operation(assertCurrent);
      } finally {
        flight = false;
        currentFlight = null;
      }
    })();
    currentFlight = pending;
    return pending;
  };

  ipc.handle(CHANNELS[0], (event, ...args: unknown[]) =>
    exclusive(event, async (assertCurrent) => {
      if (args.length !== 0)
        throw new Error("desktop_plugin_source_request_invalid");
      const directory = await input.chooseDirectory();
      assertCurrent();
      if (directory === null) return null;
      return owner(assertCurrent).previewDirectory(directory);
    }),
  );
  ipc.handle(CHANNELS[1], (event, ...args: unknown[]) =>
    exclusive(event, async (assertCurrent) => {
      if (args.length !== 1 || importer === null)
        throw new Error("desktop_plugin_source_request_invalid");
      const current = importer;
      // Accept the exact consent before stopping can unmount the old Settings tree.
      // The Main document fence, not a preview component's cleanup, owns this intent.
      const command = current.claimPreview(
        args[0] as DesktopLocalPluginSourceConfirmation,
      );
      const identity = Object.freeze({
        previewId: command.previewId,
        pluginId: command.pluginId,
        publisherId: command.publisherId,
        version: command.version,
        packageDigest: command.packageDigest,
      });
      const slot: StatusSlot = {
        generation: documentGeneration,
        value: Object.freeze({
          ...identity,
          state: "pending",
        }),
      };
      status = slot;
      notifyStatus();
      const publish = (value: DesktopLocalPluginSourceImportStatus) => {
        if (status !== slot || closed || slot.generation !== documentGeneration)
          return;
        slot.value = value;
        notifyStatus();
      };
      holdOwnNotifications = true;
      try {
        const result = await runtime.mutateWhileStopped({
          mutation: async () => {
            assertCurrent();
            if (importer !== current)
              throw new Error("desktop_plugin_source_owner_changed");
            return current.confirmPreview(command);
          },
          onStopInvalidation: async (stop) => {
            let stopping: Promise<void>;
            // stop() invalidates synchronously. Only that one notification is ours;
            // queued restarts are serialized by Supervisor, never hidden by this flag.
            expectedStop = true;
            try {
              stopping = stop();
            } finally {
              expectedStop = false;
            }
            await stopping;
            assertCurrent();
          },
        });
        // Approval is committed. A later document change cannot turn it into a rollback.
        const confirmed = Object.freeze({
          ...result.value,
          restartRequired: result.runtimeStatus === "restartRequired",
          runtimeStatus: result.runtimeStatus,
        });
        // Store before joining importer cleanup. A cleanup rejection may reject
        // the invocation, but cannot turn the committed approval into failure.
        publish(
          Object.freeze({
            ...identity,
            state: "committed",
            result: confirmed,
          }),
        );
        return confirmed;
      } catch (error) {
        publish(
          Object.freeze({
            ...identity,
            state: "failed",
            code: "desktop_plugin_source_import_failed",
          }),
        );
        throw error;
      } finally {
        holdOwnNotifications = false;
        if (importer === current) importer = null;
        const joined = current.close();
        retiring = Promise.all([retiring, joined]).then(() => undefined);
        await retiring;
      }
    }),
  );
  ipc.handle(CHANNELS[2], (event, ...args: unknown[]) => {
    guard(event)();
    if (args.length !== 1)
      throw new Error("desktop_plugin_source_request_invalid");
    importer?.cancelPreview(args[0] as Readonly<{ previewId: string }>);
  });
  ipc.handle(CHANNELS[3], (event, ...args: unknown[]) => {
    const assertCurrent = guard(event);
    if (args.length !== 1)
      throw new Error("desktop_plugin_source_request_invalid");
    const previewId = statusPreviewId(args[0]);
    assertCurrent();
    // Reading during a live confirmation neither competes with its mutation
    // flight nor constructs an importer, opens a dialog or starts a runtime.
    if (
      status === null ||
      status.generation !== documentGeneration ||
      status.value.previewId !== previewId
    )
      return null;
    const copy = copyStatus(status.value);
    assertCurrent();
    return copy;
  });

  const removeInvalidation = runtime.onSessionInvalidated(() => {
    if (expectedStop) {
      expectedStop = false;
      return;
    }
    return withdraw();
  });
  const removeManagement = runtime.onLocalManagementAccessChanged(() => {
    if (!holdOwnNotifications) notify();
  });
  const navigate = (
    details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
  ) => {
    if (details.isMainFrame && !details.isSameDocument) void withdraw();
  };
  const crashed = () => {
    void withdraw();
  };
  contents.on("did-start-navigation", navigate);
  contents.on("render-process-gone", crashed);
  const close = () => {
    if (!closed) {
      closed = true;
      for (const channel of CHANNELS) ipc.removeHandler(channel);
      removeInvalidation();
      removeManagement();
      contents.off("did-start-navigation", navigate);
      contents.off("render-process-gone", crashed);
      withdraw();
    }
    return Promise.all([
      retiring,
      currentFlight?.then(
        () => undefined,
        () => undefined,
      ),
    ]).then(() => undefined);
  };
  contents.once("destroyed", () => {
    void close().catch(() =>
      input.diagnostic("desktop_plugin_source_cleanup_failed"),
    );
  });
  return Object.freeze({ close });
}

function statusPreviewId(input: unknown): string {
  if (
    input === null ||
    typeof input !== "object" ||
    Object.getPrototypeOf(input) !== Object.prototype
  )
    throw new Error("desktop_plugin_source_request_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  const field = descriptors.previewId;
  if (
    keys.length !== 1 ||
    keys[0] !== "previewId" ||
    !field?.enumerable ||
    !Object.hasOwn(field, "value") ||
    typeof field.value !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(field.value)
  )
    throw new Error("desktop_plugin_source_request_invalid");
  return field.value;
}

function copyStatus(
  value: DesktopLocalPluginSourceImportStatus,
): DesktopLocalPluginSourceImportStatus {
  return value.state === "committed"
    ? Object.freeze({ ...value, result: Object.freeze({ ...value.result }) })
    : Object.freeze({ ...value });
}

function sameRenderer(actual: string, expected: string): boolean {
  try {
    const url = new URL(actual);
    const original = new URL(expected);
    return (
      url.protocol === original.protocol &&
      url.origin === original.origin &&
      url.host === original.host &&
      url.pathname === original.pathname &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}
