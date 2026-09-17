import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { ControlApiClient } from "@crewon/control-client";
import type { ThreadView } from "@crewon/contracts";
import type { ControlThreadRuntime } from "../../lib/control-runtime/controlThreadRuntime";
import { abortableCatalogRead } from "../../lib/control-runtime/controlCatalogRead";
import {
  controlOfficeAssociatedThread,
  findControlOfficeThread,
} from "./controlOfficeThreadLookup";
import type { Locale } from "../../lib/i18n";
import {
  controlOfficeChatErrorMessage,
  controlOfficeLiveThread,
} from "./controlOfficeChatPresentation";

type ReadSource =
  | { kind: "lookup" }
  | {
      kind: "refresh";
      threadId: string;
      priority: "action";
    }
  | {
      kind: "refresh";
      threadId: string;
      priority: "background";
      signal: AbortSignal;
    };
type Request = { controller: AbortController; promise: Promise<Thread | null> };
type Runtime = Pick<ControlThreadRuntime, "readThread"> &
  Partial<Pick<ControlThreadRuntime, "turnUpdates">>;

export async function readControlOfficeActiveGoal(
  client: Pick<ControlApiClient, "getThreadGoal">,
  threadId: string,
  options?: Parameters<ControlApiClient["getThreadGoal"]>[1],
): Promise<boolean | undefined> {
  const controller = new AbortController();
  const signal = controller.signal;
  const cancel = () => controller.abort(options?.signal?.reason);
  if (options?.signal?.aborted) cancel();
  else options?.signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error("control_office_goal_read_timeout")),
    5_000,
  );
  try {
    signal.throwIfAborted();
    const snapshot = await abortableCatalogRead(
      client.getThreadGoal(threadId, { ...options, signal }),
      signal,
    );
    signal.throwIfAborted();
    return snapshot.goal?.status === "active";
  } catch {
    // Optional metadata cannot turn an accepted send into a retryable failure.
    return undefined;
  } finally {
    clearTimeout(timeout);
    options?.signal?.removeEventListener("abort", cancel);
    controller.abort(new Error("control_office_goal_read_finished"));
  }
}

