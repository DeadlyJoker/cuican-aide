import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  parseGetConceptGenerationResponse,
  parseGetExtensionTaskResponse,
} from "@crewon/contracts";
import {
  PROJECT_GENERATION_QUERY_HOST_CONTEXT_VERSION,
  parseProjectGenerationQueryHostContext,
  type ProjectGenerationQueryHostContext,
} from "@crewon/contracts/plugins";
import type { ControlApiClient } from "@crewon/control-client";
import type { ControlThreadRuntime } from "../control-runtime/controlThreadRuntime";
import { AGENT_PLATFORM_SESSION_CHANGED_EVENT } from "../agent-platform/agentPlatformClient";
import type { ControlPluginUiModule } from "./controlPluginUiCatalog";
import type {
  InstalledPluginProjectQueryJournal,
  InstalledPluginProjectQueryIntent,
} from "./installedPluginProjectQueryJournal";
import {
  installedPluginTaskModulePin,
  installedPluginTaskThread,
} from "./installedPluginTaskContextSupport";
import { installedPluginTaskRequest } from "./installedPluginTaskRequests";
import { assertPluginUiCurrent } from "./controlPluginUiSupport";

export type InstalledPluginProjectQueryPorts = Readonly<{
  client: Pick<ControlApiClient, "getThread" | "getExtensionTask"> & {
    creativeProjects: Pick<
      ControlApiClient["creativeProjects"],
      "getConceptGeneration"
    >;
  };
  runtime: Pick<ControlThreadRuntime, "adoptExtensionTask">;
  journal: InstalledPluginProjectQueryJournal;
  assertSessionCurrent(): void;
  onOpenTask(threadId: string): void;
}>;
export type InstalledPluginProjectQueryContextState = Readonly<{
  context: ProjectGenerationQueryHostContext;
  error: string | null;
  refresh(): void;
  openTask(): Promise<void>;
  canOpenTask: boolean;
}>;
type Input = Readonly<{
  ports: InstalledPluginProjectQueryPorts | null;
  module: ControlPluginUiModule;
  active: boolean;
  selectedThreadId: string | null;
  /** Existing host-prepared conversation, read again before query submission. */
  preparedThreadId?: string | null;
}>;
const EMPTY = parseProjectGenerationQueryHostContext({
  version: PROJECT_GENERATION_QUERY_HOST_CONTEXT_VERSION,
  phase: "idle",
  thread: null,
  threadReady: false,
  intent: null,
});
function matches(
  module: ControlPluginUiModule,
  intent: InstalledPluginProjectQueryIntent,
): boolean {
  const descriptor = module.plugin.descriptor;
  return (
    intent.sourcePin.pluginId === descriptor.pluginId &&
    intent.sourcePin.publisherId === descriptor.publisherId &&
    intent.sourcePin.version === descriptor.version &&
    intent.sourcePin.packageDigest === module.plugin.packageDigest &&
    intent.sourcePin.selectionRevision === module.plugin.selectionRevision &&
    intent.sourcePin.contributionId === module.contributionId
  );
}
function latest(input: Input): InstalledPluginProjectQueryIntent | null {
  const values =
    input.ports?.journal
      .snapshot()
      .filter((item) => item.familyKey === input.module.key) ?? [];
  return (
    values.find(
      (item) => item.phase === "pending" || item.phase === "uncertain",
    ) ??
    values[0] ??
    null
  );
}

function checkAccount(
  ports: InstalledPluginProjectQueryPorts,
  familyKey: string,
): void {
  assertPluginUiCurrent(() => ports.assertSessionCurrent());
  // The journal itself fences invalidated account owners, including a still-captured client.
  ports.journal.getOrCreateContextOwner(familyKey, () => Object.freeze({}));
}

