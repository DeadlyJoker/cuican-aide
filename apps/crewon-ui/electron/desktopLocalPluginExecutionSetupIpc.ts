import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import type {
  DesktopLocalPluginExecutionPreview,
  DesktopLocalPluginExecutionStatus,
} from "../src/lib/desktop/desktopLocalPluginExecutionSetupProtocol.ts";
import {
  createDesktopLocalPluginExecutionSetupOwner,
  parseDesktopLocalPluginExecutionSetupPluginId,
  type DesktopLocalPluginExecutionSetupOwner,
} from "./desktopLocalPluginExecutionSetup.ts";
import type { RuntimeSupervisor } from "./runtimeSupervisor.ts";

const CHANNELS = [
  "crewon:plugin-execution:preview-v1",
  "crewon:plugin-execution:confirm-v1",
  "crewon:plugin-execution:cancel-v1",
  "crewon:plugin-execution:status-v1",
] as const;
export const DESKTOP_PLUGIN_EXECUTION_OWNER_CHANGED =
  "crewon:plugin-execution:owner-changed-v1";
export const DESKTOP_PLUGIN_EXECUTION_STATUS_CHANGED =
  "crewon:plugin-execution:status-changed-v1";
type StatusSlot = {
  generation: number;
  value: DesktopLocalPluginExecutionStatus;
};

