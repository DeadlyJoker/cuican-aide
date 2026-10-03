import assert from "node:assert/strict";
import {
  metadataService,
  persistentProps,
} from "./persistent-ui.test-support.mjs";

export const generateAction = "crewon.project-generations.v1.generateConcept";
export const readinessAction =
  "crewon.project-generation-contexts.v1.getReadiness";
export const readAction =
  "crewon.project-generation-reads.v1.getConceptGeneration";
export const locator = (saved) => ({
  projectId: saved.asset.projectId,
  assetId: saved.asset.assetId,
  assetRevision: saved.assetRevision.assetRevision,
});
export const reference = (saved) => ({
  ...locator(saved),
  expectedProjectRevision: saved.project.revision,
  expectedAssetMetadataRevision: saved.asset.revision,
});
const copy = (value) => structuredClone(value);

/** Public protocol/DOM fixture only. Actual identity, SQL, admission and paid execution are tested by Host. */
export function generationService() {
  const metadata = metadataService();
  let thread = {
    threadId: "original-generation-thread",
    revision: 7,
    provisional: false,
  };
  let intent = null,
    notify = () => {},
    submitGate = null,
    readinessGate = null;
  let mode = "success",
    readiness = { outcome: "ready" };
  const receipts = new Map();
  const context = () => ({
    version: "crewon.project-generation-host-context.v1",
    phase:
      intent?.phase === "pending"
        ? "preparing"
        : intent?.phase === "uncertain"
          ? "uncertain"
          : "ready",
    thread: copy(thread),
    threadReady:
      thread !== null &&
      intent?.phase !== "pending" &&
      intent?.phase !== "uncertain",
    intent: copy(intent),
  });
  const props = (ready = true, tokens, theme = "light") => ({
    ...persistentProps(ready, tokens, theme),
    data: {
      ...persistentProps(ready).data,
      projectGenerationContext: context(),
    },
  });
  function projectGeneration(saved, receipt) {
    return {
      ...locator(saved),
      briefRevision: saved.assetRevision.briefRevision,
      createdAt: "2026-10-04T00:00:00.000Z",
      task: {
        runId: receipt.runId,
        threadId: receipt.threadId,
        pluginId: "crewon.comfyui-krea2",
        pluginVersion: "1.0.0",
        configurationRevision: receipt.configurationRevision,
        runStatus: "queued",
        sourceRunId: null,
        operations: [],
        truncated: false,
      },
    };
  }
  function commit(request) {
    const existing = receipts.get(request.idempotencyKey);
    if (existing) {
      assert.deepEqual(
        existing.request,
        request,
        "replay must retain the original entire request",
      );
      return { ...copy(existing.receipt), disposition: "replayed" };
    }
    const record = metadata.records.get(request.reference.projectId);
    const asset = record.assets.get(request.reference.assetId);
    const saved = asset.revisions.find(
      (revision) => revision.assetRevision === request.reference.assetRevision,
    );
    assert.equal(
      record.project.revision,
      request.reference.expectedProjectRevision,
    );
    assert.equal(
      asset.asset.revision,
      request.reference.expectedAssetMetadataRevision,
    );
    assert.equal(record.project.state, "active");
    assert.ok(saved);
    const receipt = {
      disposition: "committed",
      threadId: request.threadId,
      threadRevision: request.expectedThreadRevision + 1,
      runId: `actual-protocol-run-${receipts.size + 1}`,
      messageId: `message-${receipts.size + 1}`,
      configurationRevision: 3,
    };
    receipts.set(request.idempotencyKey, {
      request: copy(request),
      receipt: copy(receipt),
    });
    metadata.setGeneration(
      request.reference,
      projectGeneration({ asset: asset.asset, assetRevision: saved }, receipt),
    );
    thread = { ...thread, revision: receipt.threadRevision };
    return receipt;
  }
  const services = {
    async invoke(action, input, options) {
      if (action !== generateAction && action !== readinessAction)
        return metadata.services.invoke(action, input, options);
      metadata.calls.push({
        action,
        input: copy(input),
        signal: options?.signal,
      });
      if (action === readinessAction) {
        assert.deepEqual(Object.keys(input), ["reference"]);
        if (readinessGate) {
          const gate = readinessGate;
          readinessGate = null;
          return await gate.promise;
        }
        return { reference: copy(input.reference), readiness: copy(readiness) };
      }
      assert.deepEqual(Object.keys(input).sort(), [
        "expectedThreadRevision",
        "idempotencyKey",
        "reference",
        "threadId",
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
      if (submitGate) {
        const gate = submitGate;
        submitGate = null;
        try {
          await gate.promise;
        } catch (error) {
          intent = { ...intent, phase: "uncertain", retryable: true };
          notify();
          throw error;
        }
      }
      if (capturedMode === "error") {
        intent = { ...intent, phase: "uncertain", retryable: true };
        notify();
        throw new Error("after_send_409_is_not_definitive");
      }
      const receipt = commit(input);
      if (capturedMode === "lost") {
        intent = { ...intent, phase: "uncertain", retryable: true };
        notify();
        throw new Error("response_lost_after_commit");
      }
      intent = {
        request: copy(input),
        phase: "accepted",
        retryable: false,
        receipt: copy(receipt),
      };
      notify();
      if (capturedMode === "acceptedThenError")
        throw new Error("late_failure_after_host_accepted");
      return receipt;
    },
  };
  return {
    ...metadata,
    services,
    context,
    props,
    receipts,
    publish: () => notify(),
    watch(callback) {
      notify = callback;
    },
    setMode(value) {
      mode = value;
    },
    setReadiness(value) {
      readiness = value;
    },
    gateReadiness(gate) {
      readinessGate = gate;
    },
    gateSubmit(gate) {
      submitGate = gate;
    },
    setThread(value) {
      thread = value;
      notify();
    },
    setIntent(value) {
      intent = copy(value);
      notify();
    },
    seedReceipt(request, receipt) {
      receipts.set(request.idempotencyKey, {
        request: copy(request),
        receipt: copy(receipt),
      });
    },
    callsFor(action) {
      return metadata.calls.filter((call) => call.action === action);
    },
  };
}
