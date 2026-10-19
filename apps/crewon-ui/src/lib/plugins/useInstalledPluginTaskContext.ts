import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  parseExtensionRunId,
  parseGetExtensionTaskResponse,
  type ExtensionTaskView,
} from "@crewon/contracts";
import { parsePluginUiLease } from "@crewon/contracts/plugins";
import { ControlApiClientError } from "@crewon/control-client";
import { AGENT_PLATFORM_SESSION_CHANGED_EVENT } from "../agent-platform/agentPlatformClient";
import {
  installedPluginTaskRequest,
  installedPluginTaskRead,
} from "./installedPluginTaskRequests";
import {
  readInstalledPluginTaskReceipt,
  type InstalledPluginTaskReceiptEvent,
} from "./installedPluginTaskReceipt";
import {
  EMPTY_INSTALLED_PLUGIN_TASKS,
  INSTALLED_PLUGIN_TASK_CONTEXT_LIMITS,
  installedPluginTaskModulePin,
  installedPluginTaskProjection,
  installedPluginTaskReceiptForModule,
  installedPluginTaskReceiptHasCurrentPin,
  installedPluginTaskRunIds,
  installedPluginTaskSourceExists,
  installedPluginTaskThread,
  installedPluginUsesTasks,
} from "./installedPluginTaskContextSupport";
import { uiRecord } from "./pluginUiValidation";
import type {
  InstalledPluginTaskContextInput,
  InstalledPluginTaskContextState,
  InstalledPluginTaskSource,
  InstalledPluginTaskThread,
} from "./useInstalledPluginTaskContext.types";

export type * from "./useInstalledPluginTaskContext.types";

type Snapshot = Readonly<{
  phase: InstalledPluginTaskContextState["phase"];
  error: string | null;
  thread: InstalledPluginTaskThread | null;
  tasks: readonly ExtensionTaskView[];
  source: InstalledPluginTaskSource | null;
}>;
const EMPTY: Snapshot = Object.freeze({
  phase: "idle",
  error: null,
  thread: null,
  tasks: EMPTY_INSTALLED_PLUGIN_TASKS,
  source: null,
});
type CreateIntent = {
  readonly body: Readonly<{ title: null }>;
  readonly key: string;
  threadId: string | null;
};
type Owner = {
  readonly ports: NonNullable<InstalledPluginTaskContextInput["ports"]>;
  readonly module: InstalledPluginTaskContextInput["module"];
  readonly selectedThreadId: string | null;
  readonly events: Map<string, InstalledPluginTaskReceiptEvent>;
  readonly adopted: Set<string>;
  intent: CreateIntent | null;
  provisionalThreadId: string | null;
  physical: Promise<unknown> | null;
  preparing: boolean;
  generation: number;
  abort: (() => void) | null;
  requestRefresh: (() => void) | null;
};

function knownRefusal(error: unknown): boolean {
  return (
    error instanceof ControlApiClientError &&
    [400, 401, 403, 404, 409, 422].includes(error.status)
  );
}
function remember(owner: Owner, raw: InstalledPluginTaskReceiptEvent): boolean {
  try {
    const value = uiRecord(raw);
    if (
      Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, "lease") ||
      !Object.hasOwn(value, "receipt")
    )
      return false;
    const receipt = readInstalledPluginTaskReceipt(value.receipt);
    if (receipt === null) return false;
    const event = Object.freeze({
      lease: parsePluginUiLease(value.lease),
      receipt,
    });
    if (!installedPluginTaskReceiptForModule(owner.module, event)) return false;
    owner.events.delete(receipt.runId);
    owner.events.set(receipt.runId, event);
    while (owner.events.size > 8)
      owner.events.delete(owner.events.keys().next().value!);
    return true;
  } catch {
    // The registry is a read hint. Malformed events never provide task authority.
    return false;
  }
}

