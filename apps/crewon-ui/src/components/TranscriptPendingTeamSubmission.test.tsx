// @vitest-environment happy-dom
import { act, StrictMode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAppThreadState } from "../lib/app/useAppThreadState";
import type { ControlTeamProgress } from "../lib/control-runtime/controlTeamProgress";
import type { ControlWindowedThread } from "../lib/control-runtime/controlTranscriptWindow";
import {
  detailThread,
  transcriptLabels,
} from "../lib/thread/threadDetailCache.test-support";
import type { ThreadSubmissionObserver } from "../lib/thread/threadPendingSubmission";
import { PendingThreadSubmissionScope } from "./messages/PendingThreadSubmissionScope";
import { Transcript } from "./Transcript";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const question = "Compare the release options as a team";

function emptyThread(): ControlWindowedThread {
  return {
    ...detailThread("main"),
    turns: [],
    controlTranscriptWindow: {
      cursor: null,
      olderCursor: null,
      newerCursor: null,
      threadRevision: 1,
      firstSequence: null,
      lastSequence: null,
      rows: [],
    },
  };
}

describe("Team progress handoff from a local user submission", () => {
  let root: Root;
  let container: HTMLDivElement;
  let state: ReturnType<typeof useAppThreadState>;
  let setProgress: (progress: ControlTeamProgress | null) => void;
  let submission: ThreadSubmissionObserver;
  let progress: ControlTeamProgress;

  function Probe() {
    state = useAppThreadState();
    const [teamProgress, updateProgress] = useState<ControlTeamProgress | null>(
      null,
    );
    setProgress = updateProgress;
    const thread =
      state.threads.find(
        (candidate) => candidate.id === state.selectedThreadId,
      ) ?? null;
    return (
      <PendingThreadSubmissionScope
        submissions={state.pendingThreadSubmissions}
        selectedThreadId={state.selectedThreadId}
        selectionEpoch={state.selectionEpochRef.current}
        onPresented={state.acknowledgePresentedSubmissions}
      >
        <Transcript
          {...transcriptLabels}
          activeTurnId={null}
          thread={thread}
          teamProgress={teamProgress}
          locale="en"
          mode="office"
          onModeChange={() => {}}
          onStop={() => {}}
          streamingText=""
        />
      </PendingThreadSubmissionScope>
    );
  }

  function bubbles() {
    return [...container.querySelectorAll('[data-kind="userMessage"]')].filter(
      (element) => element.textContent?.includes(question),
    );
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root.render(
        <StrictMode>
          <Probe />
        </StrictMode>,
      ),
    );
    act(() => {
      state.setThreads([emptyThread()]);
      state.setSelectedThreadId("main");
    });
    act(() => {
      submission = state.beginMessageSubmission({
        text: question,
        images: [],
        thread: state.threads[0]!,
        threadId: "main",
        isWorkspaceCurrent: () => true,
      });
    });
    expect(submission.submissionId).toBeDefined();
    progress = {
      threadId: "main",
      clientSubmissionId: submission.submissionId,
      content: question,
      messageId: null,
      phase: "preparing",
      runs: [],
    };
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows the request once while preparation and accepted worker status are visible", () => {
    act(() => setProgress(progress));
    expect(bubbles()).toHaveLength(1);
    expect(container.textContent).toContain("Sending");
    expect(container.textContent).toContain("Preparing team task");
    expect(state.pendingThreadSubmissions).toHaveLength(1);
    expect(
      container.querySelector(".message-list")!.outerHTML,
    ).toMatchSnapshot();

    act(() =>
      setProgress({
        ...progress,
        phase: "working",
        messageId: "user-main",
        runs: [
          {
            runId: "worker",
            memberName: "Reviewer",
            kind: "worker",
            status: "running",
            reconnecting: false,
          },
        ],
      }),
    );
    expect(bubbles()).toHaveLength(1);
    expect(container.textContent).toContain("Reviewer");
    expect(container.textContent).toContain("Running");
    expect(state.pendingThreadSubmissions).toHaveLength(1);
  });

  it("retains pending until the canonical row can display the user, then hands off without a gap", () => {
    const canonical: ControlWindowedThread = {
      ...emptyThread(),
      turns: detailThread("main").turns.map((turn) => ({
        ...turn,
        status: "inProgress",
        items: turn.items
          .filter((item) => item.type === "userMessage")
          .map((item) => ({
            ...item,
            content: [
              { type: "text" as const, text: question, text_elements: [] },
            ],
          })),
      })),
      controlTranscriptWindow: {
        ...emptyThread().controlTranscriptWindow!,
        rows: [
          {
            kind: "run",
            runId: "turn-main",
            itemIds: [],
            firstFragment: true,
            continuation: true,
          },
        ],
      },
    };
    act(() => {
      setProgress({ ...progress, phase: "working", messageId: "user-main" });
      submission.accepted("main", "turn-main");
      state.setThreads([canonical]);
    });
    expect(bubbles()).toHaveLength(1);
    expect(state.pendingThreadSubmissions).toHaveLength(1);
    expect(
      container.querySelector("[data-pending-user-message]"),
    ).not.toBeNull();

    act(() =>
      state.setThreads([
        {
          ...canonical,
          controlTranscriptWindow: {
            ...canonical.controlTranscriptWindow!,
            rows: [
              {
                kind: "run",
                runId: "turn-main",
                itemIds: ["user-main"],
                firstFragment: true,
                continuation: false,
              },
            ],
          },
        } as ControlWindowedThread,
      ]),
    );
    expect(bubbles()).toHaveLength(1);
    expect(state.pendingThreadSubmissions).toEqual([]);
    expect(container.querySelector("[data-pending-user-message]")).toBeNull();
    expect(container.textContent).toContain("Team working");
  });

  it("keeps the request and send failure if team coordination fails or its progress is removed", () => {
    act(() => {
      setProgress({ ...progress, phase: "failed", messageId: "user-main" });
      submission.failed(new Error("Unable to start the coordinating run"));
    });
    expect(bubbles()).toHaveLength(1);
    expect(
      container.querySelector('[data-pending-user-message="failed"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain(
      "Unable to start the coordinating run",
    );
    expect(container.textContent).toContain("Team coordination interrupted");
    expect(state.pendingThreadSubmissions).toHaveLength(1);
    act(() => setProgress(null));
    expect(bubbles()).toHaveLength(1);
    expect(state.pendingThreadSubmissions).toHaveLength(1);
  });

  it.each([undefined, "another-submission"])(
    "does not suppress another submission with identical text (%s)",
    (clientSubmissionId) => {
      act(() => setProgress({ ...progress, clientSubmissionId }));
      expect(bubbles()).toHaveLength(2);
      expect(state.pendingThreadSubmissions).toHaveLength(1);
    },
  );

  it("does not render another Thread's team progress even with the same local identity", () => {
    act(() => setProgress({ ...progress, threadId: "foreign" }));
    expect(bubbles()).toHaveLength(1);
    expect(container.textContent).not.toContain("Preparing team task");
    expect(state.pendingThreadSubmissions).toHaveLength(1);
  });
});
