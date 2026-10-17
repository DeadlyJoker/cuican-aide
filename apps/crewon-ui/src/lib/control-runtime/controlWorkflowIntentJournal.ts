import {
  parseStartWorkflowRunRequest,
  parseCancelRunRequest,
  parseReviewWorkflowHumanGateRequest,
  parseWorkflowGateLocator,
  parseWorkflowRecoveryContextId,
  parseWorkflowVersionId,
  parseIdempotencyKey,
  parseRunId,
  parseThreadId,
  type StartWorkflowRunRequest,
  type CancelRunRequest,
  type ReviewWorkflowHumanGateRequest,
  type WorkflowGateLocator,
} from "@crewon/contracts";

export type WorkflowIntentCommand =
  | Readonly<{ kind: "start"; body: StartWorkflowRunRequest }>
  | Readonly<{ kind: "cancel"; runId: string; body: CancelRunRequest }>
  | Readonly<{
      kind: "review";
      locator: WorkflowGateLocator;
      body: ReviewWorkflowHumanGateRequest;
    }>;
export type WorkflowIntent = Readonly<{
  version: "v1";
  id: string;
  contextId: string;
  workflowVersionId: string;
  threadId: string;
  createdAt: string;
  command: WorkflowIntentCommand;
}>;
export type WorkflowIntentStorage = Pick<
  Storage,
  "length" | "key" | "getItem" | "setItem" | "removeItem"
>;
const PREFIX = "crewon.workflow.intent.v1.";
const MAX_ENTRY_BYTES = 65536;
const MAX_DISCOVERY_KEYS = 4096;
const MAX_DISCOVERY_INTENTS = 32;

export class WorkflowIntentJournalError extends Error {
  readonly code:
    | "workflow_intent_corrupt"
    | "workflow_intent_capacity"
    | "workflow_intent_storage_unavailable"
    | "workflow_intent_changed"
    | "workflow_intent_missing";
  constructor(code: WorkflowIntentJournalError["code"]) {
    super(code);
    this.name = "WorkflowIntentJournalError";
    this.code = code;
  }
}

/** Immutable, separate storage keys avoid cross-window read/modify/write loss.
 * Entries are recovery data, not permission, proof of dispatch, or a Run registry.
 */
export class ControlWorkflowIntentJournal {
  readonly #storage: () => WorkflowIntentStorage;
  readonly #nextId: () => string;
  readonly #now: () => string;
  constructor(
    input: {
      storage?: () => WorkflowIntentStorage;
      nextId?: () => string;
      now?: () => string;
    } = {},
  ) {
    this.#storage = input.storage ?? (() => globalThis.localStorage);
    this.#nextId =
      input.nextId ?? (() => `workflow-intent.${crypto.randomUUID()}`);
    this.#now = input.now ?? (() => new Date().toISOString());
  }

  create(input: {
    contextId: string;
    workflowVersionId: string;
    threadId: string;
    command: WorkflowIntentCommand;
  }): WorkflowIntent {
    const intent = parseIntent({
      version: "v1",
      id: this.#nextId(),
      contextId: input.contextId,
      workflowVersionId: input.workflowVersionId,
      threadId: input.threadId,
      createdAt: this.#now(),
      command: input.command,
    });
    const encoded = encode(intent);
    const storage = this.#open();
    // Capacity bounds discovery/output. Concurrent tabs may reach the bound
    // together; discovery refuses overflow rather than silently dropping data.
    if (this.#entries(storage).length >= MAX_DISCOVERY_INTENTS)
      throw new WorkflowIntentJournalError("workflow_intent_capacity");
    const key = PREFIX + intent.id;
    try {
      if (storage.getItem(key) !== null)
        throw new WorkflowIntentJournalError("workflow_intent_changed");
      storage.setItem(key, encoded);
      if (storage.getItem(key) !== encoded)
        throw new WorkflowIntentJournalError("workflow_intent_changed");
    } catch (error) {
      throw storageError(error);
    }
    return structuredClone(intent);
  }

  get(id: string): WorkflowIntent {
    parseIdempotencyKey(id);
    let encoded: string | null;
    try {
      encoded = this.#open().getItem(PREFIX + id);
    } catch (error) {
      throw storageError(error);
    }
    if (encoded === null)
      throw new WorkflowIntentJournalError("workflow_intent_missing");
    const intent = decode(encoded);
    if (intent.id !== id)
      throw new WorkflowIntentJournalError("workflow_intent_corrupt");
    return intent;
  }

  list(contextId: string): readonly WorkflowIntent[] {
    const context = parseWorkflowRecoveryContextId(contextId);
    return this.#entries(this.#open()).filter(
      (intent) => intent.contextId === context,
    );
  }

  /** Only an observed, validated server result may acknowledge an intent. */
  acknowledge(intent: WorkflowIntent): void {
    const encoded = encode(parseIntent(intent));
    const key = PREFIX + intent.id,
      storage = this.#open();
    try {
      const current = storage.getItem(key);
      if (current === null) return; // Another window already acknowledged it.
      if (encode(decode(current)) !== encoded)
        throw new WorkflowIntentJournalError("workflow_intent_changed");
      storage.removeItem(key);
      if (storage.getItem(key) !== null)
        throw new WorkflowIntentJournalError("workflow_intent_changed");
    } catch (error) {
      throw storageError(error);
    }
  }

