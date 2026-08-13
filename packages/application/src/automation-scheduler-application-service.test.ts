import assert from "node:assert/strict";
import test from "node:test";

import { createAutomationDefinition } from "@crewon/domain";

import { AutomationSchedulerApplicationService } from "./automation-scheduler-application-service.ts";
import type {
  AutomationScheduleClaim,
  AutomationSchedulerStore,
  CommitScheduledAutomationInvocationInput,
  ScheduledAutomationReceiptQuery,
} from "./automation-scheduler-store-port.ts";
import type {
  AutomationInvocationResult,
  CommitAutomationInvocationInput,
} from "./automation-store-port.ts";

test("receipt replay precedes authorization and artifact preparation", async () => {
  const store = new FakeSchedulerStore();
  store.receipt = result("run-replayed");
  let authorizationCalls = 0;
  let preparationCalls = 0;
  const service = scheduler(store, {
    authorization: {
      authorize: async () => {
        authorizationCalls += 1;
        return { outcome: "allow" };
      },
    },
    preparer: {
      prepare: async () => {
        preparationCalls += 1;
        return invocation();
      },
    },
  });

  assert.deepEqual(await service.runOnce(claimInput()), {
    kind: "replayed",
    automationId: "automation-1",
    runId: "run-replayed",
    scheduledFor: "2026-08-10T10:00:00Z",
  });
  assert.deepEqual(store.events, ["claim", "receipt"]);
  assert.equal(authorizationCalls, 0);
  assert.equal(preparationCalls, 0);
});

test("authorizes the frozen owner and atomically advances a once schedule", async () => {
  const store = new FakeSchedulerStore();
  const actions: string[] = [];
  const service = scheduler(store, {
    authorization: {
      authorize: async ({ actor, action }) => {
        assert.deepEqual(actor, owner);
        actions.push(action);
        return { outcome: "allow" };
      },
    },
    preparer: {
      prepare: async ({ actor, claim }) => {
        assert.deepEqual(actor, owner);
        assert.equal(claim.occurrenceDigest, digest);
        return invocation();
      },
    },
  });

  assert.equal((await service.runOnce(claimInput())).kind, "admitted");
  assert.deepEqual(actions, [
    "automation:run",
    "thread:message:append",
    "run:create",
  ]);
  assert.deepEqual(store.commitInput?.receipt, receiptQuery());
  assert.deepEqual(store.commitInput?.nextScheduleState, {
    ...scheduleState,
    status: "completed",
    nextOccurrenceAt: null,
    lastScheduledFor: "2026-08-10T10:00:00Z",
    revision: 2,
    updatedAt: "2026-08-10T10:01:00Z",
  });
});

test("a policy denial disables the exact leased occurrence", async () => {
  const store = new FakeSchedulerStore();
  const service = scheduler(store, {
    authorization: {
      authorize: async () => ({ outcome: "deny", reasonCode: "policy" }),
    },
    preparer: { prepare: async () => invocation() },
  });

  assert.deepEqual(await service.runOnce(claimInput()), {
    kind: "disabled",
    automationId: "automation-1",
    scheduledFor: "2026-08-10T10:00:00Z",
    reasonCode: "authorization_denied",
  });
  assert.deepEqual(store.disabled, {
    tenantId: "tenant-1",
    automationId: "automation-1",
    scheduleRevision: 1,
    scheduledFor: "2026-08-10T10:00:00Z",
    ownerId: "scheduler-1",
    leaseId: "lease-1",
    leaseEpoch: 4,
    reasonCode: "authorization_denied",
  });
});

class FakeSchedulerStore implements AutomationSchedulerStore {
  readonly events: string[] = [];
  receipt: AutomationInvocationResult | null = null;
  commitInput: CommitScheduledAutomationInvocationInput | null = null;
  disabled: unknown = null;

