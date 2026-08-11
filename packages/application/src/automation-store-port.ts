import type {
  AutomationDefinition,
  AutomationInvocationBinding,
  AutomationInvocationOrigin,
  AutomationSchedule,
  ModelHistoryHead,
  ModelHistoryItem,
  RunLifecycleEvent,
  RunState,
  ThreadLifecycleEvent,
  ThreadState,
} from "@crewon/domain";
import {
  AutomationDefinitionError,
  parseAutomationSchedule,
} from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import type {
  ActorContext,
  RunAuthorizationAction,
  RunAuthorizationResource,
  ThreadAuthorizationAction,
  ThreadAuthorizationResource,
} from "./authorization-port.ts";
import type { AutomationInvocationWorkItemPayload } from "./durable-queue-port.ts";
import type {
  IdempotencyDescriptor,
  OutboxMessage,
  WorkItem,
} from "./run-store-port.ts";
import type { RunRoute } from "./run-commands.ts";
import type { MessageRecord } from "./thread-store-port.ts";

export type AutomationApplicationIdKind =
  | "automation"
  | "automationInvocation"
  | "run"
  | "runEvent"
  | "outboxMessage"
  | "workItem"
  | "message"
  | "threadEvent"
  | "modelHistoryItem";

export interface AutomationApplicationIdGenerator {
  nextId(kind: AutomationApplicationIdKind): string;
}

export type AutomationAuthorizationAction =
  | "automation:create"
  | "automation:read"
  | "automation:run"
  | Extract<ThreadAuthorizationAction, "thread:message:append">
  | Extract<RunAuthorizationAction, "run:create">;

export type AutomationAuthorizationResource = Readonly<{
  kind: "automation";
  tenantId: string;
  spaceId: string;
  automationId: string | null;
  threadId: string | null;
}>;

export type AutomationAuthorizationRequestResource =
  | AutomationAuthorizationResource
  | ThreadAuthorizationResource
  | RunAuthorizationResource;

export interface AutomationAuthorizationPort {
  /**
   * `automation:run` is the coarse authority for producing the invocation's
   * bound Thread Message and Run; the service additionally checks the exact
   * Thread write and Run-create resources after receipt replay misses.
   */
  authorize(request: {
    actor: ActorContext;
    action: AutomationAuthorizationAction;
    resource: AutomationAuthorizationRequestResource;
  }): Promise<Readonly<{ outcome: "allow" }> | Readonly<{ outcome: "deny" }>>;
}

export type CreateAutomationCommand = Readonly<{
  kind: "automation.create";
  idempotencyKey: string;
  threadId: string;
  expectedThreadRevision: number;
  title: string;
  prompt: string;
  requestedAgentVersionId: string | null;
  schedule: AutomationSchedule;
}>;

export type RunAutomationNowCommand = Readonly<{
  kind: "automation.runNow";
  idempotencyKey: string;
  automationId: string;
  expectedAutomationRevision: 1;
  expectedThreadRevision: number;
}>;

export type AutomationDefinitionRecord = Readonly<{
  definition: AutomationDefinition;
  definitionDigest: string;
}>;

export type AutomationLocator = Readonly<{
  tenantId: string;
  spaceId: string;
  automationId: string;
}>;

export type AutomationListCursor = Readonly<{
  updatedAt: string;
  automationId: string;
}>;

export type AutomationListQuery = Readonly<{
  tenantId: string;
  spaceId: string;
  before: AutomationListCursor | null;
  limit: number;
}>;

export type AutomationThreadFence = Readonly<{
  threadId: string;
  tenantId: string;
  spaceId: string;
  expectedRevision: number;
  expectedStatus: "active";
}>;

export type AutomationCreateResult = Readonly<{
  disposition: "committed" | "replayed";
  record: AutomationDefinitionRecord;
}>;

export type AutomationCreateReceiptQuery = Readonly<{
  tenantId: string;
  idempotency: IdempotencyDescriptor;
}>;

export type CommitAutomationCreateInput = Readonly<{
  tenantId: string;
  idempotency: IdempotencyDescriptor;
  threadFence: AutomationThreadFence;
  record: AutomationDefinitionRecord;
}>;

export type AutomationInvocationMessage = MessageRecord &
  Readonly<{ origin: AutomationInvocationOrigin }>;

export type AutomationInvocationHistoryItem = Extract<
  ModelHistoryItem,
  { type: "message"; source: "automation_invocation" }
>;

type RunCreatedEvent = Extract<RunLifecycleEvent, { type: "run.created" }>;

export type AutomationRunCreatedEvent = Omit<RunCreatedEvent, "data"> &
  Readonly<{
    data: RunCreatedEvent["data"] &
      Readonly<{
        purpose: "turn";
        origin: AutomationInvocationOrigin;
      }>;
  }>;

