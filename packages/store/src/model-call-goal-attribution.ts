import { RunStoreError } from "@crewon/application";
import {
  THREAD_GOAL_ACCOUNTING_POLICY,
  validateModelCallRecord,
  validateRunGoalAccountingCursor,
  type ModelCallRecord,
  type RunState,
} from "@crewon/domain";
import { stableJson } from "./store-invariants.ts";

/** Called only for a new intent, inside the same authority transaction as its insert. */
export function attributeNewModelCall(
  record: ModelCallRecord,
  run: RunState | null,
): ModelCallRecord {
  if (
    run === null ||
    run.tenantId !== record.tenantId ||
    run.runId !== record.runId
  )
    throw new RunStoreError("model_call_run_scope_mismatch");
  let attribution: ModelCallRecord["goalAttribution"];
  if (run.collaborationMode === "plan") attribution = null;
  else if (run.goalAccounting === null) {
    // A legacy bound Run without its interval cursor cannot be reconstructed
    // from the Thread's present Goal after edits/clear/replacement.
    attribution = run.goalBinding === null ? null : undefined;
  } else {
    try {
      validateRunGoalAccountingCursor(run.goalAccounting);
    } catch {
      throw new RunStoreError("model_call_goal_attribution_invalid");
    }
    const current = run.goalAccounting.attribution;
    if (current === null) attribution = null;
    else {
      if (run.threadId === null)
        throw new RunStoreError("model_call_goal_attribution_invalid");
      attribution = {
        threadId: run.threadId,
        goalId: current.goalId,
        goalRevision: current.goalRevision,
        objectiveDigest: current.objectiveDigest,
        policy: THREAD_GOAL_ACCOUNTING_POLICY,
      };
    }
  }
  return preserveModelCallAttribution(record, attribution);
}

/** A delayed completion/replay keeps the dispatch interval, never the current Goal. */
export function preserveModelCallAttribution(
  record: ModelCallRecord,
  attribution: ModelCallRecord["goalAttribution"],
): ModelCallRecord {
  if (
    record.goalAttribution !== undefined &&
    stableJson(record.goalAttribution) !==
      (attribution === undefined ? undefined : stableJson(attribution))
  )
    throw new RunStoreError("model_call_goal_attribution_conflict");
  const { goalAttribution: _ignored, ...rest } = record;
  const result =
    attribution === undefined
      ? rest
      : { ...rest, goalAttribution: attribution };
  try {
    validateModelCallRecord(result);
  } catch {
    throw new RunStoreError("model_call_record_invalid");
  }
  return result;
}