  async claimNextDueAutomation(): Promise<AutomationScheduleClaim> {
    this.events.push("claim");
    return claim;
  }
  async loadScheduledAutomationReceipt(
    _query: ScheduledAutomationReceiptQuery,
  ): Promise<AutomationInvocationResult | null> {
    this.events.push("receipt");
    return this.receipt;
  }
  async commitScheduledAutomationInvocation(
    input: CommitScheduledAutomationInvocationInput,
  ): Promise<AutomationInvocationResult> {
    this.events.push("commit");
    this.commitInput = structuredClone(input);
    return result("run-1");
  }
  async retryAutomationScheduleClaim(): Promise<void> {}
  async disableAutomationScheduleClaim(input: unknown): Promise<void> {
    this.disabled = structuredClone(input);
  }
}

function scheduler(
  store: AutomationSchedulerStore,
  dependencies: Pick<
    ConstructorParameters<typeof AutomationSchedulerApplicationService>[0],
    "authorization" | "preparer"
  >,
) {
  return new AutomationSchedulerApplicationService({
    store,
    ...dependencies,
    calculator: { nextOccurrence: () => null },
    retryAfterMs: 1_000,
  });
}

const owner = {
  principalId: "principal-1",
  actorId: "actor-1",
  tenantId: "tenant-1",
  spaceId: "space-1",
} as const;
const digest = `sha256:${"a".repeat(64)}`;
const scheduleState = {
  schemaVersion: "crewon.automation-schedule-state.v1" as const,
  automationId: "automation-1",
  scheduleRevision: 1 as const,
  status: "enabled" as const,
  nextOccurrenceAt: "2026-08-10T10:00:00Z",
  lastScheduledFor: null,
  retryAt: null,
  revision: 1,
  updatedAt: "2026-08-09T00:00:00Z",
};
const claim: AutomationScheduleClaim = {
  record: {
    definition: createAutomationDefinition({
      automationId: "automation-1",
      tenantId: owner.tenantId,
      spaceId: owner.spaceId,
      owner,
      threadId: "thread-1",
      title: "Once",
      prompt: "Run once.",
      agentVersionId: "agent-version-1",
      schedule: { kind: "once", at: "2026-08-10T10:00:00Z" },
      createdAt: "2026-08-09T00:00:00Z",
    }),
    definitionDigest: digest,
    scheduleState,
  },
  scheduledFor: "2026-08-10T10:00:00Z",
  observedAt: "2026-08-10T10:01:00Z",
  occurrenceDigest: digest,
  lease: {
    ownerId: "scheduler-1",
    leaseId: "lease-1",
    epoch: 4,
    expiresAt: "2026-08-10T10:02:00Z",
  },
};

function claimInput() {
  return {
    ownerId: "scheduler-1",
    leaseId: "lease-1",
    leaseDurationMs: 60_000,
    observedAt: claim.observedAt,
  };
}
function receiptQuery() {
  return {
    tenantId: owner.tenantId,
    automationId: "automation-1",
    scheduleRevision: 1,
    scheduledFor: claim.scheduledFor,
    occurrenceDigest: digest,
  };
}
function invocation() {
  return {
    tenantId: owner.tenantId,
    spaceId: owner.spaceId,
    definitionFence: {
      automationId: "automation-1",
      expectedRevision: 1,
      expectedDefinitionDigest: digest,
    },
    binding: binding("run-1"),
  } as unknown as CommitAutomationInvocationInput;
}
function result(runId: string) {
  return {
    disposition: "committed",
    record: claim.record,
    binding: binding(runId),
    runState: { runId },
  } as unknown as AutomationInvocationResult;
}
function binding(runId: string) {
  return {
    automationId: "automation-1",
    automationRevision: 1 as const,
    definitionDigest: digest,
    instructionDigest: digest,
    invocationId: "invocation-1",
    runId,
    routeDigest: digest,
    trigger: {
      kind: "schedule" as const,
      scheduleRevision: 1 as const,
      scheduledFor: claim.scheduledFor,
      occurrenceDigest: digest,
    },
  };
}
