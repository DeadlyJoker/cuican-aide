import type {
  AutomationScheduleSpec,
  AutomationScheduleState,
} from "@crewon/domain";

import type { ActorContext } from "./authorization-port.ts";
import type {
  AutomationDefinitionRecord,
  AutomationInvocationResult,
  CommitAutomationInvocationInput,
} from "./automation-store-port.ts";
import type { QueueLease } from "./durable-queue-port.ts";

export type AutomationScheduleClaim = Readonly<{
  record: AutomationDefinitionRecord;
  scheduledFor: string;
  observedAt: string;
  occurrenceDigest: string;
  lease: QueueLease;
}>;

export type AutomationScheduleClaimInput = Readonly<{
  ownerId: string;
  leaseId: string;
  leaseDurationMs: number;
  observedAt: string;
}>;

export type AutomationScheduleLeaseInput = Readonly<{
  tenantId: string;
  automationId: string;
  scheduleRevision: 1;
  scheduledFor: string;
  ownerId: string;
  leaseId: string;
  leaseEpoch: number;
}>;

export type ScheduledAutomationReceiptQuery = Readonly<{
  tenantId: string;
  automationId: string;
  scheduleRevision: 1;
  scheduledFor: string;
  occurrenceDigest: string;
}>;

export type CommitScheduledAutomationInvocationInput = Readonly<{
  receipt: ScheduledAutomationReceiptQuery;
  lease: AutomationScheduleLeaseInput;
  expectedDefinitionDigest: string;
  expectedScheduleStateRevision: number;
  invocation: CommitAutomationInvocationInput;
  nextScheduleState: AutomationScheduleState;
}>;

export type RetryAutomationScheduleClaimInput = AutomationScheduleLeaseInput &
  Readonly<{
    retryAt: string;
    reasonCode: string;
  }>;

/**
 * Durable Automation scheduler authority.
 *
 * Implementations claim due state with a fenced lease. Scheduled admission is
 * receipt-first and atomically validates that exact lease, immutable
 * definition, owner and schedule revision before writing the canonical
 * Message, history, Run, Outbox, WorkItem, receipt and next schedule state.
 * Receipt replay never grants permission to repeat model or Tool effects.
 */
export interface AutomationSchedulerStore {
  loadScheduledAutomationReceipt(
    query: ScheduledAutomationReceiptQuery,
  ): Promise<AutomationInvocationResult | null>;
  claimNextDueAutomation(
    input: AutomationScheduleClaimInput,
  ): Promise<AutomationScheduleClaim | null>;
  commitScheduledAutomationInvocation(
    input: CommitScheduledAutomationInvocationInput,
  ): Promise<AutomationInvocationResult>;
  retryAutomationScheduleClaim(
    input: RetryAutomationScheduleClaimInput,
  ): Promise<void>;
  disableAutomationScheduleClaim(
    input: AutomationScheduleLeaseInput & Readonly<{ reasonCode: string }>,
  ): Promise<void>;
}

/**
 * Server-owned recurrence calculation. Callers never submit next occurrence.
 * Wall-clock gaps and folds use `compatible` Temporal disambiguation, while a
 * due claim coalesces all missed recurring occurrences to the latest due one.
 */
export interface AutomationScheduleCalculatorPort {
  nextOccurrence(input: {
    schedule: AutomationScheduleSpec;
    after: string;
    inclusive: boolean;
  }): string | null;
}

/**
 * Builds canonical invocation artifacts after receipt replay and authorization
 * miss. Implementations must derive IDs and route from the frozen definition;
 * they must not commit or execute the Run themselves.
 */
export interface ScheduledAutomationInvocationPreparer {
  prepare(input: {
    actor: ActorContext;
    claim: AutomationScheduleClaim;
  }): Promise<CommitAutomationInvocationInput>;
}
