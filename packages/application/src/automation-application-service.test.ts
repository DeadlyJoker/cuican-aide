import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createAutomationDefinition,
  renderAutomationInstruction,
  type AutomationDefinition,
} from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import {
  AutomationApplicationService,
  type AutomationApplicationIdGenerator,
  type AutomationAuthorizationPort,
  type CreateAutomationCommand,
  type RunAutomationNowCommand,
} from "./automation-application-service.ts";
import type {
  AutomationCreateReceiptQuery,
  AutomationCreateResult,
  AutomationDefinitionRecord,
  AutomationInvocationContext,
  AutomationInvocationReceiptQuery,
  AutomationInvocationResult,
  AutomationListQuery,
  AutomationLocator,
  AutomationStore,
  CommitAutomationCreateInput,
  CommitAutomationInvocationInput,
} from "./automation-store-port.ts";
import { AutomationStoreError } from "./automation-store-port.ts";
import { canonicalJson } from "./canonical-json.ts";

const actor = {
  principalId: "principal-1",
  actorId: "actor-1",
  tenantId: "tenant-1",
  spaceId: "space-1",
} as const;

test("creates a frozen manual-only definition behind an atomic Thread fence", async () => {
  const events: string[] = [];
  const store = new FakeAutomationStore(events);
  const service = createService(store, events);

  const result = await service.createAutomation(actor, createCommand());

  assert.equal(result.disposition, "committed");
  assert.deepEqual(events, [
    "authorization.automation:create",
    "authorization.thread:message:append",
    "store.createReceipt",
    "route",
    "store.commitCreate",
  ]);
  assert.deepEqual(store.createInput?.threadFence, {
    threadId: "thread-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
    expectedRevision: 3,
    expectedStatus: "active",
  });
  assert.deepEqual(result.record.definition, {
    schemaVersion: "crewon.automation.v0",
    automationId: "automation-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
    createdByActorId: "actor-1",
    threadId: "thread-1",
    title: "Daily summary",
    prompt: "Summarize the project.",
    agentVersionId: "agent-version-1",
    schedule: createCommand().schedule,
    executionMode: "manualOnly",
    revision: 1,
    createdAt: "2026-08-09T00:00:00Z",
    updatedAt: "2026-08-09T00:00:00Z",
  });
  assert.equal(
    result.record.definitionDigest,
    sha256(canonicalJson(result.record.definition)),
  );

  store.createReceipt = { ...result, disposition: "replayed" };
  events.length = 0;
  assert.deepEqual(
    await service.createAutomation(actor, createCommand()),
    store.createReceipt,
  );
  assert.deepEqual(events, [
    "authorization.automation:create",
    "authorization.thread:message:append",
    "store.createReceipt",
    "authorization.automation:create",
  ]);
});

test("rejects injected create authority and oversized rendered instructions", async () => {
  const store = new FakeAutomationStore([]);
  const service = createService(store, []);
  await assert.rejects(
    service.createAutomation(actor, {
      ...createCommand(),
      definitionDigest: `sha256:${"a".repeat(64)}`,
    } as never),
    applicationError("validation", "automation_create_command_invalid"),
  );
  await assert.rejects(
    service.createAutomation(actor, {
      ...createCommand(),
      prompt: "&<>\"'".repeat(400),
    }),
    applicationError("validation", "automation_instruction_too_large"),
  );
  assert.equal(store.createInput, null);
});

test("gets and lists only validated tenant-space Automation definitions", async () => {
  const store = new FakeAutomationStore([]);
  store.record = definitionRecord();
  store.records = [definitionRecord()];
  const service = createService(store, []);

  assert.deepEqual(
    await service.getAutomation(actor, "automation-1"),
    definitionRecord().definition,
  );
  assert.deepEqual(
    await service.listAutomations(actor, { before: null, limit: 25 }),
    [definitionRecord().definition],
  );
  await assert.rejects(
    service.listAutomations(actor, {
      before: null,
      limit: 25,
      injected: true,
    } as never),
    applicationError("validation", "automation_list_query_invalid"),
  );

  store.record = recordWithSpace("space-2");
  await assert.rejects(
    service.getAutomation(actor, "automation-1"),
    applicationError("notFound", "automation_not_found"),
  );
});

