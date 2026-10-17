import { describe, expect, it, vi } from "vitest";
import type { WorkflowRunSnapshotResponse } from "@crewon/contracts";
import {
  ControlWorkflowCommands,
  WorkflowCommandUnconfirmedError,
  type ControlWorkflowCommandsClient,
} from "./controlWorkflowCommands";
import { ControlWorkflowIntentJournal } from "./controlWorkflowIntentJournal";
import {
  workflowIntentMemoryStorage,
  workflowCommandsSnapshotFixture as workflowRunReadFixture,
  workflowCommandsReviewFixture as workflowGateReviewFixture,
} from "./controlWorkflowCommands.test-support";

const contextId = `sha256:${"a".repeat(64)}`;
const changedContext = `sha256:${"b".repeat(64)}`;
const body = () => ({
  workflowVersionId: "version-1",
  threadId: "thread-1",
  input: { topic: "  原输入\n" },
});
function fixture() {
  const storage = workflowIntentMemoryStorage();
  let nextId = 0;
  const journal = () =>
    new ControlWorkflowIntentJournal({
      storage: () => storage,
      nextId: () => `intent-${++nextId}`,
    });
  const client = {
    getWorkflowExecutionCapability: vi.fn(async () => ({
      version: "v1" as const,
      admission: true,
      snapshots: true,
      humanGates: true,
    })),
    getWorkflowRecoveryContext: vi.fn(async () => ({
      version: "v1" as const,
      contextId: contextId as string | null,
    })),
    getWorkflowReviewCapability: vi.fn(async () => ({
      version: "v1" as const,
      available: true,
    })),
    getWorkflowReviewContextCapability: vi.fn(async () => ({
      version: "v1" as const,
      available: true,
    })),
    startWorkflowRun: vi.fn<ControlWorkflowCommandsClient["startWorkflowRun"]>(
      async () => ({
        disposition: "committed",
        run: workflowRunReadFixture().run,
      }),
    ),
    cancelRun: vi.fn<ControlWorkflowCommandsClient["cancelRun"]>(async () => ({
      disposition: "committed",
      run: {
        ...workflowRunReadFixture().run,
        revision: 2,
        lastSequence: 2,
        cancelRequested: true,
      },
    })),
    reviewWorkflowHumanGate: vi.fn<
      ControlWorkflowCommandsClient["reviewWorkflowHumanGate"]
    >(async (_locator, request) => {
      const review = workflowGateReviewFixture(request.comment).review!;
      return {
        disposition: "committed",
        review: {
          ...review,
          decision: { ...review.decision, outcome: request.decision },
        },
      };
    }),
  };
  const reopen = () =>
    new ControlWorkflowCommands({ client, journal: journal() });
  return { storage, journal, client, reopen };
}
const review = (snapshot = workflowRunReadFixture()) => ({
  snapshot,
  nodeId: "gate",
  decision: "approved" as const,
  comment: "  同意\n保持原文  ",
  commentContext: "descendants-v1" as "descendants-v1" | "auditOnly",
});

