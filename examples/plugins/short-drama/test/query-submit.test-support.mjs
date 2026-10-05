import assert from "node:assert/strict";
import {
  generationService,
  locator,
} from "./generation-submit.test-support.mjs";
export const queryAction =
  "crewon.project-generation-queries.v1.queryConceptGeneration";
const copy = (value) => structuredClone(value);
export const operations = [
  "00000000-0000-0000-0000-000000000001",
  "00000000-0000-0000-0000-000000000002",
];
/** Current Short18 self-query DTO dispatcher and Host recovery data only; real admission/SQL is verified by CrewON integration tests. */
export function queryService() {
  const base = generationService();
  let intent = null,
    notify = () => {},
    mode = "success",
    gate = null,
    contextEnabled = true;
  const queryReceipts = new Map();
  const context = () => {
    const generation = base.context();
    return {
      version: "crewon.project-generation-query-host-context.v1",
      phase:
        intent?.phase === "pending"
          ? "loading"
          : intent?.phase === "uncertain"
            ? "uncertain"
            : generation.thread
              ? "ready"
              : "idle",
      thread: copy(generation.thread),
      threadReady:
        generation.threadReady &&
        intent?.phase !== "pending" &&
        intent?.phase !== "uncertain",
      intent: copy(intent),
    };
  };
  const props = (ready = true, tokens, theme = "light") => {
    const value = base.props(ready, tokens, theme);
    if (contextEnabled) value.data.projectGenerationQueryContext = context();
    return value;
  };
  function seedGeneration(saved, ids = operations) {
    const runId = `original-generation-${saved.assetRevision.assetRevision}`;
    const generation = {
      ...locator(saved),
      briefRevision: saved.assetRevision.briefRevision,
      createdAt: "2026-10-04T00:00:00.000Z",
      task: {
        runId,
        threadId: "original-thread",
        pluginId: "crewon.short-drama",
        pluginVersion: "18.0.0",
        configurationRevision: 3,
        runStatus: "running",
        sourceRunId: null,
        operations: ids.map((operationId, i) => ({
          operationId,
          sourceRunId: runId,
          status: i ? "unknownOutcome" : "running",
          observedAt: "2026-10-04T00:00:01.000Z",
          operationRevision: i + 1,
          images: [],
        })),
        truncated: false,
      },
    };
    base.setGeneration(locator(saved), generation);
    return copy(generation);
  }
  function commit(input) {
    const existing = queryReceipts.get(input.idempotencyKey);
    if (existing) {
      assert.deepEqual(existing.request, input);
      return { ...copy(existing.receipt), disposition: "replayed" };
    }
    const thread = base.context().thread;
    assert.ok(thread);
    assert.equal(input.threadId, thread.threadId);
    assert.equal(input.expectedThreadRevision, thread.revision);
    const receipt = {
      disposition: "committed",
      threadId: input.threadId,
      threadRevision: input.expectedThreadRevision + 1,
      runId: `independent-query-run-${queryReceipts.size + 1}`,
      messageId: `query-message-${queryReceipts.size + 1}`,
      configurationRevision: 3,
    };
    queryReceipts.set(input.idempotencyKey, {
      request: copy(input),
      receipt: copy(receipt),
    });
    base.setThread({ ...thread, revision: receipt.threadRevision });
    return receipt;
  }
  const services = {
    async invoke(action, input, options) {
      if (action !== queryAction)
        return base.services.invoke(action, input, options);
      base.calls.push({ action, input: copy(input), signal: options?.signal });
      assert.deepEqual(Object.keys(input).sort(), [
        "expectedThreadRevision",
        "idempotencyKey",
        "operationId",
        "reference",
        "threadId",
      ]);
      assert.deepEqual(Object.keys(input.reference).sort(), [
        "assetId",
        "assetRevision",
        "projectId",
      ]);
      const capturedMode = mode;
      if (capturedMode === "refused") {
        intent = {
          request: copy(input),
          phase: "refused",
          retryable: false,
          receipt: null,
        };
        notify();
        throw new Error("trusted_host_refused_before_send");
      }
      intent = {
        request: copy(input),
        phase: "pending",
        retryable: false,
        receipt: null,
      };
      notify();
      if (gate) {
        const pending = gate;
        gate = null;
        try {
          await pending.promise;
        } catch (error) {
          intent = { ...intent, phase: "uncertain", retryable: true };
          notify();
          throw error;
        }
      }
      if (capturedMode === "error") {
        intent = { ...intent, phase: "uncertain", retryable: true };
        notify();
        throw new Error("sent_query_ack_unknown");
      }
      const receipt = commit(input);
      if (capturedMode === "lost") {
        intent = { ...intent, phase: "uncertain", retryable: true };
        notify();
        throw new Error("query_commit_ack_lost");
      }
      intent = {
        request: copy(input),
        phase: "accepted",
        retryable: false,
        receipt: copy(receipt),
      };
      notify();
      if (capturedMode === "acceptedThenError")
        throw new Error("late_error_after_accepted_query");
      return receipt;
    },
  };
  base.watch(() => notify());
  return {
    ...base,
    services,
    props,
    queryContext: context,
    queryReceipts,
    seedGeneration,
    watch(callback) {
      notify = callback;
    },
    setQueryMode(value) {
      mode = value;
    },
    setQueryIntent(value) {
      intent = copy(value);
      notify();
    },
    gateQuery(value) {
      gate = value;
    },
    enableContext(value) {
      contextEnabled = value;
    },
    publish() {
      notify();
    },
  };
}
