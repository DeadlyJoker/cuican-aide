import {
  validateRunGoalAccountingCursor,
  validateRunGoalBinding,
  parseFrozenWorkflowVersionBinding,
  type RunState,
  type RunUsage,
} from "@crewon/domain";
import { RunStoreError } from "@crewon/application";

/** Adds the supported defaults to historical stored Run snapshots. */
export function normalizeStoredRunState(
  state: RunState,
  code: string,
): RunState {
  if (typeof state !== "object" || state === null || Array.isArray(state)) {
    throw new RunStoreError(code);
  }
  const value = state as RunState & Record<string, unknown>;
  const hasMode = Object.hasOwn(value, "collaborationMode");
  const hasBinding = Object.hasOwn(value, "goalBinding");
  const hasGoalAccounting = Object.hasOwn(value, "goalAccounting");
  const hasGoalContinuationMode = Object.hasOwn(
    value,
    "goalContinuationMode",
  );
  const hasUsage = Object.hasOwn(value, "usage");
  const hasPurpose = Object.hasOwn(value, "purpose");
  const hasWorkflowBinding = Object.hasOwn(value, "workflowVersionBinding");
  let normalized = state;
  if (hasWorkflowBinding) {
    const binding = value.workflowVersionBinding;
    try {
      parseFrozenWorkflowVersionBinding(binding);
    } catch (error) {
      throw new RunStoreError(code, { cause: error });
    }
  }
  if (
    hasPurpose &&
    value.purpose !== "turn" &&
    value.purpose !== "manualCompaction" &&
    value.purpose !== "workflow"
  ) {
    throw new RunStoreError(code);
  }
  const effectivePurpose = value.purpose ?? "turn";
  if (
    (effectivePurpose === "workflow") !==
      hasWorkflowBinding ||
    (effectivePurpose === "workflow" && value.collaborationMode !== "default")
  ) {
    throw new RunStoreError(code);
  }
  if (!hasMode && !hasBinding) {
    normalized = {
      ...normalized,
      collaborationMode: "default",
      goalBinding: null,
    };
  }
  if (hasMode !== hasBinding) throw new RunStoreError(code);
  if (hasMode && hasBinding) {
    if (
      value.collaborationMode !== "default" &&
      value.collaborationMode !== "plan"
    ) {
      throw new RunStoreError(code);
    }
    const binding = value.goalBinding;
    if (binding !== null) {
      try {
        validateRunGoalBinding(binding as NonNullable<RunState["goalBinding"]>);
      } catch (error) {
        throw new RunStoreError(code, { cause: error });
      }
    }
    if (value.collaborationMode === "plan" && value.goalBinding !== null) {
      throw new RunStoreError(code);
    }
  }
  if (
    hasGoalContinuationMode &&
    (value.goalContinuationMode !== "deferred" ||
      value.collaborationMode !== "default" ||
      value.goalBinding === null)
  ) {
    throw new RunStoreError(code);
  }
  if (!hasGoalAccounting) {
    normalized = { ...normalized, goalAccounting: null };
  } else if (value.goalAccounting !== null) {
    try {
      validateRunGoalAccountingCursor(
        value.goalAccounting as NonNullable<RunState["goalAccounting"]>,
      );
    } catch (error) {
      throw new RunStoreError(code, { cause: error });
    }
    if (
      value.collaborationMode === "plan" &&
      (value.goalAccounting as RunState["goalAccounting"])?.attribution !== null
    ) {
      throw new RunStoreError(code);
    }
  }
  if (!hasUsage) {
    normalized = {
      ...normalized,
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
    };
  } else {
    normalized = {
      ...normalized,
      usage: normalizeStoredRunUsage(value.usage, code),
    };
  }
  return normalized;
}

function normalizeStoredRunUsage(value: unknown, code: string): RunUsage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RunStoreError(code);
  }
  const usage = value as Record<string, unknown>;
  const cachedInputTokens = Object.hasOwn(usage, "cachedInputTokens")
    ? usage.cachedInputTokens
    : 0;
  if (
    !isNonNegativeSafeInteger(usage.inputTokens) ||
    !isNonNegativeSafeInteger(cachedInputTokens) ||
    cachedInputTokens > usage.inputTokens ||
    !isNonNegativeSafeInteger(usage.outputTokens) ||
    !isNonNegativeSafeInteger(usage.totalTokens) ||
    usage.totalTokens !== usage.inputTokens + usage.outputTokens
  ) {
    throw new RunStoreError(code);
  }
  return {
    inputTokens: usage.inputTokens,
    cachedInputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  };
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