export type AutomationInvocationRunState = RunState &
  Readonly<{
    purpose: "turn";
    origin: AutomationInvocationOrigin;
  }>;

export type AutomationInvocationWorkItem = Omit<WorkItem, "payload"> &
  Readonly<{ payload: AutomationInvocationWorkItemPayload }>;

export type AutomationInvocationContext = Readonly<{
  record: AutomationDefinitionRecord;
  thread: ThreadState;
  historyHead: ModelHistoryHead;
}>;

export type AutomationInvocationResult = Readonly<{
  disposition: "committed" | "replayed";
  record: AutomationDefinitionRecord;
  binding: AutomationInvocationBinding;
  threadState: ThreadState;
  runState: AutomationInvocationRunState;
  threadEvent: Extract<
    ThreadLifecycleEvent,
    { type: "thread.message.appended" }
  >;
  message: AutomationInvocationMessage;
  historyItem: AutomationInvocationHistoryItem;
  runEvent: AutomationRunCreatedEvent;
  outbox: OutboxMessage;
  workItem: AutomationInvocationWorkItem;
}>;

export type AutomationInvocationReceiptQuery = Readonly<{
  tenantId: string;
  automationId: string;
  idempotency: IdempotencyDescriptor;
}>;

export type CommitAutomationInvocationInput = Readonly<{
  tenantId: string;
  spaceId: string;
  idempotency: IdempotencyDescriptor;
  definitionFence: Readonly<{
    automationId: string;
    expectedRevision: 1;
    expectedDefinitionDigest: string;
  }>;
  threadFence: AutomationThreadFence &
    Readonly<{
      expectedHistorySequence: number;
      expectedActiveRunId: null;
    }>;
  binding: AutomationInvocationBinding;
  instruction: string;
  threadEvent: AutomationInvocationResult["threadEvent"];
  message: AutomationInvocationMessage;
  historyItem: AutomationInvocationHistoryItem;
  runEvent: AutomationRunCreatedEvent;
  outbox: OutboxMessage;
  workItem: AutomationInvocationWorkItem;
}>;

/**
 * Compound Automation authority.
 *
 * Implementations must replay receipts before acquiring definition, Thread, or
 * Run locks. First-time creates atomically validate the exact active Thread
 * fence and commit the definition plus receipt. First-time invocations
 * atomically validate both definition and Thread fences, reject an active Run,
 * and commit Message, history, Run, Outbox, WorkItem, and receipt together.
 * Automation Work Items use the canonical payload and must be validated with
 * the Store's `automationInvocation` payload kind.
 */
export interface AutomationStore {
  loadAutomationCreateReceipt(
    query: AutomationCreateReceiptQuery,
  ): Promise<AutomationCreateResult | null>;
  commitAutomationCreate(
    input: CommitAutomationCreateInput,
  ): Promise<AutomationCreateResult>;
  loadAutomation(
    locator: AutomationLocator,
  ): Promise<AutomationDefinitionRecord | null>;
  listAutomations(
    query: AutomationListQuery,
  ): Promise<readonly AutomationDefinitionRecord[]>;
  loadAutomationInvocationReceipt(
    query: AutomationInvocationReceiptQuery,
  ): Promise<AutomationInvocationResult | null>;
  loadAutomationInvocationContext(
    locator: AutomationLocator,
  ): Promise<AutomationInvocationContext | null>;
  commitAutomationInvocation(
    input: CommitAutomationInvocationInput,
  ): Promise<AutomationInvocationResult>;
}

export class AutomationStoreError extends Error {
  readonly code: string;

  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "AutomationStoreError";
    this.code = code;
  }
}

export function validateAutomationCreateCommand(
  command: CreateAutomationCommand,
): void {
  requireAutomationExactObject(
    command,
    [
      "expectedThreadRevision",
      "idempotencyKey",
      "kind",
      "prompt",
      "requestedAgentVersionId",
      "schedule",
      "threadId",
      "title",
    ],
    "automation_create_command_invalid",
  );
  if (command.kind !== "automation.create") {
    throw new ApplicationError(
      "validation",
      "automation_create_command_invalid",
    );
  }
  requireAutomationIdempotencyKey(command.idempotencyKey);
  requireAutomationOpaqueId(command.threadId, "thread_id_invalid");
  requireAutomationRevision(command.expectedThreadRevision);
  if (typeof command.title !== "string" || typeof command.prompt !== "string") {
    throw new ApplicationError(
      "validation",
      "automation_create_command_invalid",
    );
  }
  if (command.requestedAgentVersionId !== null) {
    requireAutomationOpaqueId(
      command.requestedAgentVersionId,
      "agent_version_id_invalid",
    );
  }
  try {
    parseAutomationSchedule(command.schedule);
  } catch (error) {
    throw mapAutomationError(error);
  }
}