test("builds one provenance-bound ordinary Turn in the compound commit", async () => {
  const events: string[] = [];
  const store = new FakeAutomationStore(events);
  store.context = invocationContext();
  const service = createService(store, events);

  const result = await service.runAutomationNow(actor, runCommand());
  const input = store.invocationInput;
  assert.ok(input !== null);
  assert.deepEqual(events, [
    "authorization.automation:run",
    "store.invocationReceipt",
    "store.invocationContext",
    "authorization.automation:run",
    "authorization.thread:message:append",
    "authorization.run:create",
    "route",
    "store.commitInvocation",
  ]);
  assert.deepEqual(input.definitionFence, {
    automationId: "automation-1",
    expectedRevision: 1,
    expectedDefinitionDigest: definitionRecord().definitionDigest,
  });
  assert.deepEqual(input.threadFence, {
    threadId: "thread-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
    expectedRevision: 3,
    expectedStatus: "active",
    expectedHistorySequence: 2,
    expectedActiveRunId: null,
  });
  assert.deepEqual(input.binding, {
    automationId: "automation-1",
    automationRevision: 1,
    definitionDigest: definitionRecord().definitionDigest,
    instructionDigest: sha256(renderAutomationInstruction(definition())),
    invocationId: "automationInvocation-1",
    runId: "run-1",
    routeDigest: sha256(canonicalJson(route())),
  });
  assert.equal(input.instruction, renderAutomationInstruction(definition()));
  assert.deepEqual(input.message.origin, {
    kind: "automation",
    binding: input.binding,
  });
  assert.equal(input.historyItem.source, "automation_invocation");
  assert.equal(input.historyItem.runId, input.runEvent.identity.runId);
  assert.equal(input.runEvent.data.purpose, "turn");
  assert.equal(input.runEvent.data.goalBinding, null);
  assert.deepEqual(input.runEvent.data.origin, input.message.origin);
  assert.deepEqual(input.workItem.payload, {
    schemaVersion: "crewon.automation-invocation-work-item.v0",
    trigger: "automationInvocation",
    throughSequence: 1,
    binding: input.binding,
  });
  assert.equal(result.runState.purpose, "turn");
  assert.deepEqual(result.binding, input.binding);
});

test("retries an unknown invocation outcome with the same receipt before current state or route", async () => {
  const events: string[] = [];
  const store = new FakeAutomationStore(events);
  store.context = invocationContext();
  store.invocationCommitError = new AutomationStoreError(
    "automation_commit_unknown",
  );
  const service = createService(store, events);

  await assert.rejects(
    service.runAutomationNow(actor, runCommand()),
    applicationError("internal", "automation_commit_unknown"),
  );
  assert.ok(store.invocationInput !== null);
  const originalInput = store.invocationInput;
  store.invocationReceipt = {
    ...invocationResult(originalInput, store.context.record),
    disposition: "replayed",
  };
  store.context = null;
  store.invocationCommitError = null;
  events.length = 0;

  const replay = await service.runAutomationNow(actor, runCommand());

  assert.deepEqual(replay, store.invocationReceipt);
  assert.deepEqual(events, [
    "authorization.automation:run",
    "store.invocationReceipt",
    "authorization.automation:run",
    "authorization.thread:message:append",
    "authorization.run:create",
  ]);
  assert.equal(
    store.lastInvocationReceiptQuery?.idempotency.key,
    originalInput.idempotency.key,
  );
  assert.equal(
    store.lastInvocationReceiptQuery?.idempotency.requestFingerprint,
    originalInput.idempotency.requestFingerprint,
  );
});

