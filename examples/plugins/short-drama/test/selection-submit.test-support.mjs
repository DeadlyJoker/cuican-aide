import assert from "node:assert/strict";
import { queryService, operations } from "./query-submit.test-support.mjs";
import { locator } from "./generation-submit.test-support.mjs";

export const selectionReadAction =
  "crewon.project-generation-selections.v1.getConceptSelection";
export const selectImageAction =
  "crewon.project-generation-selections.v1.selectConceptImage";
const copy = (value) => structuredClone(value);
const family = (reference) =>
  JSON.stringify([reference.projectId, reference.assetId]);

/** Public DOM/protocol fixture only. Actual Host journal, authority and SQL are covered by integration tests. */
export function selectionService() {
  const base = queryService(),
    receipts = new Map(),
    pointers = new Map();
  let intent = null,
    notify = () => {},
    enabled = true,
    mode = "success",
    readFailure = false,
    readGate = null,
    writeGate = null;
  const context = () => ({
    version: "crewon.project-generation-selection-host-context.v1",
    intent: copy(intent),
  });
  const props = (ready = true, tokens, theme = "light") => {
    const value = base.props(ready, tokens, theme);
    if (enabled) value.data.projectGenerationSelectionContext = context();
    return value;
  };
  const current = (reference) => {
    const saved = pointers.get(family(reference));
    if (!saved) return { selectionRevision: 0, current: null };
    const record = base.records.get(reference.projectId),
      asset = record.assets.get(reference.assetId);
    const revision = asset.revisions.find(
      (value) =>
        value.assetRevision === saved.selection.reference.assetRevision,
    );
    return {
      selectionRevision: saved.selectionRevision,
      current: {
        ...copy(saved.selection),
        requiresConfirmation:
          saved.selection.reference.assetRevision !==
            asset.asset.latestAssetRevision ||
          revision.briefRevision !== record.project.latestBriefRevision,
      },
    };
  };
  const seedImages = (saved) => {
    const generation = base.seedGeneration(saved, [operations[0]]);
    generation.task.runStatus = "completed";
    generation.task.truncated = true;
    generation.task.operations[0] = {
      ...generation.task.operations[0],
      status: "succeeded",
      operationRevision: 9,
      images: [0, 2].map((resultIndex) => ({
        resultIndex,
        filename: `image-${resultIndex}.png`,
        url: `https://images.example.test/view?filename=image-${resultIndex}.png`,
      })),
    };
    base.setGeneration(locator(saved), generation);
    return copy(generation);
  };
  const commit = (input) => {
    const prior = receipts.get(input.idempotencyKey);
    if (prior) {
      assert.deepEqual(
        prior.request,
        input,
        "replay keeps the entire source/CAS/operation/key",
      );
      return { ...copy(prior.receipt), disposition: "replayed" };
    }
    const record = base.records.get(input.reference.projectId),
      asset = record.assets.get(input.reference.assetId);
    assert.equal(record.project.state, "active");
    assert.equal(
      record.project.revision,
      input.reference.expectedProjectRevision,
    );
    assert.equal(
      asset.asset.revision,
      input.reference.expectedAssetMetadataRevision,
    );
    assert.equal(
      current(input.reference).selectionRevision,
      input.expectedSelectionRevision,
    );
    const selection = {
      reference: {
        projectId: input.reference.projectId,
        assetId: input.reference.assetId,
        assetRevision: input.reference.assetRevision,
      },
      operationId: input.operationId,
      operationRevision: input.expectedOperationRevision,
      resultIndex: input.resultIndex,
      filename: `image-${input.resultIndex}.png`,
      url: `https://images.example.test/view?filename=image-${input.resultIndex}.png`,
      selectedAt: "2026-10-04T00:00:02.000Z",
    };
    const receipt = {
      disposition: "committed",
      selectionRevision: input.expectedSelectionRevision + 1,
      selection,
    };
    pointers.set(family(input.reference), copy(receipt));
    receipts.set(input.idempotencyKey, {
      request: copy(input),
      receipt: copy(receipt),
    });
    return receipt;
  };
  const services = {
    async invoke(action, input, options) {
      if (action !== selectImageAction && action !== selectionReadAction)
        return base.services.invoke(action, input, options);
      base.calls.push({ action, input: copy(input), signal: options?.signal });
      if (action === selectionReadAction) {
        assert.deepEqual(Object.keys(input).sort(), ["assetId", "projectId"]);
        const response = current(input),
          failure = readFailure;
        if (readGate) {
          const gate = readGate;
          readGate = null;
          await gate.promise;
        }
        if (failure) throw new Error("current_selection_read_failed");
        return response;
      }
      assert.deepEqual(Object.keys(input).sort(), [
        "expectedOperationRevision",
        "expectedSelectionRevision",
        "idempotencyKey",
        "operationId",
        "reference",
        "resultIndex",
      ]);
      assert.deepEqual(Object.keys(input.reference).sort(), [
        "assetId",
        "assetRevision",
        "expectedAssetMetadataRevision",
        "expectedProjectRevision",
        "projectId",
      ]);
      const captured = mode;
      if (captured === "refused") {
        intent = {
          request: copy(input),
          phase: "refused",
          retryable: false,
          receipt: null,
        };
        notify();
        throw Object.assign(new Error("definitive_conflict"), { status: 409 });
      }
      intent = {
        request: copy(input),
        phase: "pending",
        retryable: false,
        receipt: null,
      };
      notify();
      if (writeGate) {
        const gate = writeGate;
        writeGate = null;
        try {
          await gate.promise;
        } catch (error) {
          intent = { ...intent, phase: "uncertain", retryable: true };
          notify();
          throw error;
        }
      }
      if (captured === "error") {
        intent = { ...intent, phase: "uncertain", retryable: true };
        notify();
        throw new Error("selection_send_ack_unknown");
      }
      const receipt = commit(input);
      if (captured === "lost") {
        intent = { ...intent, phase: "uncertain", retryable: true };
        notify();
        throw new Error("selection_commit_ack_lost");
      }
      intent = {
        request: copy(input),
        phase: "accepted",
        retryable: false,
        receipt: copy(receipt),
      };
      notify();
      if (captured === "acceptedThenError")
        throw new Error("late_error_after_selection_accept");
      return receipt;
    },
  };
  base.watch(() => notify());
  return {
    ...base,
    services,
    props,
    selectionContext: context,
    selectionReceipts: receipts,
    seedImages,
    currentSelection: current,
    commitSelection: commit,
    watch(callback) {
      notify = callback;
    },
    setSelectionMode(value) {
      mode = value;
    },
    setSelectionIntent(value) {
      intent = copy(value);
      notify();
    },
    enableSelectionContext(value) {
      enabled = value;
    },
    failSelectionRead(value) {
      readFailure = value;
    },
    gateSelectionRead(value) {
      readGate = value;
    },
    gateSelectionWrite(value) {
      writeGate = value;
    },
    publish() {
      notify();
    },
  };
}
