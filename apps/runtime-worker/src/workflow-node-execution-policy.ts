import type { AgentHistoryItem, KernelAgentEvent } from "@crewon/agent-kernel";
import type { WorkflowExecutionValue } from "@crewon/application";
import type { ProviderCheckpoint } from "@crewon/contracts";
import type {
  WorkflowNodeDefinition,
  WorkflowSchemaValue,
} from "@crewon/domain";
import { validateWorkflowSchemaValue } from "@crewon/domain";
import type { WorkflowNodeOutcome } from "./workflow-runtime-dispatcher.ts";
import {
  parseWorkflowNodeOutput,
  workflowNodeInputHistory,
} from "./workflow-agent-value-projection.ts";

export type WorkflowNodeEffectCertainty =
  | "notSent"
  | "responseObserved"
  | "possiblySentWithoutResponse";

export type WorkflowNodeSegmentResult = Readonly<{
  output: string;
  completed: boolean;
  providerCheckpoint: ProviderCheckpoint | null;
  bufferedEvents: readonly KernelAgentEvent[];
  requestedTools: readonly Extract<
    KernelAgentEvent,
    { type: "tool.requested" }
  >[];
  assistantContinuation: Extract<
    KernelAgentEvent,
    { type: "segment.continuation_requested" }
  > | null;
  failure: Readonly<{ code: string; retryable: boolean }> | null;
  canceled: boolean;
  effectCertainty: WorkflowNodeEffectCertainty;
}>;

export type WorkflowNodeDurabilityIntent =
  | Readonly<{
      kind: "persistAgentEvents";
      events: readonly KernelAgentEvent[];
    }>
  | Readonly<{
      kind: "checkpointAttempt";
      checkpoint: ProviderCheckpoint;
    }>
  | Readonly<{
      kind: "continueAssistantSample";
      continuation: NonNullable<
        WorkflowNodeSegmentResult["assistantContinuation"]
      >;
    }>
  | Readonly<{
      kind: "executeTools";
      requests: WorkflowNodeSegmentResult["requestedTools"];
    }>;

export type WorkflowNodeExecutionPolicyDecision =
  | Readonly<{
      kind: "executeSegment";
      history: readonly AgentHistoryItem[];
      intents: readonly [];
    }>
  | Readonly<{
      kind: "continue";
      intents: readonly WorkflowNodeDurabilityIntent[];
    }>
  | Readonly<{
      kind: "settle";
      intents: readonly WorkflowNodeDurabilityIntent[];
      outcome: WorkflowNodeOutcome;
    }>;

/** Builds the node-private initial model context without acquiring Run ownership. */
export function prepareWorkflowNodeExecution(input: {
  node: WorkflowNodeDefinition;
  inputValue: WorkflowExecutionValue;
}): WorkflowNodeExecutionPolicyDecision {
  try {
    return {
      kind: "executeSegment",
      history: workflowNodeInputHistory({
        node: input.node,
        value: validateWorkflowSchemaValue(
          input.inputValue.value,
          input.node.inputSchema,
        ),
      }),
      intents: [],
    };
  } catch (error) {
    return settleFailure(error);
  }
}

/** Converts a shared segment result into explicit durability work or a node outcome. */
export function decideWorkflowNodeSegment(
  node: WorkflowNodeDefinition,
  segment: WorkflowNodeSegmentResult,
): WorkflowNodeExecutionPolicyDecision {
  const intents: WorkflowNodeDurabilityIntent[] = [];
  if (segment.bufferedEvents.length > 0) {
    intents.push({ kind: "persistAgentEvents", events: segment.bufferedEvents });
  }
  if (segment.providerCheckpoint !== null) {
    intents.push({
      kind: "checkpointAttempt",
      checkpoint: segment.providerCheckpoint,
    });
  }
  if (segment.canceled) {
    return { kind: "settle", intents, outcome: { status: "canceled" } };
  }
  if (segment.failure !== null) {
    if (segment.effectCertainty === "possiblySentWithoutResponse") {
      return { kind: "settle", intents, outcome: { status: "unknown" } };
    }
    return {
      kind: "settle",
      intents,
      outcome: {
        status: "failed",
        failureCode: boundedFailureCode(segment.failure.code),
      },
    };
  }
  if (segment.assistantContinuation !== null) {
    intents.push({
      kind: "continueAssistantSample",
      continuation: segment.assistantContinuation,
    });
  }
  if (segment.requestedTools.length > 0) {
    intents.push({ kind: "executeTools", requests: segment.requestedTools });
  }
  if (
    segment.assistantContinuation !== null ||
    segment.requestedTools.length > 0
  ) {
    return { kind: "continue", intents };
  }
  if (!segment.completed) {
    return segment.effectCertainty === "possiblySentWithoutResponse"
      ? { kind: "settle", intents, outcome: { status: "unknown" } }
      : {
          kind: "settle",
          intents,
          outcome: {
            status: "failed",
            failureCode: "workflow_node_segment_incomplete",
          },
        };
  }
  try {
    return {
      kind: "settle",
      intents,
      outcome: {
        status: "completed",
        value: parseWorkflowNodeOutput(segment.output, node),
      },
    };
  } catch (error) {
    return { ...settleFailure(error), intents };
  }
}

/** Classifies a resolver/route/engine failure without conflating it with side-effect uncertainty. */
export function decideWorkflowNodeExecutionError(input: {
  error: unknown;
  effectCertainty: WorkflowNodeEffectCertainty;
}): Extract<WorkflowNodeExecutionPolicyDecision, { kind: "settle" }> {
  return input.effectCertainty === "possiblySentWithoutResponse"
    ? { kind: "settle", intents: [], outcome: { status: "unknown" } }
    : settleFailure(input.error);
}

function settleFailure(error: unknown): Extract<
  WorkflowNodeExecutionPolicyDecision,
  { kind: "settle" }
> {
  return {
    kind: "settle",
    intents: [],
    outcome: {
      status: "failed",
      failureCode:
        error instanceof Error
          ? boundedFailureCode(error.message)
          : "workflow_node_execution_failed",
    },
  };
}

function boundedFailureCode(value: string): string {
  return /^[a-z][a-z0-9_]{0,127}$/.test(value)
    ? value
    : "workflow_node_execution_failed";
}
