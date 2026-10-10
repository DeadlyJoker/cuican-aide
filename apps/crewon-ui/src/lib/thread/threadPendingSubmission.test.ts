import type { ControlWindowedThread } from "../control-runtime/controlTranscriptWindow";
import { describe, expect, it } from "vitest";
import { detailThread } from "./threadDetailCache.test-support";
import {
  pendingSubmissionHasCanonicalMessage,
  visiblePendingThreadSubmissions,
  type PendingThreadSubmission,
} from "./threadPendingSubmission";

function pending(): PendingThreadSubmission {
  return {
    id: "local-user",
    threadId: "one",
    turnId: "turn-one",
    baselineItemIds: [],
    baselineTurnIds: [],
    selectionEpoch: 1,
    phase: "accepted",
    error: null,
    isWorkspaceCurrent: () => true,
    item: {
      id: "local-user",
      type: "userMessage",
      clientId: null,
      content: [{ type: "text", text: "Request one", text_elements: [] }],
    },
  };
}

describe("Pending submission reconciliation", () => {
  it.each([
    { content: [] },
    { content: [{ type: "text" as const, text: "", text_elements: [] }] },
  ])(
    "retains the sent text when the accepted canonical user body is empty: $content",
    ({ content }) => {
      const submission = pending();
      const thread = detailThread("one");
      const item = thread.turns[0]!.items[0]!;
      if (item.type !== "userMessage") throw new Error("fixture");
      item.content = content;
      expect(pendingSubmissionHasCanonicalMessage(submission, thread)).toBe(
        false,
      );
      expect(
        visiblePendingThreadSubmissions([submission], thread, "one", 1),
      ).toEqual([submission]);
    },
  );

  it.each([
    { content: [] },
    { content: [{ type: "text" as const, text: "", text_elements: [] }] },
    { content: [{ type: "image" as const, url: " " }] },
  ])(
    "retains image-only input when the accepted receipt has no renderable content: $content",
    ({ content }) => {
      const submission = pending();
      submission.item.content = [
        { type: "image", url: "data:image/png;base64,test", detail: "auto" },
      ];
      const thread = detailThread("one");
      const item = thread.turns[0]!.items[0]!;
      if (item.type !== "userMessage") throw new Error("fixture");
      item.content = content;
      expect(pendingSubmissionHasCanonicalMessage(submission, thread)).toBe(
        false,
      );
      expect(
        visiblePendingThreadSubmissions([submission], thread, "one", 1),
      ).toEqual([submission]);
    },
  );

  it("accepts an image-only canonical body after the server normalizes its attachment", () => {
    const submission = pending();
    submission.item.content = [
      { type: "image", url: "data:image/png;base64,test", detail: "auto" },
    ];
    const thread = detailThread("one");
    const item = thread.turns[0]!.items[0]!;
    if (item.type !== "userMessage") throw new Error("fixture");
    item.content = [{ type: "image", url: "https://image.test/saved" }];
    expect(pendingSubmissionHasCanonicalMessage(submission, thread)).toBe(true);
  });

  it("waits for the actual transcript row to include the canonical user item", () => {
    const submission = pending();
    const thread = detailThread("one") as ControlWindowedThread;
    thread.controlTranscriptWindow = {
      cursor: null,
      olderCursor: null,
      newerCursor: null,
      threadRevision: 1,
      firstSequence: null,
      lastSequence: null,
      rows: [
        {
          kind: "run",
          runId: "turn-one",
          itemIds: [],
          firstFragment: true,
          continuation: true,
        },
      ],
    };
    expect(pendingSubmissionHasCanonicalMessage(submission, thread)).toBe(
      false,
    );
    expect(
      visiblePendingThreadSubmissions([submission], thread, "one", 1),
    ).toEqual([submission]);
    thread.controlTranscriptWindow.rows[0] = {
      kind: "run",
      runId: "turn-one",
      itemIds: ["user-one"],
      firstFragment: true,
      continuation: false,
    };
    expect(pendingSubmissionHasCanonicalMessage(submission, thread)).toBe(true);
    expect(
      visiblePendingThreadSubmissions([submission], thread, "one", 1),
    ).toEqual([]);
  });

  it("recognizes a receipt Turn that Transcript appends because the window has no Run row", () => {
    const submission = pending();
    const thread = detailThread("one") as ControlWindowedThread;
    thread.controlTranscriptWindow = {
      cursor: null,
      olderCursor: null,
      newerCursor: null,
      threadRevision: 1,
      firstSequence: null,
      lastSequence: null,
      rows: [],
    };
    expect(pendingSubmissionHasCanonicalMessage(submission, thread)).toBe(true);
  });

  it("uses the accepted Run's canonical user message even if the server normalizes attachments", () => {
    const submission = pending();
    submission.item.content.push({
      type: "image",
      url: "data:image/png;base64,test",
      detail: "auto",
    });
    expect(
      pendingSubmissionHasCanonicalMessage(submission, detailThread("one")),
    ).toBe(true);
  });

  it("does not match older content or another Run with the same text", () => {
    const submission = pending();
    submission.baselineItemIds = ["user-one"];
    expect(
      pendingSubmissionHasCanonicalMessage(submission, detailThread("one")),
    ).toBe(false);
    submission.baselineItemIds = [];
    submission.turnId = "new-turn";
    expect(
      pendingSubmissionHasCanonicalMessage(submission, detailThread("one")),
    ).toBe(false);
  });

  it("reconciles guidance semantically without depending on UI text spans or image defaults", () => {
    const submission = pending();
    submission.baselineTurnIds = ["turn-one"];
    const thread = detailThread("one");
    const item = thread.turns[0]!.items[0]!;
    if (item.type !== "userMessage") throw new Error("fixture");
    submission.item.content.push({
      type: "image",
      url: "https://image.test/one",
      detail: "auto",
    });
    item.content = [
      { type: "text", text: "Request one  ", text_elements: [] },
      { type: "image", url: "https://image.test/one" },
    ];
    expect(pendingSubmissionHasCanonicalMessage(submission, thread)).toBe(true);
  });

  it("shows no draft bubble after a new draft epoch or workspace replaces its owner", () => {
    const submission = pending();
    submission.threadId = null;
    submission.turnId = null;
    expect(
      visiblePendingThreadSubmissions([submission], null, null, 2),
    ).toEqual([]);
    submission.threadId = "one";
    submission.isWorkspaceCurrent = () => false;
    expect(
      visiblePendingThreadSubmissions(
        [submission],
        detailThread("one"),
        "one",
        1,
      ),
    ).toEqual([]);
  });
});
