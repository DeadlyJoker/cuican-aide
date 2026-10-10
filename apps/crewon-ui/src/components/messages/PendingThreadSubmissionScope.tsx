import { createContext, useContext, useEffect, type ReactNode } from "react";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import {
  pendingSubmissionHasCanonicalMessage,
  visiblePendingThreadSubmissions,
  type PendingThreadSubmission,
} from "../../lib/thread/threadPendingSubmission";

type SubmissionPresentation = {
  submissions: readonly PendingThreadSubmission[];
  selectedThreadId?: string | null;
  selectionEpoch?: number;
  onPresented?: (ids: readonly string[]) => void;
};
const PendingSubmissions = createContext<SubmissionPresentation>({
  submissions: [],
});

export function PendingThreadSubmissionScope({
  submissions,
  selectedThreadId,
  selectionEpoch,
  onPresented,
  children,
}: SubmissionPresentation & { children: ReactNode }) {
  return (
    <PendingSubmissions.Provider
      value={{ submissions, selectedThreadId, selectionEpoch, onPresented }}
    >
      {children}
    </PendingSubmissions.Provider>
  );
}

/** Reconcile at the owning Transcript, never against another global projection. */
export function usePendingThreadSubmissionsPresentation(input?: {
  thread: Thread | null;
}) {
  const presentation = useContext(PendingSubmissions);
  const thread = input?.thread ?? null;
  const ownerId = thread?.id ?? presentation.selectedThreadId ?? null;
  const epoch = presentation.selectionEpoch;
  const owned = presentation.submissions.filter(
    (submission) =>
      submission.isWorkspaceCurrent() &&
      submission.threadId === ownerId &&
      (submission.threadId !== null ||
        epoch === undefined ||
        submission.selectionEpoch === epoch),
  );
  const canonicalIds =
    input === undefined
      ? []
      : owned
          .filter((submission) =>
            pendingSubmissionHasCanonicalMessage(submission, thread),
          )
          .map((submission) => submission.id);
  const canonicalKey = canonicalIds.join("|");
  useEffect(() => {
    if (canonicalIds.length) presentation.onPresented?.(canonicalIds);
  }, [presentation.onPresented, canonicalKey]);
  return input === undefined
    ? owned
    : visiblePendingThreadSubmissions(
        owned,
        thread,
        ownerId,
        epoch ?? owned[0]?.selectionEpoch ?? 0,
      );
}