export function validateAutomationRunNowCommand(
  command: RunAutomationNowCommand,
): void {
  requireAutomationExactObject(
    command,
    [
      "automationId",
      "expectedAutomationRevision",
      "expectedThreadRevision",
      "idempotencyKey",
      "kind",
    ],
    "automation_run_command_invalid",
  );
  if (
    command.kind !== "automation.runNow" ||
    command.expectedAutomationRevision !== 1
  ) {
    throw new ApplicationError("validation", "automation_run_command_invalid");
  }
  requireAutomationIdempotencyKey(command.idempotencyKey);
  requireAutomationOpaqueId(command.automationId, "automation_id_invalid");
  requireAutomationRevision(command.expectedThreadRevision);
}

export function validateAutomationListQuery(
  query: Readonly<{
    before: AutomationListCursor | null;
    limit: number;
  }>,
): void {
  requireAutomationExactObject(
    query,
    ["before", "limit"],
    "automation_list_query_invalid",
  );
  if (
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > 100
  ) {
    throw new ApplicationError("validation", "automation_limit_invalid");
  }
  if (query.before !== null) {
    requireAutomationExactObject(
      query.before,
      ["automationId", "updatedAt"],
      "automation_cursor_invalid",
    );
    requireAutomationOpaqueId(
      query.before.automationId,
      "automation_cursor_invalid",
    );
    if (!isAutomationTimestamp(query.before.updatedAt)) {
      throw new ApplicationError("validation", "automation_cursor_invalid");
    }
  }
}

export function validateAutomationActor(actor: ActorContext): void {
  requireAutomationExactObject(
    actor,
    ["actorId", "principalId", "spaceId", "tenantId"],
    "actor_context_invalid",
  );
  requireAutomationOpaqueId(actor.principalId, "principal_id_invalid");
  requireAutomationOpaqueId(actor.actorId, "actor_id_invalid");
  requireAutomationOpaqueId(actor.tenantId, "tenant_id_invalid");
  requireAutomationOpaqueId(actor.spaceId, "space_id_invalid");
}

export function validateAutomationRoute(
  route: RunRoute,
  requestedAgentVersionId: string | null,
): void {
  requireAutomationExactObject(
    route,
    [
      "agentVersionId",
      "authorityId",
      "policySnapshotId",
      "runtimeGeneration",
      "workspaceBindingId",
    ],
    "run_route_invalid",
  );
  requireAutomationOpaqueId(route.authorityId, "authority_id_invalid");
  requireAutomationOpaqueId(
    route.runtimeGeneration,
    "runtime_generation_invalid",
  );
  requireAutomationOpaqueId(route.agentVersionId, "agent_version_id_invalid");
  requireAutomationOpaqueId(
    route.policySnapshotId,
    "policy_snapshot_id_invalid",
  );
  if (route.workspaceBindingId !== null) {
    requireAutomationOpaqueId(
      route.workspaceBindingId,
      "workspace_binding_id_invalid",
    );
  }
  if (
    requestedAgentVersionId !== null &&
    route.agentVersionId !== requestedAgentVersionId
  ) {
    throw new ApplicationError(
      "validation",
      "agent_version_selection_mismatch",
    );
  }
}

export function requireAutomationOpaqueId(
  value: unknown,
  code: string,
  category: "validation" | "internal" = "validation",
): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)
  ) {
    throw new ApplicationError(category, code);
  }
}

function requireAutomationIdempotencyKey(
  value: unknown,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new ApplicationError("validation", "idempotency_key_invalid");
  }
}

export function mapAutomationError(
  error: unknown,
  fallbackCategory: "validation" | "internal" = "validation",
): ApplicationError {
  if (error instanceof ApplicationError) return error;
  if (error instanceof AutomationDefinitionError) {
    return new ApplicationError(fallbackCategory, error.code, { cause: error });
  }
  const code =
    error instanceof AutomationStoreError ? error.code : "automation_internal";
  if (error instanceof AutomationStoreError) {
    if (code === "automation_not_found") {
      return new ApplicationError("notFound", code, { cause: error });
    }
    if (
      code === "model_provider_settings_switch_pending" ||
      code.endsWith("_conflict") ||
      code.endsWith("_not_active")
    ) {
      return new ApplicationError("conflict", code, { cause: error });
    }
  }
  return new ApplicationError("internal", code, {
    cause: error instanceof Error ? error : undefined,
  });
}

export function isAutomationDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

export function isAutomationTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function requireAutomationRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ApplicationError("validation", "expected_revision_invalid");
  }
}

function requireAutomationExactObject(
  value: unknown,
  expectedKeys: readonly string[],
  code: string,
): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new ApplicationError("validation", code);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new ApplicationError("validation", code);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
