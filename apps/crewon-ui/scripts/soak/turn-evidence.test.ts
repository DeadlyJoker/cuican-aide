import { describe, expect, it, vi } from "vitest";
import { ControlApiClient } from "@crewon/control-client";
import {
  assertSoakTurnNotFailed,
  soakReadClient,
  verifySoakTurn,
} from "./turn-evidence.ts";

const fixture = () => {
  const client = new ControlApiClient({ baseUrl: "http://127.0.0.1:1" });
  const transcript = {
    schemaVersion: "crewon.transcript-window.v0" as const,
    messageWindow: {
      schemaVersion: "crewon.message-window.v0" as const,
      threadId: "thread",
      threadRevision: 3,
      eventSequence: 3,
      headMessageSequence: 2,
      olderCursor: null,
      newerCursor: null,
      data: [
        {
          messageId: "user",
          threadId: "thread",
          sequence: 1,
          role: "user" as const,
          content: "SOAK-1 Return the fixture acknowledgement.",
          proposedPlan: null,
          createdAt: "2026-09-11T00:00:00.000Z",
        },
        {
          messageId: "assistant",
          threadId: "thread",
          sequence: 2,
          role: "assistant" as const,
          content: "ACK SOAK-1\n\nfixture",
          proposedPlan: null,
          createdAt: "2026-09-11T00:00:01.000Z",
        },
      ],
    },
    runBindings: [
      { messageId: "user", runId: "run", source: "turnStartReceipt" as const },
      {
        messageId: "assistant",
        runId: "run",
        source: "messageCompletedEvent" as const,
      },
    ],
  };
  const run: Awaited<ReturnType<ControlApiClient["getRunInThread"]>>["run"] = {
    runId: "run",
    threadId: "thread",
    status: "completed",
    revision: 2,
    lastSequence: 3,
    cancelRequested: false,
    waitingApproval: null,
    collaborationMode: "default",
    purpose: "turn",
    workflowVersionBinding: null,
    goalBinding: null,
    outputRef: null,
    failure: null,
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:01.000Z",
    terminalAt: "2026-09-11T00:00:01.000Z",
  };
  vi.spyOn(client, "getThreadTranscriptWindow").mockResolvedValue(transcript);
  vi.spyOn(client, "getRunInThread").mockResolvedValue({ run });
  return { client, transcript, run };
};

describe("soak completion evidence", () => {
  it("requires the exact persisted user and assistant pair in one completed Run", async () => {
    const { client } = fixture();
    expect(await verifySoakTurn(client, "thread", "SOAK-1")).toMatchObject({
      runId: "run",
      userMessageId: "user",
      assistantMessageId: "assistant",
    });
  });
  it("rejects a user echo, duplicate assistant messages and a different marker", async () => {
    for (const mode of ["echo", "duplicate", "different"]) {
      const { client, transcript } = fixture();
      if (mode === "echo") transcript.messageWindow.data.pop();
      if (mode === "duplicate")
        transcript.messageWindow.data.push({
          ...transcript.messageWindow.data[1]!,
        });
      if (mode === "different")
        transcript.messageWindow.data[1]!.content = "ACK SOAK-10\n";
      await expect(verifySoakTurn(client, "thread", "SOAK-1")).rejects.toThrow(
        "soak_turn_messages_invalid",
      );
    }
  });
  it("rejects mismatched run bindings and a streamed answer before terminal commit", async () => {
    const first = fixture();
    first.transcript.runBindings[1]!.runId = "other";
    await expect(
      verifySoakTurn(first.client, "thread", "SOAK-1"),
    ).rejects.toThrow("soak_turn_binding_invalid");
    const second = fixture();
    second.run.status = "running";
    await expect(
      verifySoakTurn(second.client, "thread", "SOAK-1"),
    ).rejects.toThrow("soak_turn_not_completed");
  });
  it("reports the exact submitted Run failure instead of a generic renderer timeout", async () => {
    const { client, run } = fixture();
    run.status = "failed";
    run.failure = { code: "model_output_budget_exceeded", retryable: false };
    await expect(
      assertSoakTurnNotFailed(client, "thread", "SOAK-1"),
    ).rejects.toThrow("soak_product_run_failed:model_output_budget_exceeded");
    await expect(
      assertSoakTurnNotFailed(client, "thread", "SOAK-2"),
    ).resolves.toBeUndefined();
  });
  it("refuses non-loopback bootstrap endpoints", () => {
    expect(() =>
      soakReadClient({
        baseUrl: "https://example.com/",
        csrfToken: "fake",
        sessionToken: "fake",
        origin: "fake",
      }),
    ).toThrow("soak_session_origin_invalid");
    expect(() => soakReadClient(null)).toThrow("soak_session_invalid");
  });
});
