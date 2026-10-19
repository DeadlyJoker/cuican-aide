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
  parseGetConceptGenerationResponse,
} from "@crewon/contracts";
import {
  PROJECT_GENERATION_HOST_CONTEXT_VERSION,
  parseProjectGenerationHostContext,
  type ProjectGenerationHostContext,
} from "@crewon/contracts/plugins";
import { AGENT_PLATFORM_SESSION_CHANGED_EVENT } from "../agent-platform/agentPlatformClient";
import { subscribeControlThreadRevision } from "../control-runtime/controlThreadRevisionSubscriptions";
import {
  installedPluginTaskRequest,
  installedPluginTaskRead,
} from "./installedPluginTaskRequests";
import {
  installedPluginTaskModulePin,
  installedPluginTaskThread,
} from "./installedPluginTaskContextSupport";
import { copyPluginUiJson, uiRecord } from "./pluginUiValidation";
import type {
  InstalledPluginGenerationIntent,
  InstalledPluginGenerationJournal,
} from "./installedPluginGenerationJournal";
import type {
  InstalledPluginGenerationContextInput,
  InstalledPluginGenerationContextState,
  InstalledPluginGenerationPorts,
} from "./useInstalledPluginGenerationContext.types";

export type * from "./useInstalledPluginGenerationContext.types";

type Thread = NonNullable<ProjectGenerationHostContext["thread"]>;
type Preparation = {
  readonly body: Readonly<{ title: null }>;
  readonly key: string;
  phase: "pending" | "uncertain" | "accepted" | "refused";
  threadId: string | null;
  verified: boolean;
  physicallyPending: boolean;
  logicalPending: boolean;
};
type Owner = {
  readonly journal: InstalledPluginGenerationJournal;
  readonly familyKey: string;
  readonly listeners: Set<() => void>;
  creation: Preparation | null;
};
type ReadSnapshot = {
  key: string;
  phase: ProjectGenerationHostContext["phase"];
  thread: Thread | null;
  error: string | null;
};
const EMPTY = parseProjectGenerationHostContext({
  version: PROJECT_GENERATION_HOST_CONTEXT_VERSION,
  phase: "idle",
  thread: null,
  threadReady: false,
  intent: null,
});

function usesGeneration(
  module: InstalledPluginGenerationContextInput["module"],
): boolean {
  return [
    "crewon.project-generations",
    "crewon.project-generation-contexts",
  ].every((service) =>
    module.plugin.descriptor.requires.some(
      (item) => item.service === service && item.apiVersion === "1",
    ),
  );
}
function notify(owner: Owner): void {
  for (const listener of [...owner.listeners]) listener();
}
function checkAccount(
  owner: Owner,
  ports: InstalledPluginGenerationPorts,
): void {
  const checked: unknown = ports.assertSessionCurrent();
  if (checked !== undefined)
    throw new Error("plugin_generation_account_check_invalid");
  if (
    ports.journal !== owner.journal ||
    owner.journal.getOrCreatePreparationOwner(owner.familyKey, () => owner) !==
      owner
  )
    throw new Error("plugin_generation_account_changed");
}
function sourceMatches(
  input: InstalledPluginGenerationContextInput,
  intent: InstalledPluginGenerationIntent,
): boolean {
  const { descriptor } = input.module.plugin;
  return (
    intent.sourcePin.pluginId === descriptor.pluginId &&
    intent.sourcePin.publisherId === descriptor.publisherId &&
    intent.sourcePin.version === descriptor.version &&
    intent.sourcePin.packageDigest === input.module.plugin.packageDigest &&
    intent.sourcePin.selectionRevision ===
      input.module.plugin.selectionRevision &&
    intent.sourcePin.contributionId === input.module.contributionId
  );
}
function latestIntent(
  owner: Owner | null,
): InstalledPluginGenerationIntent | null {
  if (!owner) return null;
  const values = owner.journal
    .snapshot()
    .filter((value) => value.familyKey === owner.familyKey);
  return (
    values.find(
      (value) => value.phase === "pending" || value.phase === "uncertain",
    ) ??
    values[0] ??
    null
  );
}
function createdThreadId(raw: unknown): string {
  const value = uiRecord(copyPluginUiJson(raw, 16 * 1024));
  if (
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, "thread") ||
    (value.disposition !== "committed" && value.disposition !== "replayed")
  )
    throw new Error("plugin_generation_thread_response_invalid");
  const thread = uiRecord(value.thread);
  const id = parseExtensionRunId(thread.threadId);
  installedPluginTaskThread(
    { thread: value.thread, eventSequence: thread.revision } as Parameters<
      typeof installedPluginTaskThread
    >[0],
    id,
    true,
  );
  return id;
}

