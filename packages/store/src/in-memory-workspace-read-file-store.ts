import {
  RunStoreError,
  type IdempotencyDescriptor,
  type PrepareWorkspaceReadFileActionInput,
  type PrepareWorkspaceReadFileInput,
  type WorkspaceReadFileLocator,
  type WorkspaceReadFileMutationResult,
  type WorkspaceReadFileReceiptQuery,
  type WorkspaceReadFileRecord,
  type WorkspaceReadFileStore,
} from "@crewon/application";

import {
  exactResolution,
  validateFrozenWorkspaceReadFileDispatch,
  validateWorkspaceReadFileLocator,
  validateWorkspaceReadFileRecord,
  withResolution,
} from "./workspace-read-file-store-support.ts";

type Receipt = Readonly<{ fingerprint: string; executionKey: string }>;

export class InMemoryWorkspaceReadFileStore implements WorkspaceReadFileStore {
  readonly #operations = new Map<string, WorkspaceReadFileRecord>();
  readonly #receipts = new Map<string, Receipt>();

  async loadWorkspaceReadFileReceipt(query: WorkspaceReadFileReceiptQuery) {
    const receipt = this.#receipts.get(receiptKey(query.tenantId, query.spaceId, query.phase, query.idempotency));
    if (receipt === undefined) return null;
    requireFingerprint(receipt, query.idempotency);
    return result("replayed", this.#required(receipt.executionKey));
  }

  async prepareWorkspaceReadFile(input: PrepareWorkspaceReadFileInput) {
    const locator = validateWorkspaceReadFileLocator(locatorOf(input));
    const key = executionKey(locator);
    const rKey = receiptKey(locator.tenantId, locator.spaceId, "execute", input.idempotency);
    const receipt = this.#receipts.get(rKey);
    if (receipt !== undefined) {
      requireFingerprint(receipt, input.idempotency);
      return result("replayed", this.#required(receipt.executionKey));
    }
    const frozen = validateFrozenWorkspaceReadFileDispatch(input.frozen);
    const existing = this.#operations.get(key);
    if (existing !== undefined) {
      if (JSON.stringify(existing.frozen) !== JSON.stringify(frozen)) conflict();
      this.#receipts.set(rKey, { fingerprint: input.idempotency.requestFingerprint, executionKey: key });
      return result("replayed", existing);
    }
    const operation = validateWorkspaceReadFileRecord({
      schemaVersion: "crewon.workspace-read-file-operation.v0",
      ...locator,
      revision: 1,
      status: "prepared",
      frozen,
      resolution: null,
    });
    this.#operations.set(key, operation);
    this.#receipts.set(rKey, { fingerprint: input.idempotency.requestFingerprint, executionKey: key });
    return result("committed", operation);
  }

  async prepareWorkspaceReadFileAction(input: PrepareWorkspaceReadFileActionInput) {
    const locator = validateWorkspaceReadFileLocator(locatorOf(input));
    const key = executionKey(locator);
    const operation = this.#required(key);
    const rKey = receiptKey(locator.tenantId, locator.spaceId, input.phase, input.idempotency);
    const receipt = this.#receipts.get(rKey);
    if (receipt !== undefined) {
      requireFingerprint(receipt, input.idempotency);
      return result("replayed", this.#required(receipt.executionKey));
    }
    this.#receipts.set(rKey, { fingerprint: input.idempotency.requestFingerprint, executionKey: key });
    return result("committed", operation);
  }

  async markWorkspaceReadFilePossiblySent(input: WorkspaceReadFileLocator & { expectedRevision: number }) {
    const current = this.#expected(input);
    if (current.resolution !== null || current.status === "possiblySent") return structuredClone(current);
    const next = validateWorkspaceReadFileRecord({ ...current, revision: current.revision + 1, status: "possiblySent" });
    this.#operations.set(executionKey(input), next);
    return structuredClone(next);
  }

  async abandonWorkspaceReadFileSend(input: WorkspaceReadFileLocator & { expectedRevision: number }) {
    const current = this.#expected(input);
    if (current.status !== "possiblySent" || current.resolution !== null) conflict();
    const next = validateWorkspaceReadFileRecord({ ...current, revision: current.revision + 1, status: "prepared" });
    this.#operations.set(executionKey(input), next);
    return structuredClone(next);
  }

  async commitWorkspaceReadFileResolution(input: Parameters<WorkspaceReadFileStore["commitWorkspaceReadFileResolution"]>[0]) {
    const key = executionKey(input);
    const current = this.#required(key);
    if (current.resolution !== null) {
      const parsed = exactResolution(current, input.phase, input.resolution);
      if (JSON.stringify(parsed) !== JSON.stringify(current.resolution)) conflict();
      return result("replayed", current);
    }
    if (current.revision !== input.expectedRevision && current.status !== "possiblySent") conflict();
    const resolution = exactResolution(current, input.phase, input.resolution);
    const next = withResolution(current, resolution);
    this.#operations.set(key, next);
    const rKey = receiptKey(input.tenantId, input.spaceId, input.phase, input.idempotency);
    const receipt = this.#receipts.get(rKey);
    if (receipt !== undefined) requireFingerprint(receipt, input.idempotency);
    this.#receipts.set(rKey, { fingerprint: input.idempotency.requestFingerprint, executionKey: key });
    return result("committed", next);
  }

  #expected(input: WorkspaceReadFileLocator & { expectedRevision: number }) {
    const current = this.#required(executionKey(input));
    if (current.revision !== input.expectedRevision) conflict();
    return current;
  }
  #required(key: string) {
    const operation = this.#operations.get(key);
    if (operation === undefined) throw new RunStoreError("workspace_read_file_not_found");
    return validateWorkspaceReadFileRecord(operation);
  }
}

function executionKey(value: WorkspaceReadFileLocator) { return `${value.tenantId}\0${value.spaceId}\0${value.executionId}`; }
function locatorOf(value: WorkspaceReadFileLocator): WorkspaceReadFileLocator {
  return { tenantId: value.tenantId, spaceId: value.spaceId, runId: value.runId,
    stepId: value.stepId, attemptId: value.attemptId, executionId: value.executionId };
}
function receiptKey(tenantId: string, spaceId: string, phase: string, idempotency: IdempotencyDescriptor) {
  return `${tenantId}\0${spaceId}\0${phase}\0${idempotency.scope}\0${idempotency.key}`;
}
function requireFingerprint(receipt: Receipt, idempotency: IdempotencyDescriptor) {
  if (receipt.fingerprint !== idempotency.requestFingerprint) conflict();
}
function result(disposition: "committed" | "replayed", operation: WorkspaceReadFileRecord): WorkspaceReadFileMutationResult {
  return { disposition, operation: structuredClone(operation) };
}
function conflict(): never { throw new RunStoreError("workspace_read_file_conflict"); }
