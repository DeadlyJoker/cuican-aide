import { parseAutomationScheduleState } from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import type {
  AutomationAuthorizationPort,
  AutomationInvocationResult,
} from "./automation-store-port.ts";
import type {
  AutomationScheduleClaim,
  AutomationScheduleClaimInput,
  AutomationScheduleLeaseInput,
  AutomationSchedulerStore,
  AutomationScheduleCalculatorPort,
  ScheduledAutomationInvocationPreparer,
  ScheduledAutomationReceiptQuery,
} from "./automation-scheduler-store-port.ts";

export type AutomationSchedulerOutcome =
  | Readonly<{ kind: "idle" }>
  | Readonly<{
      kind: "admitted" | "replayed";
      automationId: string;
      runId: string;
      scheduledFor: string;
    }>
  | Readonly<{
      kind: "retried" | "disabled";
      automationId: string;
      scheduledFor: string;
      reasonCode: string;
    }>;

export class AutomationSchedulerApplicationService {
  readonly #store: AutomationSchedulerStore;
  readonly #authorization: AutomationAuthorizationPort;
  readonly #calculator: AutomationScheduleCalculatorPort;
  readonly #preparer: ScheduledAutomationInvocationPreparer;
  readonly #retryAfterMs: number;

  constructor(dependencies: {
    store: AutomationSchedulerStore;
    authorization: AutomationAuthorizationPort;
    calculator: AutomationScheduleCalculatorPort;
    preparer: ScheduledAutomationInvocationPreparer;
    retryAfterMs: number;
  }) {
    if (
      !Number.isSafeInteger(dependencies.retryAfterMs) ||
      dependencies.retryAfterMs < 1
    ) {
      throw new ApplicationError(
        "validation",
        "automation_retry_delay_invalid",
      );
    }
    this.#store = dependencies.store;
    this.#authorization = dependencies.authorization;
    this.#calculator = dependencies.calculator;
    this.#preparer = dependencies.preparer;
    this.#retryAfterMs = dependencies.retryAfterMs;
  }

  async runOnce(
    input: AutomationScheduleClaimInput,
  ): Promise<AutomationSchedulerOutcome> {
    const claim = await this.#store.claimNextDueAutomation(input);
    if (claim === null) return { kind: "idle" };
    const receipt = receiptQuery(claim);
    const replay = await this.#store.loadScheduledAutomationReceipt(receipt);
    if (replay !== null) {
      validateScheduledResult(claim, replay);
      return admitted("replayed", claim, replay.runState.runId);
    }

    try {
      const actor = claim.record.definition.owner;
      await this.#authorize(claim);
      const invocation = await this.#preparer.prepare({ actor, claim });
      validatePreparedInvocation(claim, invocation);
      const result = await this.#store.commitScheduledAutomationInvocation({
        receipt,
        lease: leaseInput(claim),
        expectedDefinitionDigest: claim.record.definitionDigest,
        expectedScheduleStateRevision: claim.record.scheduleState.revision,
        invocation,
        nextScheduleState: nextScheduleState(claim, this.#calculator),
      });
      validateScheduledResult(claim, result);
      return admitted(
        result.disposition === "replayed" ? "replayed" : "admitted",
        claim,
        result.runState.runId,
      );
    } catch (error) {
      const reasonCode = failureCode(error);
      if (
        error instanceof ApplicationError &&
        error.code === "authorization_denied"
      ) {
        await this.#store.disableAutomationScheduleClaim({
          ...leaseInput(claim),
          reasonCode,
        });
        return {
          kind: "disabled",
          automationId: claim.record.definition.automationId,
          scheduledFor: claim.scheduledFor,
          reasonCode,
        };
      }
      await this.#store.retryAutomationScheduleClaim({
        ...leaseInput(claim),
        retryAt: new Date(
          Date.parse(claim.observedAt) + this.#retryAfterMs,
        ).toISOString(),
        reasonCode,
      });
      return {
        kind: "retried",
        automationId: claim.record.definition.automationId,
        scheduledFor: claim.scheduledFor,
        reasonCode,
      };
    }
  }

  async #authorize(claim: AutomationScheduleClaim): Promise<void> {
    const definition = claim.record.definition;
    const actor = definition.owner;
    for (const request of [
      {
        action: "automation:run" as const,
        resource: {
          kind: "automation" as const,
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          automationId: definition.automationId,
          threadId: definition.threadId,
        },
      },
      {
        action: "thread:message:append" as const,
        resource: {
          kind: "thread" as const,
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          threadId: definition.threadId,
        },
      },
      {
        action: "run:create" as const,
        resource: {
          kind: "run" as const,
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          threadId: definition.threadId,
          runId: null,
        },
      },
    ]) {
      const decision = await this.#authorization.authorize({
        actor,
        ...request,
      });
      if (decision.outcome !== "allow") {
        throw new ApplicationError("authorization", "authorization_denied");
      }
    }
  }
}

