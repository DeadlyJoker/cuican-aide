import type { RunLifecycleEvent, RunState, ThreadGoal } from "@crewon/domain";

import type { WorkItemLeaseInput } from "./durable-queue-port.ts";
import type { GoalToolName } from "./goal-tool.ts";
import type { IdempotencyDescriptor } from "./run-store-port.ts";
import type { OutboxMessage } from "./run-store-port.ts";

export type GoalToolExecutionInput = Readonly<{
  tenantId: string;
  threadId: string;
  runId: string;
  lease: WorkItemLeaseInput;
  idempotency: IdempotencyDescriptor;
  request: Readonly<{
    segmentId: string;
    callId: string;
    kind: "function";
    name: GoalToolName;
    input: string;
  }>;
  proposedGoalId: string | null;
  accountingEventId: string;
  accountingOutboxMessageId: string;
  occurredAt: string;
}>;

export type GoalToolExecutionResult = Readonly<{
  disposition: "committed" | "replayed";
  goalState: ThreadGoal | null;
  runState: RunState;
  runEvents: readonly RunLifecycleEvent[];
  outbox: readonly OutboxMessage[];
  output: string;
  isError: boolean;
}>;

/** Fenced, replay-safe authority for server-owned Goal Tool calls. */
export interface GoalToolStore {
  executeGoalTool(
    input: GoalToolExecutionInput,
  ): Promise<GoalToolExecutionResult>;
}