/** Only explicit preparation creates a Thread. Immutable generation hints never grant execution authority. */
export function useInstalledPluginGenerationContext(
  input: InstalledPluginGenerationContextInput,
): InstalledPluginGenerationContextState {
  const familyKey = input.module.key;
  const pin = installedPluginTaskModulePin(input.module);
  const owner = useMemo<Owner | null>(() => {
    if (!input.ports || !usesGeneration(input.module)) return null;
    try {
      return input.ports.journal.getOrCreatePreparationOwner<Owner>(
        familyKey,
        () => ({
          journal: input.ports!.journal,
          familyKey,
          listeners: new Set(),
          creation: null,
        }),
      );
    } catch {
      return null;
    }
  }, [input.ports?.journal, familyKey, usesGeneration(input.module)]);
  const [suspended, suspend] =
    useState<InstalledPluginGenerationJournal | null>(null);
  const [pulse, update] = useState(0);
  const [reads, setReads] = useState<ReadSnapshot | null>(null);
  const [openingError, setOpeningError] = useState<string | null>(null);
  const live =
    input.active &&
    owner !== null &&
    input.ports !== null &&
    suspended !== owner.journal;
  const current = useRef({ input, owner, live, pin });
  current.current = { input, owner, live, pin };
  const lifetime = useRef<AbortController | null>(null);
  const openWork = useRef<Promise<void> | null>(null);

  useLayoutEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    const invalidate = () => {
      controller.abort();
      owner?.journal.invalidate();
      suspend(owner?.journal ?? null);
      setReads(null);
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
  }, [owner, pin, live, input.selectedThreadId]);
  useEffect(() => {
    if (!owner || !live) return;
    const changed = () => update((value) => value + 1);
    owner.listeners.add(changed);
    const unsubscribe = owner.journal.subscribe((intent) => {
      if (intent.familyKey === owner.familyKey) changed();
    });
    return () => {
      owner.listeners.delete(changed);
      unsubscribe();
    };
  }, [owner, live]);

  const intent = live ? latestIntent(owner) : null;
  const unresolved =
    intent?.phase === "pending" || intent?.phase === "uncertain";
  const preparation = owner?.creation ?? null;
  const creationUnresolved =
    preparation !== null &&
    !preparation.verified &&
    preparation.phase !== "refused";
  const destination = unresolved
    ? intent.input.threadId
    : creationUnresolved
      ? preparation.threadId
      : (input.selectedThreadId ??
        preparation?.threadId ??
        intent?.receipt?.threadId ??
        null);
  const readKey = JSON.stringify([
    pin,
    input.selectedThreadId,
    destination,
    pulse,
  ]);

  useEffect(() => {
    if (!live || !input.ports || !destination) return;
    return subscribeControlThreadRevision(
      input.ports.runtime,
      destination,
      () => {
        setReads(null);
        update((value) => value + 1);
      },
    );
  }, [live, input.ports, destination]);

  useEffect(() => {
    if (!owner || !live || !input.ports) return;
    const ports = input.ports;
    const controller = new AbortController();
    const assertCurrent = () => {
      controller.signal.throwIfAborted();
      if (
        !current.current.live ||
        current.current.owner !== owner ||
        current.current.pin !== pin ||
        current.current.input.ports !== ports ||
        current.current.input.selectedThreadId !== input.selectedThreadId
      )
        throw new Error("plugin_generation_context_changed");
      checkAccount(owner, ports);
    };
    setReads({ key: readKey, phase: "loading", thread: null, error: null });
    void (async () => {
      assertCurrent();
      const thread =
        destination === null
          ? null
          : installedPluginTaskThread(
              await installedPluginTaskRead(
                ports.client,
                (signal) => {
                  assertCurrent();
                  return ports.client.getThread(destination, { signal });
                },
                controller.signal,
              ),
              destination,
              preparation?.threadId === destination &&
                input.selectedThreadId !== destination,
            );
      assertCurrent();
      if (thread && owner.creation?.threadId === thread.threadId)
        owner.creation.verified = true;
      setReads({ key: readKey, phase: "ready", thread, error: null });
    })().catch(() => {
      try {
        assertCurrent();
        setReads({
          key: readKey,
          phase: "error",
          thread: null,
          error: creationUnresolved
            ? "plugin_generation_thread_creation_uncertain"
            : "plugin_generation_context_unavailable",
        });
      } catch {
        /* Withdrawn views cannot publish a late read. */
      }
    });
    return () => controller.abort();
  }, [
    owner,
    live,
    pin,
    input.ports,
    input.selectedThreadId,
    destination,
    readKey,
  ]);

  const refresh = useCallback(() => {
    if (!current.current.live) return;
    try {
      checkAccount(current.current.owner!, current.current.input.ports!);
      setOpeningError(null);
      update((value) => value + 1);
    } catch {
      /* Account withdrawal wins. */
    }
  }, []);
  const prepareThread = useCallback(() => {
    const captured = current.current;
    const ports = captured.input.ports;
    const controller = lifetime.current;
    if (!captured.live || !captured.owner || !ports || !controller) return;
    const subject = captured.owner;
    if (
      latestIntent(subject)?.phase === "pending" ||
      latestIntent(subject)?.phase === "uncertain"
    )
      return;
    try {
      checkAccount(subject, ports);
    } catch {
      return;
    }
    if (
      subject.creation?.threadId ||
      (!subject.creation && captured.input.selectedThreadId)
    ) {
      refresh();
      return;
    }
    subject.creation ??= {
      body: Object.freeze({ title: null }),
      key: `plugin-generation-thread:${crypto.randomUUID()}`,
      phase: "pending",
      threadId: null,
      verified: false,
      physicallyPending: false,
      logicalPending: false,
    };
    const creation = subject.creation;
    if (creation.logicalPending || creation.physicallyPending) return;
    creation.logicalPending = true;
    creation.phase = "pending";
    notify(subject);
    const assertCurrent = () => {
      controller.signal.throwIfAborted();
      if (
        !current.current.live ||
        current.current.owner !== subject ||
        current.current.pin !== captured.pin ||
        current.current.input.ports !== ports ||
        current.current.input.selectedThreadId !==
          captured.input.selectedThreadId
      )
        throw new Error("plugin_generation_context_changed");
      checkAccount(subject, ports);
    };
    let sent = false;
    const work = installedPluginTaskRequest(
      ports.client,
      (signal) => {
        assertCurrent();
        const physical = Promise.resolve().then(() => {
          assertCurrent();
          signal.throwIfAborted();
          sent = true;
          creation.physicallyPending = true;
          return ports.client.createThread(creation.body, creation.key, {
            signal,
          });
        });
        // Observe the actual port result, independently of logical timeout or module lifetime.
        return physical
          .then((raw) => {
            checkAccount(subject, ports);
            const id = createdThreadId(raw);
            if (creation.threadId !== null && creation.threadId !== id)
              throw new Error("plugin_generation_thread_receipt_mismatch");
            creation.threadId = id;
            creation.phase = "accepted";
            notify(subject);
            return raw;
          })
          .finally(() => {
            creation.physicallyPending = false;
            notify(subject);
          });
      },
      controller.signal,
    );
    void work
      .catch(() => {
        try {
          checkAccount(subject, ports);
          if (creation.phase !== "accepted")
            creation.phase = sent ? "uncertain" : "refused";
          notify(subject);
        } catch {
          /* Account-owned holders are never restored after invalidation. */
        }
      })
      .finally(() => {
        creation.logicalPending = false;
        notify(subject);
      });
  }, [refresh]);

  const visibleRead = live && reads?.key === readKey ? reads : null;
  const phase: ProjectGenerationHostContext["phase"] = !live
    ? "idle"
    : unresolved
      ? intent.phase === "pending"
        ? "preparing"
        : "uncertain"
      : preparation && !preparation.verified
        ? preparation.phase === "pending"
          ? "preparing"
          : preparation.phase === "refused"
            ? "error"
            : preparation.phase === "uncertain" ||
                visibleRead?.phase === "error"
              ? "uncertain"
              : (visibleRead?.phase ?? "loading")
        : (visibleRead?.phase ?? "loading");
  const thread = unresolved
    ? Object.freeze({
        threadId: intent.input.threadId,
        revision: intent.input.expectedThreadRevision,
        provisional: preparation?.threadId === intent.input.threadId,
      })
    : (visibleRead?.thread ?? null);
  const hostIntent =
    intent === null
      ? null
      : {
          request: intent.input,
          phase: intent.phase,
          retryable:
            intent.phase === "uncertain" &&
            intent.retryable &&
            sourceMatches(input, intent),
          receipt: intent.receipt,
        };
  const context = useMemo(
    () =>
      live
        ? parseProjectGenerationHostContext({
            version: PROJECT_GENERATION_HOST_CONTEXT_VERSION,
            phase,
            thread,
            threadReady: phase === "ready" && thread !== null && !unresolved,
            intent: hostIntent,
          })
        : EMPTY,
    [live, phase, thread, intent, input.module],
  );
  const canOpenTask =
    live && intent?.phase === "accepted" && intent.receipt !== null;
  const openTask = useCallback(async () => {
    if (openWork.current) return openWork.current;
    const captured = current.current,
      subject = captured.owner,
      ports = captured.input.ports;
    const accepted = subject ? latestIntent(subject) : null;
    const controller = lifetime.current;
    if (
      !captured.live ||
      !subject ||
      !ports ||
      !controller ||
      accepted?.phase !== "accepted" ||
      !accepted.receipt
    )
      return;
    const receipt = accepted.receipt;
    const assertCurrent = () => {
      controller.signal.throwIfAborted();
      if (
        !current.current.live ||
        current.current.owner !== subject ||
        current.current.pin !== captured.pin ||
        current.current.input.ports !== ports
      )
        throw new Error("plugin_generation_context_changed");
      checkAccount(subject, ports);
    };
    const work = (async () => {
      assertCurrent();
      const { projectId, assetId, assetRevision } = accepted.input.reference;
      const locator = { projectId, assetId, assetRevision };
      const result = parseGetConceptGenerationResponse(
        await installedPluginTaskRead(
          ports.client,
          (signal) => {
            assertCurrent();
            return ports.client.creativeProjects.getConceptGeneration(locator, {
              signal,
            });
          },
          controller.signal,
        ),
        locator,
      );
      assertCurrent();
      const task = result.generation?.task;
      if (
        !task ||
        task.runId !== receipt.runId ||
        task.threadId !== receipt.threadId ||
        task.configurationRevision !== receipt.configurationRevision
      )
        throw new Error("plugin_generation_receipt_unavailable");
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
        setOpeningError("plugin_generation_task_unavailable");
      } catch {
        /* Do not navigate a withdrawn module. */
      }
    });
    openWork.current = work;
    void work.finally(() => {
      if (openWork.current === work) openWork.current = null;
    });
    return work;
  }, []);
  return Object.freeze({
    context,
    error: live
      ? (openingError ??
        (unresolved && intent.phase === "uncertain"
          ? (intent.reasonCode ?? "plugin_generation_result_unknown")
          : creationUnresolved && phase === "uncertain"
            ? "plugin_generation_thread_creation_uncertain"
            : (visibleRead?.error ??
              (phase === "error"
                ? "plugin_generation_thread_creation_refused"
                : null))))
      : null,
    prepareThread,
    refresh,
    openTask,
    canOpenTask,
  });
}