function validatePreparedInvocation(
  claim: AutomationScheduleClaim,
  input: Awaited<ReturnType<ScheduledAutomationInvocationPreparer["prepare"]>>,
): void {
  const definition = claim.record.definition;
  const trigger = input.binding?.trigger;
  if (
    input.tenantId !== definition.tenantId ||
    input.spaceId !== definition.spaceId ||
    input.definitionFence?.automationId !== definition.automationId ||
    input.definitionFence?.expectedDefinitionDigest !==
      claim.record.definitionDigest ||
    trigger?.kind !== "schedule" ||
    trigger.scheduleRevision !== claim.record.scheduleState.scheduleRevision ||
    trigger.scheduledFor !== claim.scheduledFor ||
    trigger.occurrenceDigest !== claim.occurrenceDigest
  ) {
    throw new ApplicationError(
      "internal",
      "scheduled_automation_invocation_invalid",
    );
  }
}

function validateScheduledResult(
  claim: AutomationScheduleClaim,
  result: AutomationInvocationResult,
): void {
  const trigger = result.binding.trigger;
  if (
    result.record.definition.automationId !==
      claim.record.definition.automationId ||
    result.record.definitionDigest !== claim.record.definitionDigest ||
    result.binding.automationId !== claim.record.definition.automationId ||
    result.binding.definitionDigest !== claim.record.definitionDigest ||
    result.binding.runId !== result.runState.runId ||
    trigger.kind !== "schedule" ||
    trigger.scheduleRevision !== claim.record.scheduleState.scheduleRevision ||
    trigger.scheduledFor !== claim.scheduledFor ||
    trigger.occurrenceDigest !== claim.occurrenceDigest
  ) {
    throw new ApplicationError(
      "internal",
      "scheduled_automation_receipt_invalid",
    );
  }
}

function receiptQuery(
  claim: AutomationScheduleClaim,
): ScheduledAutomationReceiptQuery {
  return {
    tenantId: claim.record.definition.tenantId,
    automationId: claim.record.definition.automationId,
    scheduleRevision: claim.record.scheduleState.scheduleRevision,
    scheduledFor: claim.scheduledFor,
    occurrenceDigest: claim.occurrenceDigest,
  };
}

function leaseInput(
  claim: AutomationScheduleClaim,
): AutomationScheduleLeaseInput {
  return {
    tenantId: claim.record.definition.tenantId,
    automationId: claim.record.definition.automationId,
    scheduleRevision: claim.record.scheduleState.scheduleRevision,
    scheduledFor: claim.scheduledFor,
    ownerId: claim.lease.ownerId,
    leaseId: claim.lease.leaseId,
    leaseEpoch: claim.lease.epoch,
  };
}

function nextScheduleState(
  claim: AutomationScheduleClaim,
  calculator: AutomationScheduleCalculatorPort,
) {
  const definition = claim.record.definition;
  const nextOccurrenceAt = calculator.nextOccurrence({
    schedule: definition.schedule,
    after: claim.observedAt,
    inclusive: false,
  });
  if (definition.schedule.kind !== "once" && nextOccurrenceAt === null) {
    throw new ApplicationError(
      "internal",
      "automation_next_occurrence_missing",
    );
  }
  return parseAutomationScheduleState({
    ...claim.record.scheduleState,
    status: nextOccurrenceAt === null ? "completed" : "enabled",
    nextOccurrenceAt,
    lastScheduledFor: claim.scheduledFor,
    retryAt: null,
    revision: claim.record.scheduleState.revision + 1,
    updatedAt: claim.observedAt,
  });
}

function admitted(
  kind: "admitted" | "replayed",
  claim: AutomationScheduleClaim,
  runId: string,
): AutomationSchedulerOutcome {
  return {
    kind,
    automationId: claim.record.definition.automationId,
    runId,
    scheduledFor: claim.scheduledFor,
  };
}

function failureCode(error: unknown): string {
  if (error instanceof ApplicationError) return error.code;
  return error instanceof Error && /^[a-z0-9_]{1,128}$/u.test(error.message)
    ? error.message
    : "automation_schedule_admission_failed";
}