/** Authenticated metadata only. An open module cannot create a Thread, Run, quote or provider operation. */
export function useInstalledPluginTaskContext(
  input: InstalledPluginTaskContextInput,
): InstalledPluginTaskContextState {
  const pin = installedPluginTaskModulePin(input.module);
  const owner = useMemo<Owner | null>(
    () =>
      input.ports && installedPluginUsesTasks(input.module)
        ? {
            ports: input.ports,
            module: input.module,
            selectedThreadId: input.selectedThreadId,
            events: new Map(),
            adopted: new Set(),
            intent: null,
            provisionalThreadId: null,
            physical: null,
            preparing: false,
            generation: 0,
            abort: null,
            requestRefresh: null,
          }
        : null,
    [input.ports, pin, input.selectedThreadId],
  );
  const current = useRef({ owner, active: input.active });
  current.current = { owner, active: input.active };
  const runIds = useRef<readonly string[]>([]);
  const validRunIds = useRef(true);
  let runKey: string;
  try {
    runIds.current = installedPluginTaskRunIds(input.runIds);
    validRunIds.current = true;
    runKey = JSON.stringify(runIds.current);
  } catch {
    runIds.current = [];
    validRunIds.current = false;
    runKey = "invalid";
  }
  const requestedRunKey = useRef<{ owner: Owner; key: string } | null>(null);
  const [suspended, setSuspended] = useState<Owner | null>(null);
  const [stored, setStored] = useState<{
    owner: Owner;
    snapshot: Snapshot;
  } | null>(null);
  const stateRef = useRef<Snapshot>(EMPTY);
  const live = input.active && owner !== null && owner !== suspended;
  const snapshot = live && stored?.owner === owner ? stored.snapshot : EMPTY;
  stateRef.current = snapshot;
  const publish = useCallback((subject: Owner, next: Snapshot) => {
    if (current.current.owner !== subject || !current.current.active) return;
    subject.ports.assertSessionCurrent();
    stateRef.current = next;
    setStored({ owner: subject, snapshot: next });
  }, []);

  useLayoutEffect(() => {
    const invalidate = () => {
      current.current.active = false;
      owner?.abort?.();
      setSuspended(owner);
      stateRef.current = EMPTY;
      setStored(null);
    };
    window.addEventListener(AGENT_PLATFORM_SESSION_CHANGED_EVENT, invalidate);
    return () =>
      window.removeEventListener(
        AGENT_PLATFORM_SESSION_CHANGED_EVENT,
        invalidate,
      );
  }, [owner]);

  useEffect(() => {
    if (!owner || !live) return;
    const controller = new AbortController();
    const generation = ++owner.generation;
    owner.abort = () => controller.abort();
    let running = false,
      pending = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const assertCurrent = () => {
      controller.signal.throwIfAborted();
      if (
        current.current.owner !== owner ||
        !current.current.active ||
        owner.generation !== generation
      )
        throw new Error("plugin_task_context_changed");
      owner.ports.assertSessionCurrent();
    };
    const request = <T>(read: (signal: AbortSignal) => Promise<T>) =>
      installedPluginTaskRead(owner.ports.client, read, controller.signal);
    const read = async () => {
      assertCurrent();
      if (!validRunIds.current) throw new Error("plugin_task_context_invalid");
      const threadId = owner.selectedThreadId ?? owner.provisionalThreadId;
      let thread = threadId
        ? installedPluginTaskThread(
            await request((signal) =>
              owner.ports.client.getThread(threadId, { signal }),
            ),
            threadId,
            owner.selectedThreadId === null,
          )
        : null;
      assertCurrent();
      const candidates = [...owner.events.keys()].reverse();
      candidates.push(...runIds.current);
      if (threadId) {
        const page = await request((signal) =>
          owner.ports.client.listThreadRuns(threadId, { limit: 8 }, { signal }),
        );
        assertCurrent();
        candidates.push(
          ...page.data.map((run) => {
            if (run.threadId !== threadId)
              throw new Error("plugin_task_run_mismatch");
            return run.runId;
          }),
        );
      }
      const tasks: ExtensionTaskView[] = [];
      // Read independent task snapshots together; the shared pool bounds physical HTTP concurrency.
      // Read completion order does not reorder the checked adoption below.
      const snapshots = await Promise.all(
        [...new Set(candidates)].slice(0, 8).map(async (runId) => {
          try {
            const task = parseGetExtensionTaskResponse(
              await request((signal) =>
                owner.ports.client.getExtensionTask(
                  owner.module.plugin.descriptor.pluginId,
                  runId,
                  { signal },
                ),
              ),
              { pluginId: owner.module.plugin.descriptor.pluginId, runId },
            ).task;
            assertCurrent();
            return { runId, task };
          } catch (error) {
            assertCurrent();
            if (
              error instanceof ControlApiClientError &&
              error.status === 404 &&
              error.code === "extension_task_not_found"
            )
              return null;
            throw error;
          }
        }),
      );
      assertCurrent();
      for (const snapshot of snapshots) {
        if (!snapshot) continue;
        const { runId, task } = snapshot;
        const event = owner.events.get(runId);
        if (
          event &&
          (task.threadId !== event.receipt.threadId ||
            task.configurationRevision !== event.receipt.configurationRevision)
        )
          throw new Error("plugin_task_receipt_mismatch");
        if (!event && threadId !== null && task.threadId !== threadId)
          throw new Error("plugin_task_thread_mismatch");
        tasks.push(task);
        const receiptPin = event
          ? JSON.stringify([event.lease, event.receipt.runId])
          : "";
        if (
          event &&
          event.receipt.threadId === threadId &&
          installedPluginTaskReceiptHasCurrentPin(owner.module, event) &&
          !owner.adopted.has(receiptPin)
        ) {
          await owner.ports.runtime.adoptExtensionTask(event.receipt, {
            signal: controller.signal,
          });
          assertCurrent();
          owner.adopted.add(receiptPin);
          thread = installedPluginTaskThread(
            await request((signal) =>
              owner.ports.client.getThread(threadId!, { signal }),
            ),
            threadId!,
            owner.selectedThreadId === null,
          );
          assertCurrent();
        }
      }
      const source = installedPluginTaskSourceExists(
        tasks,
        stateRef.current.source,
      )
        ? stateRef.current.source
        : null;
      const projected = installedPluginTaskProjection(thread, tasks, source);
      if (!owner.preparing)
        publish(owner, {
          phase: owner.intent ? "uncertain" : "ready",
          error: owner.intent ? "plugin_task_thread_creation_uncertain" : null,
          thread,
          tasks: projected.tasks,
          source: projected.source,
        });
    };
    const refresh = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (running || owner.preparing) {
        pending = true;
        return;
      }
      running = true;
      try {
        publish(owner, {
          ...stateRef.current,
          phase: owner.intent ? "uncertain" : "loading",
          error: owner.intent ? "plugin_task_thread_creation_uncertain" : null,
        });
      } catch {
        running = false;
        return;
      }
      const work = (async () => {
        if (owner.physical) await owner.physical.catch(() => undefined);
        assertCurrent();
        await read();
      })();
      owner.physical = work;
      void work
        .catch(() => {
          try {
            assertCurrent();
            // Preserve this owner's verified identities so an unknown business intent keeps its original key/body.
            publish(owner, {
              ...stateRef.current,
              phase: owner.intent ? "uncertain" : "error",
              error: owner.intent
                ? "plugin_task_thread_creation_uncertain"
                : "plugin_task_context_unavailable",
            });
          } catch {
            /* A withdrawn owner cannot publish a late response. */
          }
        })
        .finally(() => {
          if (owner.physical === work) owner.physical = null;
          running = false;
          if (controller.signal.aborted) return;
          if (pending && !owner.preparing) {
            pending = false;
            refresh();
          } else
            timer = setTimeout(
              refresh,
              INSTALLED_PLUGIN_TASK_CONTEXT_LIMITS.pollMs,
            );
        });
    };
    owner.requestRefresh = refresh;
    for (const event of owner.ports.receiptSource.snapshot())
      remember(owner, event);
    const unsubscribe = owner.ports.receiptSource.subscribe((event) => {
      try {
        assertCurrent();
        if (remember(owner, event)) refresh();
      } catch {
        /* Session withdrawal wins. */
      }
    });
    try {
      publish(owner, { ...EMPTY, phase: "loading" });
    } catch {
      controller.abort();
      unsubscribe();
      return;
    }
    requestedRunKey.current = { owner, key: runKey };
    refresh();
    return () => {
      controller.abort();
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
      if (owner.generation === generation) {
        owner.abort = null;
        owner.requestRefresh = null;
      }
    };
  }, [owner, live, publish]);

  useEffect(() => {
    if (!live || !owner) return;
    if (
      requestedRunKey.current?.owner === owner &&
      requestedRunKey.current.key === runKey
    )
      return;
    requestedRunKey.current = { owner, key: runKey };
    owner.requestRefresh?.();
  }, [owner, live, runKey]);
  const refresh = useCallback(() => {
    if (live) owner?.requestRefresh?.();
  }, [owner, live]);
  const prepareThread = useCallback(() => {
    if (!live || !owner || owner.preparing) return;
    if (owner.selectedThreadId || owner.provisionalThreadId) {
      owner.requestRefresh?.();
      return;
    }
    try {
      owner.ports.assertSessionCurrent();
    } catch {
      return;
    }
    owner.intent ??= {
      body: Object.freeze({ title: null }),
      key: `plugin-thread:${crypto.randomUUID()}`,
      threadId: null,
    };
    const intent = owner.intent;
    const generation = owner.generation;
    const assertCurrent = () => {
      if (
        current.current.owner !== owner ||
        !current.current.active ||
        owner.generation !== generation
      )
        throw new Error("plugin_task_context_changed");
      owner.ports.assertSessionCurrent();
    };
    owner.preparing = true;
    publish(owner, { ...stateRef.current, phase: "preparing", error: null });
    const previous = owner.physical;
    const work = (async () => {
      if (previous) await previous.catch(() => undefined);
      assertCurrent();
      if (intent.threadId === null) {
        const result = await installedPluginTaskRequest(
          owner.ports.client,
          (signal) => {
            assertCurrent();
            return owner.ports.client.createThread(intent.body, intent.key, {
              signal,
            });
          },
        );
        const record = uiRecord(result),
          thread = uiRecord(record.thread);
        if (
          record.disposition !== "committed" &&
          record.disposition !== "replayed"
        )
          throw new Error("plugin_task_thread_response_invalid");
        intent.threadId = parseExtensionRunId(thread.threadId);
      }
      assertCurrent();
      const thread = installedPluginTaskThread(
        await installedPluginTaskRequest(owner.ports.client, (signal) => {
          assertCurrent();
          return owner.ports.client.getThread(intent.threadId!, { signal });
        }),
        intent.threadId!,
        true,
      );
      assertCurrent();
      owner.provisionalThreadId = thread.threadId;
      owner.intent = null;
      publish(owner, {
        ...stateRef.current,
        thread,
        phase: "ready",
        error: null,
      });
    })();
    owner.physical = work;
    void work
      .catch((error) => {
        try {
          assertCurrent();
          if (intent.threadId === null && knownRefusal(error))
            owner.intent = null;
          publish(owner, {
            ...EMPTY,
            phase: owner.intent ? "uncertain" : "error",
            error: owner.intent
              ? "plugin_task_thread_creation_uncertain"
              : "plugin_task_thread_creation_refused",
          });
        } catch {
          /* The known result stays with its original owner only. */
        }
      })
      .finally(() => {
        if (owner.physical === work) owner.physical = null;
        owner.preparing = false;
        if (current.current.owner === owner && current.current.active)
          owner.requestRefresh?.();
      });
  }, [owner, live, publish]);
  const selectSource = useCallback(
    (value: InstalledPluginTaskSource | null) => {
      if (!live || !owner) return;
      try {
        owner.ports.assertSessionCurrent();
        if (!installedPluginTaskSourceExists(stateRef.current.tasks, value)) {
          publish(owner, {
            ...stateRef.current,
            error: "plugin_task_source_unavailable",
          });
          return;
        }
        publish(owner, {
          ...stateRef.current,
          source: value
            ? Object.freeze({
                sourceRunId: value.sourceRunId,
                operationId: value.operationId,
              })
            : null,
          error: null,
        });
      } catch {
        /* A withdrawn session cannot select a source. */
      }
    },
    [owner, live, publish],
  );
  const projection = installedPluginTaskProjection(
    snapshot.thread,
    snapshot.tasks,
    snapshot.source,
    snapshot.phase === "ready",
  );
  return { ...snapshot, ...projection, prepareThread, refresh, selectSource };
}