/** The room owns these reads; accepted mutations and Runtime Run streams have separate lifetimes. */
export function useControlOfficeThread({
  client,
  runtime,
  locale,
  officeId,
  officeVersionId,
  title,
  legacyTitle,
  searchTitle,
  enabled,
  submitting,
  liveThreads,
}: {
  client: Pick<
    ControlApiClient,
    "getThreadGoal" | "getThreadCatalog" | "getOfficeThread"
  >;
  runtime: Runtime;
  locale: Locale;
  officeId: string;
  officeVersionId: string;
  title: string;
  legacyTitle: string;
  searchTitle: string;
  enabled: boolean;
  submitting: boolean;
  liveThreads: readonly Thread[];
}) {
  const [thread, setThread] = useState<Thread | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [hasActiveGoal, setHasActiveGoal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unbound, setUnbound] = useState(false);
  const [legacyCandidate, setLegacyCandidate] = useState<ThreadView | null>(
    null,
  );
  const localeRef = useRef(locale);
  localeRef.current = locale;
  // Opening settings retires reads, not the known Office binding.
  const binding = useMemo(
    () => ({
      threadId: null as string | null,
      candidate: null as ThreadView | null,
    }),
    [client, runtime, officeId],
  );
  const owner = useMemo(
    () => ({ closed: true, request: null as Request | null }),
    [client, runtime, officeId, officeVersionId, enabled],
  );

  const read = useCallback(
    (source: ReadSource): Promise<Thread | null> => {
      if (owner.closed)
        return Promise.reject(
          new DOMException("Office read canceled", "AbortError"),
        );
      const backgroundSignal =
        source.kind === "refresh" && source.priority === "background"
          ? source.signal
          : undefined;
      if (backgroundSignal?.aborted)
        return Promise.reject(backgroundSignal.reason);
      // A timer must never supersede a foreground post-mutation refresh.
      if (
        source.kind === "refresh" &&
        source.priority === "background" &&
        owner.request
      )
        return abortableCatalogRead(owner.request.promise, source.signal);
      owner.request?.controller.abort();
      const controller = new AbortController(),
        signal = controller.signal;
      const request: Request = { controller, promise: Promise.resolve(null) };
      owner.request = request;
      const cancelBackground = () => controller.abort(backgroundSignal!.reason);
      backgroundSignal?.addEventListener("abort", cancelBackground, {
        once: true,
      });
      const timeout = setTimeout(
        () => controller.abort(new Error("control_office_read_timeout")),
        30_000,
      );
      const work = async () => {
        let id = source.kind === "lookup" ? binding.threadId : source.threadId;
        if (source.kind === "lookup") {
          setUnbound(false);
          binding.candidate = null;
          setLegacyCandidate(null);
          const association = await abortableCatalogRead(
            client.getOfficeThread(officeVersionId, { signal }),
            signal,
          );
          signal.throwIfAborted();
          const associated = controlOfficeAssociatedThread(association, {
            officeId,
            officeVersionId,
          });
          if (associated === null) {
            if (binding.threadId !== null)
              throw new Error("control_office_binding_missing");
            setUnbound(true);
            const candidate = await findControlOfficeThread(
              client,
              { title, legacyTitle, searchTitle },
              signal,
            );
            signal.throwIfAborted();
            binding.candidate = candidate;
            setLegacyCandidate(candidate);
            return null;
          }
          binding.candidate = null;
          setLegacyCandidate(null);
          binding.threadId = associated.threadId;
          setThreadId(associated.threadId);
          id = associated.threadId;
        }
        if (id === null) throw new Error("control_office_thread_missing");
        signal.throwIfAborted();
        // Settle each waiter on cancellation: a stalled optional Goal must not
        // keep a completed Thread body in Promise.all's result array.
        const [nextThread, activeGoal] = await Promise.all([
          abortableCatalogRead(runtime.readThread(id, { signal }), signal),
          abortableCatalogRead(
            readControlOfficeActiveGoal(client, id, { signal }),
            signal,
          ),
        ]);
        signal.throwIfAborted();
        if (nextThread.id !== id)
          throw new Error("control_office_thread_mismatch");
        return { thread: nextThread, activeGoal };
      };
      request.promise = work()
        .then((projection) => {
          signal.throwIfAborted();
          const nextThread = projection?.thread ?? null;
          binding.threadId = nextThread?.id ?? null;
          if (projection?.activeGoal !== undefined)
            setHasActiveGoal(projection.activeGoal);
          setThread(nextThread);
          setThreadId(nextThread?.id ?? null);
          setLoading(false);
          setError(null);
          return nextThread;
        })
        .catch((cause: unknown) => {
          if (
            !owner.closed &&
            owner.request === request &&
            !(
              signal.aborted &&
              cause instanceof Error &&
              cause.name === "AbortError"
            ) &&
            !(
              source.kind === "refresh" &&
              cause instanceof Error &&
              cause.message === "control_thread_projection_superseded"
            ) &&
            !(source.kind === "refresh" && source.priority === "action")
          ) {
            setLoading(false);
            setError(controlOfficeChatErrorMessage(cause, localeRef.current));
          }
          throw cause;
        })
        .finally(() => {
          clearTimeout(timeout);
          backgroundSignal?.removeEventListener("abort", cancelBackground);
          if (owner.request === request) owner.request = null;
          controller.abort(new Error("control_office_read_finished"));
        });
      return request.promise;
    },
    [
      client,
      runtime,
      title,
      legacyTitle,
      searchTitle,
      officeId,
      officeVersionId,
      owner,
      binding,
    ],
  );

  useEffect(() => {
    owner.closed = !enabled;
    if (enabled) {
      setLoading(true);
      setThread(null);
      setThreadId(binding.threadId);
      setError(null);
      setHasActiveGoal(false);
      setLegacyCandidate(null);
      setUnbound(false);
      void read({ kind: "lookup" }).catch(() => undefined);
    }
    return () => {
      owner.closed = true;
      owner.request?.controller.abort();
      owner.request = null;
    };
  }, [enabled, owner, read, binding]);

  const liveThread =
    threadId === null
      ? null
      : controlOfficeLiveThread(liveThreads, threadId, title, legacyTitle);
  const liveUpdates =
    runtime.turnUpdates === "runtime" &&
    liveThread !== null &&
    liveThread.status.type !== "notLoaded";
  const visibleStatus =
    liveThread !== null && liveThread.status.type !== "notLoaded"
      ? liveThread.status.type
      : thread?.status.type;
  useEffect(() => {
    if (
      !enabled ||
      !threadId ||
      (!submitting && visibleStatus !== "active" && !hasActiveGoal)
    )
      return;
    let stopped = false;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout>;
    const delay = liveUpdates ? 30_000 : 1_500;
    const schedule = () => {
      timeout = setTimeout(() => void refresh(), delay);
    };
    const refresh = async () => {
      try {
        await read({
          kind: "refresh",
          threadId,
          priority: "background",
          signal: controller.signal,
        });
      } catch {
        /* The read owner reports current failures. */
      } finally {
        if (!stopped) schedule();
      }
    };
    schedule();
    return () => {
      stopped = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [
    enabled,
    threadId,
    submitting,
    visibleStatus,
    hasActiveGoal,
    liveUpdates,
    read,
  ]);

  const refreshThread = useCallback(
    async (id: string) => {
      const next = await read({
        kind: "refresh",
        threadId: id,
        priority: "action",
      });
      if (next === null) throw new Error("control_office_thread_missing");
      return next;
    },
    [read],
  );
  const resolveThreadId = useCallback(async () => {
    const requireOpen = () => {
      if (owner.closed)
        throw new DOMException("Office read canceled", "AbortError");
    };
    requireOpen();
    // Recheck absence immediately before creation. A failed lookup is not an empty Office.
    if (binding.threadId === null) await read({ kind: "lookup" });
    requireOpen();
    if (binding.candidate !== null)
      throw new Error("control_office_thread_claim_required");
    return binding.threadId;
  }, [binding, owner, read]);
  const reloadAssociation = useCallback(() => read({ kind: "lookup" }), [read]);
  const bindThread = useCallback(
    (id: string | null) => {
      if (!owner.closed) {
        binding.threadId = id;
        binding.candidate = null;
        setLegacyCandidate(null);
        setUnbound(false);
        setThreadId(id);
      }
    },
    [owner, binding],
  );
  const updateError = useCallback(
    (value: string | null) => {
      if (!owner.closed) setError(value);
    },
    [owner],
  );
  return {
    thread,
    threadId,
    setThreadId: bindThread,
    liveThread,
    hasActiveGoal,
    loading,
    error,
    setError: updateError,
    refreshThread,
    resolveThreadId,
    legacyCandidate,
    unbound,
    reloadAssociation,
  };
}
