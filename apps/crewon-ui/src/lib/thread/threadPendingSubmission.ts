import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { ThreadItem } from "@crewon/app-server-protocol/v2/ThreadItem";
import { transcriptWindow } from "../control-runtime/controlTranscriptWindow";
import type { ComposerImageInput } from "../shared/composerImages";

export type PendingThreadSubmission = {
  id: string;
  threadId: string | null;
  turnId: string | null;
  item: Extract<ThreadItem, { type: "userMessage" }>;
  baselineItemIds: readonly string[];
  baselineTurnIds: readonly string[];
  selectionEpoch: number;
  isWorkspaceCurrent: () => boolean;
  phase: "sending" | "accepted" | "failed";
  error: string | null;
};

/** Local UI handoff identity; never sent to the server or model. */
export type ThreadTurnPresentation = Readonly<{ submissionId: string }>;

export type ThreadSubmissionObserver = {
  readonly submissionId?: string;
  bindThread: (threadId: string) => void;
  accepted: (threadId: string, turnId: string | null) => void;
  failed: (error: unknown) => void;
};

export type BeginThreadSubmission = (input: {
  text: string;
  images: ComposerImageInput[];
  thread: Thread | null;
  threadId: string | null;
  isWorkspaceCurrent: () => boolean;
}) => ThreadSubmissionObserver;

export function pendingSubmissionHasCanonicalMessage(
  pending: PendingThreadSubmission,
  thread: Thread | null | undefined,
): boolean {
  if (!thread || thread.id !== pending.threadId) return false;
  const userText = (item: PendingThreadSubmission["item"]) =>
    item.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
  const imageUrls = (item: PendingThreadSubmission["item"]) =>
    item.content
      .filter((part) => part.type === "image")
      .map((part) => part.url);
  const hasRenderableContent = (item: PendingThreadSubmission["item"]) =>
    userText(item).length > 0 ||
    item.content.some(
      (part) =>
        (part.type === "image" && part.url.trim().length > 0) ||
        (part.type === "localImage" && part.path.trim().length > 0),
    );
  const window = transcriptWindow(thread);
  return thread.turns.some(
    (turn) =>
      (pending.turnId === null || turn.id === pending.turnId) &&
      turn.items.some(
        (item) =>
          item.type === "userMessage" &&
          hasRenderableContent(item) &&
          !pending.baselineItemIds.includes(item.id) &&
          // Transcript appends Turns missing from the window, but an existing
          // Run row renders only its itemIds. A receipt alone is not visibility.
          (!window?.rows.some(
            (row) => row.kind === "run" && row.runId === turn.id,
          ) ||
            window.rows.some(
              (row) =>
                row.kind === "run" &&
                row.runId === turn.id &&
                row.itemIds.includes(item.id),
            )) &&
          ((pending.phase === "accepted" &&
            pending.turnId === turn.id &&
            !pending.baselineTurnIds.includes(turn.id) &&
            // Run identity acknowledges delivery, not that its body arrived.
            // Attachments may normalize, but the displayed user text must agree.
            userText(item) === userText(pending.item)) ||
            (userText(item) === userText(pending.item) &&
              JSON.stringify(imageUrls(item)) ===
                JSON.stringify(imageUrls(pending.item)))),
      ),
  );
}

export function visiblePendingThreadSubmissions(
  pending: readonly PendingThreadSubmission[],
  thread: Thread | null,
  selectedThreadId: string | null,
  selectionEpoch: number,
): PendingThreadSubmission[] {
  return pending.filter(
    (submission) =>
      submission.isWorkspaceCurrent() &&
      submission.threadId === selectedThreadId &&
      (submission.threadId !== null ||
        submission.selectionEpoch === selectionEpoch) &&
      !pendingSubmissionHasCanonicalMessage(submission, thread),
  );
}