test("fails closed on a forged durable invocation receipt", async () => {
  const events: string[] = [];
  const store = new FakeAutomationStore(events);
  store.context = invocationContext();
  const service = createService(store, events);
  const committed = await service.runAutomationNow(actor, runCommand());
  store.invocationReceipt = {
    ...committed,
    disposition: "replayed",
    message: { ...committed.message, content: "forged human turn" },
  };
  events.length = 0;

  await assert.rejects(
    service.runAutomationNow(actor, runCommand()),
    applicationError("internal", "automation_invocation_receipt_invalid"),
  );
  assert.deepEqual(events, [
    "authorization.automation:run",
    "store.invocationReceipt",
  ]);
});

test("rejects a fresh result with a self-consistent substituted route", async () => {
  const store = new FakeAutomationStore([]);
  store.context = invocationContext();
  store.invocationResultMutator = (result) => {
    const routeDigest = sha256(
      canonicalJson({ ...route(), authorityId: "forged-authority" }),
    );
    const binding = { ...result.binding, routeDigest };
    const origin = { kind: "automation" as const, binding };
    return {
      ...result,
      binding,
      runState: {
        ...result.runState,
        authorityId: "forged-authority",
        origin,
      },
      message: { ...result.message, origin },
      historyItem: { ...result.historyItem, origin },
      runEvent: {
        ...result.runEvent,
        data: {
          ...result.runEvent.data,
          authorityId: "forged-authority",
          origin,
        },
      },
      workItem: {
        ...result.workItem,
        payload: { ...result.workItem.payload, binding },
      },
    };
  };

  await assert.rejects(
    createService(store, []).runAutomationNow(actor, runCommand()),
    applicationError("internal", "automation_invocation_result_invalid"),
  );
});

test("rejects legacy invocationId-only Work Items during receipt replay", async () => {
  const store = new FakeAutomationStore([]);
  store.context = invocationContext();
  const service = createService(store, []);
  const committed = await service.runAutomationNow(actor, runCommand());
  store.invocationReceipt = {
    ...committed,
    disposition: "replayed",
    workItem: {
      ...committed.workItem,
      payload: {
        throughSequence: 1,
        automationInvocationId: committed.binding.invocationId,
      } as never,
    },
  };

  await assert.rejects(
    service.runAutomationNow(actor, runCommand()),
    applicationError("internal", "automation_invocation_receipt_invalid"),
  );
});

test("coarse authorization denial performs no Store, route, clock, or ID work", async () => {
  const events: string[] = [];
  const store = new FakeAutomationStore(events);
  let routeCalls = 0;
  let clockCalls = 0;
  let idCalls = 0;
  const service = new AutomationApplicationService({
    store,
    authorization: {
      authorize: async ({ action }) => {
        events.push(`authorization.${action}`);
        return { outcome: "deny" };
      },
    },
    clock: {
      now: () => {
        clockCalls += 1;
        return "2026-08-09T00:00:00Z";
      },
    },
    ids: {
      nextId: () => {
        idCalls += 1;
        return "unexpected-id";
      },
    },
    digester: { sha256 },
    routeResolver: {
      resolveRoute: async () => {
        routeCalls += 1;
        return route();
      },
    },
  });

  await assert.rejects(
    service.runAutomationNow(actor, runCommand()),
    applicationError("authorization", "authorization_denied"),
  );
  assert.deepEqual(events, ["authorization.automation:run"]);
  assert.deepEqual(
    { routeCalls, clockCalls, idCalls },
    { routeCalls: 0, clockCalls: 0, idCalls: 0 },
  );

  events.length = 0;
  await assert.rejects(
    service.getAutomation(actor, "automation-1"),
    applicationError("authorization", "authorization_denied"),
  );
  assert.deepEqual(events, ["authorization.automation:read"]);

  events.length = 0;
  const createDenied = new AutomationApplicationService({
    store,
    authorization: {
      authorize: async ({ action }) => {
        events.push(`authorization.${action}`);
        return action === "thread:message:append"
          ? { outcome: "deny" }
          : { outcome: "allow" };
      },
    },
    clock: {
      now: () => {
        clockCalls += 1;
        return "2026-08-09T00:00:00Z";
      },
    },
    ids: {
      nextId: () => {
        idCalls += 1;
        return "unexpected-id";
      },
    },
    digester: { sha256 },
    routeResolver: {
      resolveRoute: async () => {
        routeCalls += 1;
        return route();
      },
    },
  });
  await assert.rejects(
    createDenied.createAutomation(actor, createCommand()),
    applicationError("authorization", "authorization_denied"),
  );
  assert.deepEqual(events, [
    "authorization.automation:create",
    "authorization.thread:message:append",
  ]);
  assert.deepEqual(
    { routeCalls, clockCalls, idCalls },
    { routeCalls: 0, clockCalls: 0, idCalls: 0 },
  );
});