describe("durable Workflow user commands", () => {
  it("refuses to rebind a displayed definition to another recovery context before creating an intent or dispatching", async () => {
    const f = fixture();
    await expect(
      f.reopen().start(body(), { expectedRecoveryContext: changedContext }),
    ).rejects.toThrow("workflow_recovery_context_changed");
    expect(f.client.startWorkflowRun).not.toHaveBeenCalled();
    expect(f.storage.length).toBe(0);
  });
  it("captures the displayed context once and keeps the frontend comparison option out of the SDK mutation", async () => {
    const f = fixture();
    let reads = 0;
    const read = vi.fn(() => (++reads === 1 ? contextId : changedContext));
    const options = Object.defineProperty({}, "expectedRecoveryContext", {
      enumerable: true,
      get: read,
    });
    await f.reopen().start(body(), options);
    expect(read).toHaveBeenCalledOnce();
    expect(f.client.startWorkflowRun.mock.calls[0]?.[2]).toEqual({
      workflowRecoveryContext: contextId,
    });
  });
  it("persists the complete intent before guarded submission and acknowledges only a bound Workflow Run", async () => {
    const f = fixture(),
      source = body();
    f.client.startWorkflowRun.mockImplementation(
      async (request, key, options) => {
        expect(f.journal().get(key).command).toEqual({
          kind: "start",
          body: request,
        });
        expect(options?.workflowRecoveryContext).toBe(contextId);
        return { disposition: "committed", run: workflowRunReadFixture().run };
      },
    );
    const pending = f.reopen().start(source);
    source.input.topic = "later edit";
    const result = await pending;
    expect(result.kind).toBe("start");
    expect(result.journal).toBe("acknowledged");
    expect(result.intent.command).toEqual({ kind: "start", body: body() });
    expect(f.storage.length).toBe(0);
    expect(f.client.startWorkflowRun).toHaveBeenCalledOnce();
    expect(f.client.cancelRun).not.toHaveBeenCalled();
    expect(f.client.reviewWorkflowHumanGate).not.toHaveBeenCalled();
  });

  it("does not replay on discovery; after reopen an explicit recovery retains the original body, key and binding", async () => {
    const f = fixture();
    f.client.startWorkflowRun.mockRejectedValueOnce(
      new Error("response lost after commit"),
    );
    await expect(f.reopen().start(body())).rejects.toMatchObject({
      intentId: "intent-1",
    });
    const reopened = f.reopen();
    const state = await reopened.readAvailability();
    expect(state.pending).toHaveLength(1);
    expect(f.client.startWorkflowRun).toHaveBeenCalledTimes(1);
    await expect(
      reopened.start({
        ...body(),
        input: { topic: "new input must not replace original" },
      }),
    ).rejects.toThrow("workflow_command_pending_recovery");
    f.client.startWorkflowRun.mockResolvedValueOnce({
      disposition: "replayed",
      run: workflowRunReadFixture().run,
    });
    const result = await reopened.recover(state.pending[0]!.id);
    expect(result.kind === "start" && result.response.disposition).toBe(
      "replayed",
    );
    expect(f.client.startWorkflowRun.mock.calls[1]).toEqual(
      f.client.startWorkflowRun.mock.calls[0],
    );
    expect(f.storage.length).toBe(0);
  });

  it("rechecks pending storage after capability awaits so concurrent clicks do not allocate new keys", async () => {
    const f = fixture();
    f.client.startWorkflowRun.mockRejectedValue(new Error("unknown"));
    const results = await Promise.allSettled([
      f.reopen().start(body()),
      f.reopen().start(body()),
    ]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(f.client.startWorkflowRun).toHaveBeenCalledOnce();
    expect(f.journal().list(contextId)).toHaveLength(1);
  });

  it("refuses changed identity/configuration without overwriting or replaying the original intent", async () => {
    const f = fixture();
    f.client.startWorkflowRun.mockRejectedValueOnce(Error("lost"));
    await expect(f.reopen().start(body())).rejects.toBeInstanceOf(
      WorkflowCommandUnconfirmedError,
    );
    const original = f.journal().get("intent-1");
    f.client.getWorkflowRecoveryContext.mockResolvedValue({
      version: "v1",
      contextId: changedContext,
    });
    expect((await f.reopen().readAvailability()).pending).toEqual([]);
    await expect(f.reopen().recover(original.id)).rejects.toThrow(
      "workflow_recovery_context_changed",
    );
    expect(f.client.startWorkflowRun).toHaveBeenCalledOnce();
    expect(f.journal().get(original.id)).toEqual(original);
    f.client.getWorkflowRecoveryContext.mockResolvedValue({
      version: "v1",
      contextId,
    });
    await f.reopen().recover(original.id);
    expect(f.client.startWorkflowRun.mock.calls[1]?.[1]).toBe(original.id);
  });

  it.each([
    "wrongThread",
    "wrongVersion",
    "turnPurpose",
    "badDisposition",
  ] as const)(
    "retains intent on a malformed or unrelated acknowledgement: %s",
    async (invalid) => {
      const f = fixture(),
        run = workflowRunReadFixture().run;
      const response = { disposition: "committed" as const, run };
      if (invalid === "wrongThread") run.threadId = "another-thread";
      if (invalid === "wrongVersion")
        run.workflowVersionBinding!.workflowVersionId = "another-version";
      if (invalid === "turnPurpose") {
        run.purpose = "turn";
        run.workflowVersionBinding = null;
      }
      if (invalid === "badDisposition")
        Object.assign(response, { disposition: "accepted" });
      f.client.startWorkflowRun.mockResolvedValue(response);
      await expect(f.reopen().start(body())).rejects.toMatchObject({
        intentId: "intent-1",
      });
      expect(f.journal().get("intent-1").command).toEqual({
        kind: "start",
        body: body(),
      });
    },
  );

  it("does not dispatch when storage is denied, and does not silently fall back when durable support is absent", async () => {
    const f = fixture();
    const unavailable = new ControlWorkflowCommands({
      client: f.client,
      journal: new ControlWorkflowIntentJournal({
        storage() {
          throw Error("denied");
        },
      }),
    });
    await expect(unavailable.start(body())).rejects.toThrow(
      "workflow_intent_storage_unavailable",
    );
    f.client.getWorkflowRecoveryContext.mockResolvedValue({
      version: "v1",
      contextId: null,
    });
    await expect(f.reopen().start(body())).rejects.toThrow(
      "workflow_durable_execution_unavailable",
    );
    expect(f.client.startWorkflowRun).not.toHaveBeenCalled();
    expect(f.storage.length).toBe(0);
  });

  it("keeps a late accepted response recoverable after its source signal is aborted", async () => {
    const f = fixture(),
      source = new AbortController();
    f.client.startWorkflowRun.mockImplementation(async () => {
      source.abort();
      return { disposition: "committed", run: workflowRunReadFixture().run };
    });
    await expect(
      f.reopen().start(body(), { signal: source.signal }),
    ).rejects.toMatchObject({ intentId: "intent-1" });
    expect(f.journal().get("intent-1").command).toEqual({
      kind: "start",
      body: body(),
    });
  });

  it("cancellation sends the captured root revision and preserves the actual nonterminal status", async () => {
    const f = fixture(),
      snapshot = workflowRunReadFixture();
    f.client.cancelRun.mockRejectedValueOnce(Error("cancel response lost"));
    await expect(f.reopen().cancel(snapshot)).rejects.toMatchObject({
      intentId: "intent-1",
    });
    snapshot.run.revision = snapshot.run.lastSequence = 7;
    const result = await f.reopen().recover("intent-1");
    expect(result.kind === "cancel" && result.response.run.status).toBe(
      "queued",
    );
    expect(
      result.kind === "cancel" && result.response.run.cancelRequested,
    ).toBe(true);
    expect(f.client.cancelRun.mock.calls[0]?.[1]).toEqual({
      expectedRevision: 1,
    });
    expect(f.client.cancelRun.mock.calls[1]).toEqual(
      f.client.cancelRun.mock.calls[0],
    );
    expect(f.client.startWorkflowRun).not.toHaveBeenCalled();
  });

  it("allows explicit cancellation of a known root while review is unknown and preserves that review intent", async () => {
    const f = fixture();
    f.client.reviewWorkflowHumanGate.mockRejectedValueOnce(
      Error("review outcome unknown"),
    );
    await expect(f.reopen().review(review())).rejects.toMatchObject({
      intentId: "intent-1",
    });
    const original = f.journal().get("intent-1");
    const result = await f.reopen().cancel(workflowRunReadFixture());
    expect(result.kind).toBe("cancel");
    expect(f.journal().get(original.id)).toEqual(original);
    expect(f.storage.length).toBe(1);
    const alreadyStopping = workflowRunReadFixture();
    alreadyStopping.run.cancelRequested = true;
    await expect(f.reopen().cancel(alreadyStopping)).rejects.toThrow(
      "workflow_cancel_already_requested",
    );
    expect(f.client.cancelRun).toHaveBeenCalledOnce();
  });

  it.each(["wrongRoot", "notRequested"] as const)(
    "does not acknowledge an unrelated or ineffective cancel response: %s",
    async (invalid) => {
      const f = fixture(),
        snapshot = workflowRunReadFixture();
      const run = {
        ...snapshot.run,
        revision: 2,
        lastSequence: 2,
        cancelRequested: true,
      };
      if (invalid === "wrongRoot") run.runId = "different-root";
      if (invalid === "notRequested") run.cancelRequested = false;
      f.client.cancelRun.mockResolvedValue({ disposition: "committed", run });
      await expect(f.reopen().cancel(snapshot)).rejects.toMatchObject({
        intentId: "intent-1",
      });
      expect(f.journal().get("intent-1").command).toEqual({
        kind: "cancel",
        runId: snapshot.run.runId,
        body: { expectedRevision: snapshot.run.revision },
      });
    },
  );

  it("preserves a stale unknown cancel while allowing a new explicit stop at a newer observed revision", async () => {
    const f = fixture(),
      snapshot = workflowRunReadFixture();
    snapshot.run.revision = snapshot.run.lastSequence = 3;
    f.client.cancelRun.mockRejectedValueOnce(Error("409 revision conflict"));
    await expect(f.reopen().cancel(snapshot)).rejects.toMatchObject({
      intentId: "intent-1",
    });
    await expect(f.reopen().cancel(snapshot)).rejects.toThrow(
      "workflow_command_pending_recovery",
    );
    snapshot.run.revision = snapshot.run.lastSequence = 2;
    await expect(f.reopen().cancel(snapshot)).rejects.toThrow(
      "workflow_command_pending_recovery",
    );
    snapshot.run.revision = snapshot.run.lastSequence = 4;
    f.client.cancelRun.mockResolvedValue({
      disposition: "committed",
      run: {
        ...snapshot.run,
        revision: 5,
        lastSequence: 5,
        cancelRequested: true,
      },
    });
    const result = await f.reopen().cancel(snapshot);
    expect(result.intent.id).toBe("intent-2");
    expect(result.intent.command).toEqual({
      kind: "cancel",
      runId: snapshot.run.runId,
      body: { expectedRevision: 4 },
    });
    expect(f.journal().get("intent-1").command).toEqual({
      kind: "cancel",
      runId: snapshot.run.runId,
      body: { expectedRevision: 3 },
    });
  });

  it.each(["auditOnly", "descendants-v1"] as const)(
    "replays the exact Gate, UTF-8 comment, digest and %s mode after unknown review",
    async (commentContext) => {
      const f = fixture(),
        input = { ...review(), commentContext };
      f.client.reviewWorkflowHumanGate.mockRejectedValueOnce(
        Error("review response lost"),
      );
      await expect(f.reopen().review(input)).rejects.toMatchObject({
        intentId: "intent-1",
      });
      input.comment = "new text";
      input.snapshot.nodes[0]!.gate!.gateRequestId = "new-gate";
      const result = await f.reopen().recover("intent-1");
      expect(result.kind).toBe("review");
      expect(f.client.reviewWorkflowHumanGate.mock.calls[1]).toEqual(
        f.client.reviewWorkflowHumanGate.mock.calls[0],
      );
      const request = f.client.reviewWorkflowHumanGate.mock.calls[0]?.[1];
      expect(request?.comment).toBe("  同意\n保持原文  ");
      expect(Object.hasOwn(request!, "commentContext")).toBe(
        commentContext === "descendants-v1",
      );
      expect(
        f.client.reviewWorkflowHumanGate.mock.calls[0]?.[0].gateRequestId,
      ).toBe("request-1");
    },
  );

  it("requires explicit descendant-context support and validates comment bytes before any write", async () => {
    const f = fixture();
    f.client.getWorkflowReviewContextCapability.mockResolvedValue({
      version: "v1",
      available: false,
    });
    await expect(f.reopen().review(review())).rejects.toThrow(
      "workflow_review_context_unavailable",
    );
    await expect(
      f.reopen().review({ ...review(), comment: "中".repeat(1366) }),
    ).rejects.toThrow("workflow_review_invalid");
    expect(f.client.reviewWorkflowHumanGate).not.toHaveBeenCalled();
    expect(f.storage.length).toBe(0);
  });

  it("rejects terminal roots, a non-waiting Gate, and a wrong review binding without acknowledgement", async () => {
    const f = fixture(),
      snapshot: WorkflowRunSnapshotResponse = workflowRunReadFixture();
    snapshot.run.status = "canceled";
    snapshot.run.terminalAt = snapshot.run.updatedAt;
    snapshot.execution!.status = "canceled";
    snapshot.execution!.cancelRequested = true;
    snapshot.run.cancelRequested = true;
    snapshot.nodes[0]!.status = "canceled";
    await expect(f.reopen().cancel(snapshot)).rejects.toThrow(
      "workflow_run_already_terminal",
    );
    await expect(
      f.reopen().review({ ...review(), nodeId: "missing" }),
    ).rejects.toThrow("workflow_gate_not_waiting");
    f.client.reviewWorkflowHumanGate.mockImplementation(async () => {
      const result = workflowGateReviewFixture();
      result.review!.decision.authority.binding.workflowVersionId =
        "another-version";
      return { disposition: "committed", review: result.review! };
    });
    await expect(f.reopen().review(review())).rejects.toMatchObject({
      intentId: "intent-1",
    });
    expect(f.storage.length).toBe(1);
  });

  it("returns validated acceptance with retained recovery data if storage acknowledgement fails", async () => {
    const f = fixture();
    const broken = {
      ...f.storage,
      get length() {
        return f.storage.length;
      },
      removeItem() {
        throw Error("storage failed after POST");
      },
    };
    const commands = new ControlWorkflowCommands({
      client: f.client,
      journal: new ControlWorkflowIntentJournal({ storage: () => broken }),
    });
    const result = await commands.start(body());
    expect(result.journal).toBe("retained");
    expect(result.kind === "start" && result.response.run.runId).toBe("run-1");
    expect(f.journal().get(result.intent.id).id).toBe(result.intent.id);
  });
});