/** Query recovery is account-owned and separate from generation. This hook never creates or submits a task. */
export function useInstalledPluginProjectQueryContext(
  input: Input,
): InstalledPluginProjectQueryContextState {
  const enabled = input.module.plugin.descriptor.requires.some(
    (item) =>
      item.service === "crewon.project-generation-queries" &&
      item.apiVersion === "1",
  );
  const [suspended, suspend] =
    useState<InstalledPluginProjectQueryJournal | null>(null);
  const live =
    input.active &&
    enabled &&
    input.ports !== null &&
    input.ports.journal !== suspended;
  const pin = installedPluginTaskModulePin(input.module);
  const [pulse, update] = useState(0);
  const [reads, setReads] = useState<Readonly<{
    key: string;
    thread: ProjectGenerationQueryHostContext["thread"];
    error: string | null;
  }> | null>(null);
  const [openingError, setOpeningError] = useState<string | null>(null);
  const current = useRef({ input, pin, live });
  current.current = { input, pin, live };
  const lifetime = useRef<AbortController | null>(null);
  const opening = useRef<Promise<void> | null>(null);
  useLayoutEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    const invalidate = () => {
      controller.abort();
      input.ports?.journal.invalidate();
      suspend(input.ports?.journal ?? null);
      setReads(null);
      setOpeningError(null);
    };
    window.addEventListener(AGENT_PLATFORM_SESSION_CHANGED_EVENT, invalidate);
    return () => {
      controller.abort();
      if (lifetime.current === controller) lifetime.current = null;
      window.removeEventListener(
        AGENT_PLATFORM_SESSION_CHANGED_EVENT,
        invalidate,
      );
    };
  }, [input.ports, pin, live, input.selectedThreadId, input.preparedThreadId]);
  useEffect(() => {
    if (!live || !input.ports) return;
    return input.ports.journal.subscribe(() => update((value) => value + 1));
  }, [input.ports, live]);
  const intent = live ? latest(input) : null;
  const unresolved =
    intent?.phase === "pending" || intent?.phase === "uncertain";
  const destination = unresolved
    ? intent.input.threadId
    : (input.selectedThreadId ??
      input.preparedThreadId ??
      intent?.receipt?.threadId ??
      null);
  const readKey = JSON.stringify([pin, destination, pulse]);
  useEffect(() => {
    if (!live || !input.ports) return;
    const captured = current.current,
      ports = input.ports;
    const controller = new AbortController();
    const assertCurrent = () => {
      controller.signal.throwIfAborted();
      if (
        !current.current.live ||
        current.current.pin !== captured.pin ||
        current.current.input.ports !== ports ||
        current.current.input.selectedThreadId !==
          captured.input.selectedThreadId ||
        current.current.input.preparedThreadId !==
          captured.input.preparedThreadId
      )
        throw new Error("plugin_project_query_context_changed");
      checkAccount(ports, captured.input.module.key);
    };
    setReads(null);
    void (async () => {
      assertCurrent();
      const thread =
        destination === null
          ? null
          : installedPluginTaskThread(
              await installedPluginTaskRequest(
                ports.client,
                (signal) => {
                  assertCurrent();
                  return ports.client.getThread(destination, { signal });
                },
                controller.signal,
              ),
              destination,
              false,
            );
      assertCurrent();
      setReads({ key: readKey, thread, error: null });
    })().catch(() => {
      try {
        assertCurrent();
        setReads({
          key: readKey,
          thread: null,
          error: "plugin_project_query_context_unavailable",
        });
      } catch {
        /* Withdrawn account or view cannot publish. */
      }
    });
    return () => controller.abort();
  }, [
    input.ports,
    input.selectedThreadId,
    input.preparedThreadId,
    live,
    pin,
    destination,
    readKey,
  ]);
  const visible = reads?.key === readKey ? reads : null;
  const phase = !live
    ? "idle"
    : unresolved
      ? intent.phase === "pending"
        ? "loading"
        : "uncertain"
      : visible === null
        ? "loading"
        : visible.error
          ? "error"
          : "ready";
  const context = useMemo(
    () =>
      live
        ? parseProjectGenerationQueryHostContext({
            version: PROJECT_GENERATION_QUERY_HOST_CONTEXT_VERSION,
            phase,
            thread: visible?.thread ?? null,
            threadReady:
              phase === "ready" &&
              visible?.thread !== null &&
              visible?.thread !== undefined,
            intent:
              intent === null
                ? null
                : {
                    request: intent.input,
                    phase: intent.phase,
                    retryable:
                      intent.retryable && matches(input.module, intent),
                    receipt: intent.receipt,
                  },
          })
        : EMPTY,
    [live, phase, visible, intent, input.module],
  );
  const refresh = useCallback(() => {
    if (!current.current.live) return;
    try {
      checkAccount(
        current.current.input.ports!,
        current.current.input.module.key,
      );
      setOpeningError(null);
      update((value) => value + 1);
    } catch {
      /* Account withdrawal wins. */
    }
  }, []);
  const canOpenTask =
    live &&
    intent?.phase === "accepted" &&
    intent.receipt !== null &&
    matches(input.module, intent);
  const openTask = useCallback(async () => {
    if (opening.current) return opening.current;
    const captured = current.current,
      ports = captured.input.ports;
    const accepted = latest(captured.input),
      controller = lifetime.current;
    if (
      !captured.live ||
      !ports ||
      !controller ||
      accepted?.phase !== "accepted" ||
      !accepted.receipt ||
      !matches(captured.input.module, accepted)
    )
      return;
    const receipt = accepted.receipt;
    const assertCurrent = () => {
      controller.signal.throwIfAborted();
      if (
        !current.current.live ||
        current.current.pin !== captured.pin ||
        current.current.input.ports !== ports
      )
        throw new Error("plugin_project_query_context_changed");
      checkAccount(ports, captured.input.module.key);
    };
    const work = (async () => {
      assertCurrent();
      const reference = accepted.input.reference;
      const source = parseGetConceptGenerationResponse(
        await installedPluginTaskRequest(
          ports.client,
          (signal) => {
            assertCurrent();
            return ports.client.creativeProjects.getConceptGeneration(
              reference,
              { signal },
            );
          },
          controller.signal,
        ),
        reference,
      ).generation?.task;
      assertCurrent();
      if (!source) throw new Error("plugin_project_query_source_unavailable");
      const task = parseGetExtensionTaskResponse(
        await installedPluginTaskRequest(
          ports.client,
          (signal) => {
            assertCurrent();
            return ports.client.getExtensionTask(
              source.pluginId,
              receipt.runId,
              { signal },
            );
          },
          controller.signal,
        ),
        { pluginId: source.pluginId, runId: receipt.runId },
      ).task;
      assertCurrent();
      if (
        task.threadId !== receipt.threadId ||
        task.configurationRevision !== receipt.configurationRevision ||
        task.sourceRunId !== source.runId ||
        task.configurationRevision !== source.configurationRevision
      )
        throw new Error("plugin_project_query_receipt_unavailable");
      await ports.runtime.adoptExtensionTask(
        { threadId: receipt.threadId, runId: receipt.runId },
        { signal: controller.signal },
      );
      assertCurrent();
      ports.onOpenTask(receipt.threadId);
      setOpeningError(null);
    })().catch(() => {
      try {
        assertCurrent();
        setOpeningError("plugin_project_query_task_unavailable");
      } catch {
        /* Withdrawal wins. */
      }
    });
    opening.current = work;
    void work.finally(() => {
      if (opening.current === work) opening.current = null;
    });
    return work;
  }, []);
  return Object.freeze({
    context,
    error: live
      ? (openingError ??
        visible?.error ??
        (unresolved ? intent.reasonCode : null))
      : null,
    refresh,
    openTask,
    canOpenTask,
  });
}