test("enforces UTF-8 idempotency bounds and maps provider pending to conflict", async () => {
  const oversizedStore = new FakeAutomationStore([]);
  await assert.rejects(
    createService(oversizedStore, []).runAutomationNow(actor, {
      ...runCommand(),
      idempotencyKey: "😀".repeat(65),
    }),
    applicationError("validation", "idempotency_key_invalid"),
  );
  assert.deepEqual(oversizedStore.events, []);

  const pendingStore = new FakeAutomationStore([]);
  pendingStore.invocationReceiptError = new AutomationStoreError(
    "model_provider_settings_switch_pending",
  );
  await assert.rejects(
    createService(pendingStore, []).runAutomationNow(actor, runCommand()),
    applicationError("conflict", "model_provider_settings_switch_pending"),
  );
});

test("fails closed on stale Thread and corrupt frozen definition provenance", async () => {
  const staleStore = new FakeAutomationStore([]);
  staleStore.context = {
    ...invocationContext(),
    thread: { ...invocationContext().thread, revision: 4 },
  };
  await assert.rejects(
    createService(staleStore, []).runAutomationNow(actor, runCommand()),
    applicationError("conflict", "revision_conflict"),
  );
  assert.equal(staleStore.invocationInput, null);

  const corruptStore = new FakeAutomationStore([]);
  corruptStore.context = {
    ...invocationContext(),
    record: {
      ...definitionRecord(),
      definitionDigest: `sha256:${"b".repeat(64)}`,
    },
  };
  await assert.rejects(
    createService(corruptStore, []).runAutomationNow(actor, runCommand()),
    applicationError("internal", "automation_record_invalid"),
  );
  assert.equal(corruptStore.invocationInput, null);
});

test("rejects caller-supplied invocation provenance fields", async () => {
  const store = new FakeAutomationStore([]);
  await assert.rejects(
    createService(store, []).runAutomationNow(actor, {
      ...runCommand(),
      invocationId: "forged",
      definitionDigest: `sha256:${"a".repeat(64)}`,
      occurredAt: "2026-08-09T00:00:00Z",
    } as never),
    applicationError("validation", "automation_run_command_invalid"),
  );
  assert.deepEqual(store.events, []);
});

class FakeAutomationStore implements AutomationStore {
  readonly events: string[];
  createReceipt: AutomationCreateResult | null = null;
  invocationReceipt: AutomationInvocationResult | null = null;
  context: AutomationInvocationContext | null = null;
  record: AutomationDefinitionRecord | null = null;
  records: AutomationDefinitionRecord[] = [];
  createInput: CommitAutomationCreateInput | null = null;
  invocationInput: CommitAutomationInvocationInput | null = null;
  invocationCommitError: AutomationStoreError | null = null;
  invocationReceiptError: AutomationStoreError | null = null;
  invocationResultMutator:
    | ((result: AutomationInvocationResult) => AutomationInvocationResult)
    | null = null;
  lastInvocationReceiptQuery: AutomationInvocationReceiptQuery | null = null;