  #open(): WorkflowIntentStorage {
    try {
      const storage = this.#storage();
      if (!storage) throw new Error("storage missing");
      return storage;
    } catch (error) {
      throw storageError(error);
    }
  }
  #entries(storage: WorkflowIntentStorage): WorkflowIntent[] {
    try {
      const length = storage.length;
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > MAX_DISCOVERY_KEYS
      )
        throw new WorkflowIntentJournalError("workflow_intent_capacity");
      const keys = new Set<string>();
      for (let index = 0; index < length; index++) {
        const key = storage.key(index);
        if (key?.startsWith(PREFIX)) keys.add(key);
        if (keys.size > MAX_DISCOVERY_INTENTS)
          throw new WorkflowIntentJournalError("workflow_intent_capacity");
      }
      const entries: WorkflowIntent[] = [];
      for (const key of keys) {
        const encoded = storage.getItem(key);
        if (encoded === null) continue; // An independent acknowledgement.
        const intent = decode(encoded);
        if (key !== PREFIX + intent.id)
          throw new WorkflowIntentJournalError("workflow_intent_corrupt");
        entries.push(intent);
      }
      return entries;
    } catch (error) {
      throw storageError(error);
    }
  }
}

function storageError(error: unknown): WorkflowIntentJournalError {
  return error instanceof WorkflowIntentJournalError
    ? error
    : new WorkflowIntentJournalError("workflow_intent_storage_unavailable");
}
function encode(value: WorkflowIntent): string {
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).byteLength > MAX_ENTRY_BYTES)
    throw new WorkflowIntentJournalError("workflow_intent_capacity");
  return text;
}
function decode(text: string): WorkflowIntent {
  try {
    if (
      text.length > MAX_ENTRY_BYTES ||
      new TextEncoder().encode(text).byteLength > MAX_ENTRY_BYTES
    )
      throw Error("oversized");
    return parseIntent(JSON.parse(text));
  } catch (error) {
    if (error instanceof WorkflowIntentJournalError) throw error;
    throw new WorkflowIntentJournalError("workflow_intent_corrupt");
  }
}
function fields(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== keys.length
  )
    invalid();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !Object.hasOwn(field, "value")) invalid();
    result[key] = field.value;
  }
  return result;
}
function parseIntent(value: unknown): WorkflowIntent {
  const row = fields(captureData(value), [
    "version",
    "id",
    "contextId",
    "workflowVersionId",
    "threadId",
    "createdAt",
    "command",
  ]);
  if (
    row.version !== "v1" ||
    typeof row.createdAt !== "string" ||
    !Number.isFinite(Date.parse(row.createdAt)) ||
    new Date(row.createdAt).toISOString() !== row.createdAt
  )
    invalid();
  const workflowVersionId = parseWorkflowVersionId(row.workflowVersionId);
  const threadId = parseThreadId(row.threadId);
  const commandRow = fields(row.command, commandKeys(row.command));
  let command: WorkflowIntentCommand;
  switch (commandRow.kind) {
    case "start": {
      const body = parseStartWorkflowRunRequest(commandRow.body);
      if (
        body.workflowVersionId !== workflowVersionId ||
        body.threadId !== threadId
      )
        invalid();
      command = { kind: "start", body };
      break;
    }
    case "cancel":
      command = {
        kind: "cancel",
        runId: parseRunId(commandRow.runId),
        body: parseCancelRunRequest(commandRow.body),
      };
      break;
    case "review":
      command = {
        kind: "review",
        locator: parseWorkflowGateLocator(commandRow.locator),
        body: parseReviewWorkflowHumanGateRequest(commandRow.body),
      };
      break;
    default:
      return invalid();
  }
  return {
    version: "v1",
    id: parseIdempotencyKey(row.id),
    contextId: parseWorkflowRecoveryContextId(row.contextId),
    workflowVersionId,
    threadId,
    createdAt: row.createdAt,
    command,
  };
}
function commandKeys(value: unknown): readonly string[] {
  const kind =
    value && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "kind")
      : undefined;
  if (!kind || !Object.hasOwn(kind, "value")) invalid();
  switch (kind.value) {
    case "start":
      return ["kind", "body"];
    case "cancel":
      return ["kind", "runId", "body"];
    case "review":
      return ["kind", "locator", "body"];
    default:
      return invalid();
  }
}
function invalid(): never {
  throw new WorkflowIntentJournalError("workflow_intent_corrupt");
}

/** Bound traversal before JSON serialization; never invoke accessors/toJSON. */
function captureData(value: unknown): unknown {
  let nodes = 0,
    bytes = 0;
  const path = new Set<object>();
  const measure = (text: string) => {
    if (
      text.length > MAX_ENTRY_BYTES ||
      (bytes += new TextEncoder().encode(text).byteLength) > MAX_ENTRY_BYTES
    )
      invalid();
  };
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > 2048 || depth > 16) invalid();
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      measure(value);
      return value;
    }
    if (!value || typeof value !== "object" || path.has(value)) invalid();
    path.add(value);
    let result: unknown;
    const names = Reflect.ownKeys(value);
    if (Array.isArray(value)) {
      if (value.length > 256 || names.length !== value.length + 1) invalid();
      result = Array.from({ length: value.length }, (_, index) => {
        const field = Object.getOwnPropertyDescriptor(value, String(index));
        if (!field?.enumerable || !Object.hasOwn(field, "value")) invalid();
        return visit(field.value, depth + 1);
      });
    } else {
      if (
        ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
        names.length > 256
      )
        invalid();
      result = Object.fromEntries(
        names.map((key) => {
          if (typeof key !== "string") invalid();
          measure(key);
          const field = Object.getOwnPropertyDescriptor(value, key);
          if (!field?.enumerable || !Object.hasOwn(field, "value")) invalid();
          return [key, visit(field.value, depth + 1)];
        }),
      );
    }
    path.delete(value);
    return result;
  };
  return visit(value, 0);
}
