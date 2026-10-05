import assert from "node:assert/strict";
import { queryService, operations } from "./query-submit.test-support.mjs";
import { locator } from "./generation-submit.test-support.mjs";

export const historicalQueryAction =
  "crewon.project-historical-queries.v1.queryConceptGeneration";
const copy = (value) => structuredClone(value);

/** Public mount/session DTO fixture; no SQL, durable intent or private query authority claim. */
export function historicalQueryService() {
  const base = queryService(),
    receipts = new Map();
  let intent = null,
    notify = () => {},
    mode = "success",
    gate = null,
    enabled = true;
  const context = () => {
    const generation = base.context();
    return {
      version: "crewon.project-historical-query-host-context.v1",
      recovery: "session-only",
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
  const props = (...args) => {
    const result = base.props(...args);
    if (enabled) result.data.projectHistoricalQueryHostContext = context();
    return result;
  };
  const services = {
    async invoke(action, input, options) {
      if (action !== historicalQueryAction)
        return base.services.invoke(action, input, options);
      base.calls.push({ action, input: copy(input), signal: options?.signal });
      assert.deepEqual(Object.keys(input).sort(), [
        "expectedThreadRevision",
        "idempotencyKey",
        "operationId",
        "reference",
        "threadId",
      ]);
      const captured = mode;
      intent = {
        request: copy(input),
        phase: captured === "refused" ? "refused" : "pending",
        retryable: false,
        receipt: null,
      };
      notify();
      if (captured === "refused") throw new Error("named_before_send_refusal");
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
      if (captured === "error") {
        intent = { ...intent, phase: "uncertain", retryable: true };
        notify();
        throw new Error("named_historical_response_unknown");
      }
      let saved = receipts.get(input.idempotencyKey);
      if (saved) assert.deepEqual(saved.request, input);
      else {
        const thread = base.context().thread;
        assert.equal(thread.threadId, input.threadId);
        assert.equal(thread.revision, input.expectedThreadRevision);
        const receipt = {
          disposition: "committed",
          threadId: input.threadId,
          threadRevision: input.expectedThreadRevision + 1,
          runId: `historical-query-${receipts.size + 1}`,
          messageId: `historical-message-${receipts.size + 1}`,
          configurationRevision: 3,
        };
        saved = { request: copy(input), receipt };
        receipts.set(input.idempotencyKey, saved);
        base.setThread({ ...thread, revision: receipt.threadRevision });
      }
      const receipt = {
        ...copy(saved.receipt),
        disposition: saved.returned ? "replayed" : "committed",
      };
      saved.returned = true;
      if (captured === "lost") {
        intent = { ...intent, phase: "uncertain", retryable: true };
        notify();
        throw new Error("named_historical_ack_lost");
      }
      intent = {
        request: copy(input),
        phase: "accepted",
        retryable: false,
        receipt,
      };
      notify();
      if (captured === "acceptedThenError") throw new Error("named_late_error");
      return receipt;
    },
  };
  base.watch(() => notify());
  return {
    ...base,
    services,
    props,
    historicalContext: context,
    historicalReceipts: receipts,
    seedHistoricalGeneration(saved, ids = operations) {
      const value = base.seedGeneration(saved, ids);
      value.task.pluginId = "crewon.comfyui-krea2";
      value.task.pluginVersion = "1.0.0";
      base.setGeneration(locator(saved), value);
      return value;
    },
    watch(callback) {
      notify = callback;
    },
    setHistoricalMode(value) {
      mode = value;
    },
    setHistoricalIntent(value) {
      intent = copy(value);
      notify();
    },
    enableHistoricalContext(value) {
      enabled = value;
    },
    gateHistoricalQuery(value) {
      gate = value;
    },
    clearHistoricalSession() {
      intent = null;
      notify();
    },
  };
}