  constructor(events: string[]) {
    this.events = events;
  }

  async loadAutomationCreateReceipt(
    _query: AutomationCreateReceiptQuery,
  ): Promise<AutomationCreateResult | null> {
    this.events.push("store.createReceipt");
    return structuredClone(this.createReceipt);
  }

  async commitAutomationCreate(
    input: CommitAutomationCreateInput,
  ): Promise<AutomationCreateResult> {
    this.events.push("store.commitCreate");
    this.createInput = structuredClone(input);
    return { disposition: "committed", record: structuredClone(input.record) };
  }

  async loadAutomation(_locator: AutomationLocator) {
    this.events.push("store.load");
    return structuredClone(this.record);
  }

  async listAutomations(_query: AutomationListQuery) {
    this.events.push("store.list");
    return structuredClone(this.records);
  }

  async loadAutomationInvocationReceipt(
    query: AutomationInvocationReceiptQuery,
  ): Promise<AutomationInvocationResult | null> {
    this.events.push("store.invocationReceipt");
    if (this.invocationReceiptError !== null) throw this.invocationReceiptError;
    this.lastInvocationReceiptQuery = structuredClone(query);
    return structuredClone(this.invocationReceipt);
  }

  async loadAutomationInvocationContext(
    _locator: AutomationLocator,
  ): Promise<AutomationInvocationContext | null> {
    this.events.push("store.invocationContext");
    return structuredClone(this.context);
  }

  async commitAutomationInvocation(
    input: CommitAutomationInvocationInput,
  ): Promise<AutomationInvocationResult> {
    this.events.push("store.commitInvocation");
    this.invocationInput = structuredClone(input);
    const canonicalResult = invocationResult(input, this.context!.record);
    if (this.invocationCommitError !== null) throw this.invocationCommitError;
    return this.invocationResultMutator?.(canonicalResult) ?? canonicalResult;
  }
}

function createService(store: FakeAutomationStore, events: string[]) {
  const ids = new SequentialIds();
  const authorization: AutomationAuthorizationPort = {
    authorize: async ({ action }) => {
      events.push(`authorization.${action}`);
      return { outcome: "allow" };
    },
  };
  return new AutomationApplicationService({
    store,
    authorization,
    clock: { now: () => "2026-08-09T00:00:00Z" },
    ids,
    digester: { sha256 },
    routeResolver: {
      resolveRoute: async () => {
        events.push("route");
        return route();
      },
    },
  });
}

class SequentialIds implements AutomationApplicationIdGenerator {
  readonly #counts = new Map<string, number>();

