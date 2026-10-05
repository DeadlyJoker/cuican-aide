import { createHash } from "node:crypto";
import { textService } from "./text-ui.test-support.mjs";
const copy = (value) => structuredClone(value);
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
const digest = (value) =>
  `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
const failure = (code) => Object.assign(new Error(code), { code });
const writes = new Set([
  "saveOutlineCandidate",
  "saveScriptCandidate",
  "selectRevision",
  "setLocked",
]);
const refused = new Set([
  "project_text_revision_conflict",
  "project_text_locked",
  "project_text_dependencies_stale",
  "creative_project_archived",
]);

/** Explicit public DTO journal fixture. Actual source qualification and SQL are tested by host integrations. */
export function recoveryTextService() {
  const base = textService(),
    intents = new Map(),
    acknowledgements = new Map(),
    recoveryCalls = [],
    writeCalls = [];
  let serial = 0,
    loseBefore = false,
    loseAck = false,
    failRead = false,
    writeGate = null;
  function accepted(record, result) {
    record.phase = "accepted";
    record.revision = 2;
    record.refusalCode = null;
    record.confirmed = {
      kind: result.kind,
      artifactId: result.artifact.artifactId,
      artifactRevision: result.artifact.revision,
      contentRevision: result.contentRevision?.contentRevision ?? null,
      requestDigest: record.requestDigest,
      resultDigest: digest(result),
    };
  }
  async function invoke(action, input, options) {
    const method = action.split(".").at(-1);
    if (action.startsWith("crewon.project-text-recovery.v1.")) {
      recoveryCalls.push({ method, input: copy(input) });
      if (method === "getPending") {
        if (failRead) throw failure("recovery_read_unavailable");
        return { intent: copy(intents.get(input.projectId) ?? null) };
      }
      if (method !== "acknowledge") throw failure("unsupported_action");
      const previous = acknowledgements.get(input.intentId);
      if (previous) {
        if (
          previous.projectId !== input.projectId ||
          previous.expectedRevision !== input.expectedRevision
        )
          throw failure("ack_conflict");
        return {
          intentId: input.intentId,
          revision: input.expectedRevision + 1,
          disposition: "replayed",
        };
      }
      const record = intents.get(input.projectId);
      if (
        !record ||
        record.intentId !== input.intentId ||
        record.revision !== input.expectedRevision ||
        record.phase === "pending"
      )
        throw failure("ack_conflict");
      intents.delete(input.projectId);
      acknowledgements.set(input.intentId, copy(input));
      if (loseAck) {
        loseAck = false;
        throw failure("lost_acknowledgement_response");
      }
      return {
        intentId: input.intentId,
        revision: input.expectedRevision + 1,
        disposition: "acknowledged",
      };
    }
    if (!action.startsWith("crewon.project-texts.v1.") || !writes.has(method))
      return base.services.invoke(action, input, options);
    writeCalls.push({ action, input: copy(input) });
    let record = intents.get(input.projectId);
    const request = { action, input: copy(input) };
    if (record && canonical(record.request) !== canonical(request))
      throw failure("project_text_intent_pending");
    if (!record) {
      record = {
        intentId: `text-intent-${++serial}`,
        revision: 1,
        phase: "pending",
        request,
        requestDigest: digest(request),
        confirmed: null,
        refusalCode: null,
      };
      intents.set(input.projectId, record);
    }
    if (writeGate) {
      const gate = writeGate;
      writeGate = null;
      await gate;
    }
    if (loseBefore) {
      loseBefore = false;
      throw failure("lost_before_business_dispatch");
    }
    if (record.phase === "refused") throw failure(record.refusalCode);
    try {
      const result = await base.services.invoke(action, input, options);
      accepted(record, result);
      return result;
    } catch (error) {
      const receipt = base.receipts.get(input.idempotencyKey);
      if (receipt) accepted(record, receipt.result);
      else if (refused.has(error.code)) {
        record.phase = "refused";
        record.revision = 2;
        record.refusalCode = error.code;
      }
      throw error;
    }
  }
  return {
    ...base,
    services: { invoke },
    intents,
    acknowledgements,
    recoveryCalls,
    writeCalls,
    loseBeforeNextWrite: () => {
      loseBefore = true;
    },
    loseNextAcknowledgement: () => {
      loseAck = true;
    },
    failRecoveryRead: (value) => {
      failRead = value;
    },
    holdNextWrite: (promise) => {
      writeGate = promise;
    },
  };
}
