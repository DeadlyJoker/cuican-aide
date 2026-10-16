import { parseRunView } from "@crewon/contracts";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext, AuthorizationPort } from "./authorization-port.ts";
import type { ThreadStore } from "./thread-store-port.ts";
import { validateThreadMessageWindowQuery } from "./thread-message-window-query.ts";
import type {
  ThreadMessageWindow,
  ThreadMessageWindowPosition,
  ThreadMessageRunBinding,
} from "./thread-message-window-store-port.ts";
import { RunStoreError } from "./run-store-port.ts";

export async function readThreadTranscriptWindow(
  dependencies: {
    store: ThreadStore;
    authorization: AuthorizationPort;
    authorizeThread(threadId: string): Promise<unknown>;
  },
  actor: ActorContext,
  input: {
    threadId: string;
    position: ThreadMessageWindowPosition | null;
    limit: number;
  },
  view: "transcript" | "transcriptSnapshot" = "transcript",
): Promise<
  ThreadMessageWindow & { runBindings: readonly ThreadMessageRunBinding[] }
> {
  const query = validateThreadMessageWindowQuery(input);
  await dependencies.authorizeThread(query.threadId);
  if (view === "transcriptSnapshot") await authorizeRun(null);
  if (!dependencies.store.messageWindows)
    throw new ApplicationError("internal", "message_window_store_unavailable");
  let window: ThreadMessageWindow;
  try {
    window = await dependencies.store.messageWindows.readWindow({
      ...query,
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      view,
    });
  } catch (error) {
    if (error instanceof RunStoreError && error.code === "thread_not_found")
      throw new ApplicationError("notFound", "thread_not_found");
    if (
      error instanceof RunStoreError &&
      error.code === "thread_message_window_changed"
    )
      throw new ApplicationError("conflict", "thread_message_window_changed");
    throw new ApplicationError(
      "internal",
      "thread_transcript_window_unavailable",
      { cause: error },
    );
  }
  const bindings = window.runBindings;
  if (
    !Array.isArray(bindings) ||
    bindings.length !== window.messages.length ||
    bindings.length > query.limit ||
    window.thread.tenantId !== actor.tenantId ||
    window.thread.spaceId !== actor.spaceId ||
    window.thread.threadId !== query.threadId ||
    window.thread.status === "deleted"
  )
    throw new ApplicationError("internal", "thread_transcript_window_invalid");
  const runIds = new Set<string>();
  for (const [index, binding] of bindings.entries()) {
    const message = window.messages[index];
    if (
      !binding ||
      message?.tenantId !== actor.tenantId ||
      message.threadId !== query.threadId ||
      binding.messageId !== message.messageId ||
      (binding.source === "turnStartReceipt" && message.role !== "user") ||
      (binding.source === "messageCompletedEvent" &&
        message.role !== "assistant") ||
      !["unassociated", "turnStartReceipt", "messageCompletedEvent"].includes(
        binding.source,
      ) ||
      (binding.source === "unassociated"
        ? binding.runId !== null
        : typeof binding.runId !== "string" ||
          !binding.runId.trim() ||
          binding.runId.length > 512 ||
          /[\u0000-\u001f\u007f]/u.test(binding.runId))
    )
      throw new ApplicationError(
        "internal",
        "thread_transcript_window_invalid",
      );
    if (binding.runId !== null) runIds.add(binding.runId);
  }
  if (view === "transcriptSnapshot") {
    const snapshot = window.runSnapshot;
    if (
      !snapshot ||
      !Array.isArray(snapshot.runs) ||
      snapshot.runs.length > query.limit + 1
    )
      throw new ApplicationError(
        "internal",
        "thread_transcript_snapshot_invalid",
      );
    const expected = new Set(runIds);
    if (snapshot.activeRunId !== null) expected.add(snapshot.activeRunId);
    const actual = new Set<string>();
    for (const raw of snapshot.runs) {
      const run = parseRunView(raw, query.threadId);
      if (
        actual.has(run.runId) ||
        !expected.has(run.runId) ||
        (run.runId === snapshot.activeRunId &&
          ["completed", "failed", "canceled"].includes(run.status))
      )
        throw new ApplicationError(
          "internal",
          "thread_transcript_snapshot_invalid",
        );
      actual.add(run.runId);
      runIds.add(run.runId);
    }
    if (expected.size !== actual.size)
      throw new ApplicationError(
        "internal",
        "thread_transcript_snapshot_invalid",
      );
  }
  for (const runId of runIds) await authorizeRun(runId);
  async function authorizeRun(runId: string | null) {
    try {
      const decision = await dependencies.authorization.authorize({
        actor,
        action: "run:read",
        resource: {
          kind: "run",
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          threadId: query.threadId,
          runId,
        },
      });
      if (decision.outcome !== "allow")
        throw new ApplicationError("authorization", "authorization_denied");
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError("authorization", "authorization_unavailable", {
        cause: error,
      });
    }
  }
  return { ...window, runBindings: bindings };
}