/** Owns one Native document's consent and receipt, never renderer-issued authority. */
export function bindDesktopLocalPluginExecutionSetupIpc(
  input: Readonly<{
    window: BrowserWindow;
    ipc: IpcMain;
    dataDirectory: string;
    rendererUrl: string;
    runtime: Pick<
      RuntimeSupervisor,
      | "currentPluginBootstrap"
      | "preparePluginExecutionSetup"
      | "onSessionInvalidated"
      | "onLocalManagementAccessChanged"
    > &
      Partial<Pick<RuntimeSupervisor, "currentPreparedPluginRuntime">>;
    diagnostic(code: string): void;
    createOwner?: typeof createDesktopLocalPluginExecutionSetupOwner;
  }>,
): Readonly<{ close(): Promise<void> }> {
  const { window, ipc, runtime } = input;
  const contents = window.webContents;
  const createOwner =
    input.createOwner ?? createDesktopLocalPluginExecutionSetupOwner;
  let generation = 0;
  let owner: DesktopLocalPluginExecutionSetupOwner | null = null;
  let preview: DesktopLocalPluginExecutionPreview | null = null;
  let status: StatusSlot | null = null;
  let retiring: Promise<void> = Promise.resolve();
  let flight: Promise<unknown> | null = null;
  let closed = false;
  let expectedStop = false;
  let holdOwnNotifications = false;

  const notify = (channel: string) => {
    if (window.isDestroyed() || contents.isDestroyed()) return;
    try {
      contents.send(channel);
    } catch {
      input.diagnostic("desktop_plugin_execution_notification_failed");
    }
  };
  const withdraw = () => {
    generation++;
    preview = null;
    status = null;
    const previous = owner;
    owner = null;
    if (previous) {
      retiring = Promise.all([retiring, previous.close()]).then(
        () => undefined,
      );
      void retiring.catch(() =>
        input.diagnostic("desktop_plugin_execution_cleanup_failed"),
      );
    }
    notify(DESKTOP_PLUGIN_EXECUTION_OWNER_CHANGED);
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
      fail("sender_invalid");
    const expectedGeneration = generation;
    const frame = event.senderFrame;
    return () => {
      if (
        closed ||
        expectedGeneration !== generation ||
        window.isDestroyed() ||
        contents.isDestroyed() ||
        frame !== contents.mainFrame ||
        !sameRenderer(contents.mainFrame.url, input.rendererUrl)
      )
        fail("owner_changed");
    };
  };
  const exclusive = <T>(
    event: IpcMainInvokeEvent,
    operation: (assertCurrent: () => void) => Promise<T>,
  ): Promise<T> => {
    const assertCurrent = guard(event);
    if (flight !== null) fail("busy");
    const pending = Promise.resolve().then(async () => {
      try {
        await retiring;
        assertCurrent();
        return await operation(assertCurrent);
      } finally {
        if (flight === pending) flight = null;
      }
    });
    flight = pending;
    return pending;
  };

  ipc.handle(CHANNELS[0], (event, ...args: unknown[]) =>
    exclusive(event, async (assertCurrent) => {
      if (args.length !== 1) fail("request_invalid");
      const pluginId = parseDesktopLocalPluginExecutionSetupPluginId(args[0]);
      const bootstrap = await runtime.currentPluginBootstrap();
      assertCurrent();
      if (owner === null)
        owner = createOwner({
          dataDirectory: input.dataDirectory,
          assertCurrent,
        });
      const preparedRuntime = runtime.currentPreparedPluginRuntime;
      const value = await owner.preview({
        bootstrap,
        pluginId,
        ...(preparedRuntime === undefined
          ? {}
          : { runtime: preparedRuntime.call(runtime) }),
      });
      assertCurrent();
      preview = value;
      return value;
    }),
  );

  ipc.handle(CHANNELS[1], (event, ...args: unknown[]) =>
    exclusive(event, async (assertCurrent) => {
      if (args.length !== 1 || owner === null || preview === null)
        fail("request_invalid");
      const current = owner;
      // Main owns the accepted intent before its first stop can unmount Settings.
      const claim = current.claimPreview(args[0]);
      const identity = Object.freeze({
        previewId: preview.previewId,
        pluginId: preview.pluginId,
      });
      preview = null;
      const slot: StatusSlot = {
        generation,
        value: Object.freeze({ ...identity, state: "pending" }),
      };
      status = slot;
      notify(DESKTOP_PLUGIN_EXECUTION_STATUS_CHANGED);
      const publish = (value: DesktopLocalPluginExecutionStatus) => {
        if (closed || status !== slot || slot.generation !== generation) return;
        slot.value = value;
        notify(DESKTOP_PLUGIN_EXECUTION_STATUS_CHANGED);
      };
      holdOwnNotifications = true;
      try {
        const result = await runtime.preparePluginExecutionSetup({
          owner: current,
          claim,
          onStopInvalidation: async (stop) => {
            let stopping: Promise<void>;
            expectedStop = true;
            try {
              stopping = stop();
            } finally {
              expectedStop = false;
            }
            await stopping;
            assertCurrent();
            if (owner !== current) fail("owner_changed");
          },
        });
        publish(Object.freeze({ ...identity, state: "committed", result }));
        return result;
      } catch (error) {
        publish(
          Object.freeze({
            ...identity,
            state: "failed",
            code: "desktop_plugin_execution_setup_failed",
            policyCommitted: current.policyCommitted(claim),
          }),
        );
        throw error;
      } finally {
        holdOwnNotifications = false;
        if (owner === current) owner = null;
        const joined = current.close();
        retiring = Promise.all([retiring, joined]).then(() => undefined);
        await retiring;
      }
    }),
  );

  ipc.handle(CHANNELS[2], (event, ...args: unknown[]) => {
    guard(event)();
    if (args.length !== 1) fail("request_invalid");
    const previewId = cancelPreviewId(args[0]);
    owner?.cancelPreview({ previewId });
    if (preview?.previewId === previewId) preview = null;
    // Cancellation never withdraws an already accepted confirmation.
  });
  ipc.handle(CHANNELS[3], (event, ...args: unknown[]) => {
    const assertCurrent = guard(event);
    if (args.length !== 1) fail("request_invalid");
    const pluginId = parseDesktopLocalPluginExecutionSetupPluginId(args[0]);
    assertCurrent();
    if (
      status === null ||
      status.generation !== generation ||
      status.value.pluginId !== pluginId
    )
      return null;
    const value = status.value;
    const copy =
      value.state === "committed"
        ? Object.freeze({
            ...value,
            result: Object.freeze({ ...value.result }),
          })
        : Object.freeze({ ...value });
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
    if (!holdOwnNotifications) notify(DESKTOP_PLUGIN_EXECUTION_OWNER_CHANGED);
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
      flight?.then(
        () => undefined,
        () => undefined,
      ),
    ]).then(() => undefined);
  };
  contents.once("destroyed", () => {
    void close().catch(() =>
      input.diagnostic("desktop_plugin_execution_cleanup_failed"),
    );
  });
  return Object.freeze({ close });
}

function cancelPreviewId(input: unknown): string {
  if (
    input === null ||
    typeof input !== "object" ||
    Object.getPrototypeOf(input) !== Object.prototype
  )
    fail("request_invalid");
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
    fail("request_invalid");
  return field.value;
}
function sameRenderer(actual: string, expected: string): boolean {
  try {
    const url = new URL(actual),
      original = new URL(expected);
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
function fail(code: string): never {
  throw new Error(`desktop_plugin_execution_${code}`);
}