  nextId(kind: Parameters<AutomationApplicationIdGenerator["nextId"]>[0]) {
    const count = (this.#counts.get(kind) ?? 0) + 1;
    this.#counts.set(kind, count);
    return `${kind}-${count}`;
  }
}

function createCommand(): CreateAutomationCommand {
  return {
    kind: "automation.create",
    idempotencyKey: "automation-create-1",
    threadId: "thread-1",
    expectedThreadRevision: 3,
    title: "Daily summary",
    prompt: "Summarize the project.",
    requestedAgentVersionId: null,
    schedule: {
      scheduleType: "daily",
      nextRunAt: "2026-08-10T10:00:00Z",
      intervalSeconds: 86_400,
      time: "18:00",
      weekday: 0,
      timezone: "Asia/Shanghai",
    },
  };
}

function runCommand(): RunAutomationNowCommand {
  return {
    kind: "automation.runNow",
    idempotencyKey: "automation-run-1",
    automationId: "automation-1",
    expectedAutomationRevision: 1,
    expectedThreadRevision: 3,
  };
}

function definition(): AutomationDefinition {
  return createAutomationDefinition({
    automationId: "automation-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
    createdByActorId: "actor-1",
    threadId: "thread-1",
    title: "Daily summary",
    prompt: "Summarize the project.",
    agentVersionId: "agent-version-1",
    schedule: createCommand().schedule,
    createdAt: "2026-08-09T00:00:00Z",
  });
}

function definitionRecord(): AutomationDefinitionRecord {
  const value = definition();
  return { definition: value, definitionDigest: sha256(canonicalJson(value)) };
}

function recordWithSpace(spaceId: string) {
  const current = definition();
  const value = createAutomationDefinition({
    automationId: current.automationId,
    tenantId: current.tenantId,
    spaceId,
    createdByActorId: current.createdByActorId,
    threadId: current.threadId,
    title: current.title,
    prompt: current.prompt,
    agentVersionId: current.agentVersionId,
    schedule: current.schedule,
    createdAt: current.createdAt,
  });
  return { definition: value, definitionDigest: sha256(canonicalJson(value)) };
}

function invocationContext(): AutomationInvocationContext {
  return {
    record: definitionRecord(),
    thread: {
      threadId: "thread-1",
      tenantId: "tenant-1",
      spaceId: "space-1",
      createdByActorId: "actor-1",
      title: "Automation result",
      status: "active",
      revision: 3,
      lastEventSequence: 3,
      lastMessageSequence: 1,
      createdAt: "2026-08-08T00:00:00Z",
      updatedAt: "2026-08-08T00:00:01Z",
      archivedAt: null,
      deletedAt: null,
      deletedByActorId: null,
      forkedFromThreadId: null,
      forkedThroughHistorySequence: null,
    },
    historyHead: {
      tenantId: "tenant-1",
      threadId: "thread-1",
      lastSequence: 2,
    },
  };
}

function invocationResult(
  input: CommitAutomationInvocationInput,
  record: AutomationDefinitionRecord,
): AutomationInvocationResult {
  const event = input.runEvent;
  return {
    disposition: "committed",
    record: structuredClone(record),
    binding: structuredClone(input.binding),
    threadState: {
      ...invocationContext().thread,
      revision: input.threadFence.expectedRevision + 1,
      lastEventSequence: input.threadEvent.sequence,
      lastMessageSequence: input.message.sequence,
      updatedAt: input.message.createdAt,
    },
    runState: {
      runId: event.identity.runId,
      threadId: event.data.threadId,
      tenantId: event.data.tenantId,
      spaceId: event.data.spaceId,
      createdByActorId: event.data.createdByActorId,
      authorityId: event.data.authorityId,
      runtimeGeneration: event.data.runtimeGeneration,
      agentVersionId: event.data.agentVersionId,
      policySnapshotId: event.data.policySnapshotId,
      workspaceBindingId: event.data.workspaceBindingId,
      collaborationMode: event.data.collaborationMode,
      purpose: "turn",
      origin: event.data.origin,
      goalBinding: null,
      goalAccounting: null,
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      status: "queued",
      revision: 1,
      lastSequence: 1,
      cancelRequested: false,
      waitingApproval: null,
      suspensionReasonCode: null,
      reconciliationReceiptId: null,
      outputRef: null,
      failure: null,
      createdAt: event.occurredAt,
      updatedAt: event.occurredAt,
      terminalAt: null,
    },
    threadEvent: structuredClone(input.threadEvent),
    message: structuredClone(input.message),
    historyItem: structuredClone(input.historyItem),
    runEvent: structuredClone(input.runEvent),
    outbox: structuredClone(input.outbox),
    workItem: structuredClone(input.workItem),
  };
}

function route() {
  return {
    authorityId: "authority-1",
    runtimeGeneration: "generation-1",
    agentVersionId: "agent-version-1",
    policySnapshotId: "policy-1",
    workspaceBindingId: null,
  };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function applicationError(category: string, code: string) {
  return (error: unknown) =>
    error instanceof ApplicationError &&
    error.category === category &&
    error.code === code;
}
