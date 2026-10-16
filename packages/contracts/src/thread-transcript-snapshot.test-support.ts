/** Test-only public projection fixture; never imported by product code. */
export function transcriptSnapshotFixture() {
  return {
    schemaVersion: "crewon.transcript-snapshot.v0",
    transcriptWindow: {
      schemaVersion: "crewon.transcript-window.v0",
      messageWindow: {
        schemaVersion: "crewon.message-window.v0",
        threadId: "thread-1",
        threadRevision: 2,
        eventSequence: 2,
        headMessageSequence: 1,
        olderCursor: null,
        newerCursor: null,
        data: [
          {
            messageId: "message-1",
            threadId: "thread-1",
            sequence: 1,
            role: "user",
            content: "source",
            proposedPlan: null,
            createdAt: "2026-09-11T00:00:00Z",
          },
        ],
      },
      runBindings: [
        { messageId: "message-1", runId: "run-1", source: "turnStartReceipt" },
      ],
    },
    activeRunId: "run-1" as string | null,
    runs: [
      {
        runId: "run-1",
        threadId: "thread-1",
        status: "queued",
        revision: 1,
        lastSequence: 1,
        cancelRequested: false,
        waitingApproval: null,
        collaborationMode: "default",
        purpose: "turn",
        workflowVersionBinding: null,
        goalBinding: null,
        outputRef: null,
        failure: null,
        createdAt: "2026-09-11T00:00:00Z",
        updatedAt: "2026-09-11T00:00:00Z",
        terminalAt: null as string | null,
      },
    ],
  };
}
