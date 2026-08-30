import {
  MAX_MODEL_HISTORY_ROLLBACK_TURNS,
  ModelHistoryError,
  ThreadLifecycleError,
  createThreadRollbackArtifacts,
  validateThreadState,
  type ModelHistoryItem,
  type ThreadRollbackArtifacts,
  type ThreadState,
} from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import type {
  ApplicationClock,
  ApplicationIdGenerator,
  ApplicationIdKind,
} from "./application-runtime-ports.ts";
import type { ActorContext, AuthorizationPort } from "./authorization-port.ts";
import { canonicalJson } from "./canonical-json.ts";
import type { ModelHistoryStore } from "./model-history-store-port.ts";
import { RunStoreError, type IdempotencyDescriptor } from "./run-store-port.ts";
import type { RollbackThreadCommand } from "./thread-rollback-commands.ts";
import { validateThreadRollbackResult } from "./thread-rollback-result-validator.ts";
import type {
  CommitThreadRollbackResult,
  ThreadRollbackStore,
} from "./thread-rollback-store-port.ts";
import type { ThreadStore } from "./thread-store-port.ts";

const MAX_ROLLBACK_HISTORY_ITEMS = 10_000;
const MAX_ROLLBACK_HISTORY_BYTES = 64 * 1024 * 1024;
const HISTORY_PAGE_SIZE = 100;

type RollbackApplicationStore = ThreadStore &
  ModelHistoryStore &
  ThreadRollbackStore;

/** Authorized append-only Thread rollback mutation. */
export class ThreadRollbackApplicationService {
  readonly #store: RollbackApplicationStore;
  readonly #authorization: AuthorizationPort;
  readonly #clock: ApplicationClock;
  readonly #ids: ApplicationIdGenerator;

  constructor(dependencies: {
    store: RollbackApplicationStore;
    authorization: AuthorizationPort;
    clock: ApplicationClock;
    ids: ApplicationIdGenerator;
  }) {
    this.#store = dependencies.store;
    this.#authorization = dependencies.authorization;
    this.#clock = dependencies.clock;
    this.#ids = dependencies.ids;
  }

  async rollbackThread(
    actor: ActorContext,
    command: RollbackThreadCommand,
  ): Promise<CommitThreadRollbackResult> {
    validateActor(actor);
    validateCommand(command);
    const thread = await this.#loadThread(actor, command.threadId);
    await this.#authorize(actor, thread);
    const idempotency = idempotencyDescriptor(actor, command);
    const replay = await this.#loadReplay(actor, command.threadId, idempotency);
    if (replay !== null) {
      validateThreadRollbackResult(actor, command, replay, "replayed");
      return replay;
    }

    if (thread.status !== "active") {
      throw new ApplicationError("conflict", "thread_not_active");
    }
    if (thread.revision !== command.expectedRevision) {
      throw new ApplicationError("conflict", "revision_conflict");
    }
    const history = await this.#loadRawHistory(actor, thread.threadId);
    const artifacts = this.#createArtifacts(actor, thread, command, history);
    let result: CommitThreadRollbackResult;
    try {
      result = await this.#store.commitThreadRollback({
        tenantId: actor.tenantId,
        idempotency,
        expectedThreadRevision: command.expectedRevision,
        expectedHistorySequence: history.at(-1)?.sequence ?? 0,
        event: artifacts.event,
        marker: artifacts.marker,
      });
    } catch (error) {
      throw mapError(error);
    }
    if (result.disposition === "committed") {
      validateThreadRollbackResult(
        actor,
        command,
        result,
        "committed",
        thread,
        history,
        artifacts,
      );
    } else {
      validateThreadRollbackResult(actor, command, result, "replayed");
    }
    return result;
  }

  async #loadThread(
    actor: ActorContext,
    threadId: string,
  ): Promise<ThreadState> {
    let thread: ThreadState | null;
    try {
      thread = await this.#store.loadThreadInSpace({
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        threadId,
      });
    } catch (error) {
      throw mapError(error);
    }
    if (
      thread === null ||
      thread.tenantId !== actor.tenantId ||
      thread.spaceId !== actor.spaceId ||
      thread.threadId !== threadId ||
      thread.status === "deleted"
    ) {
      throw new ApplicationError("notFound", "thread_not_found");
    }
    try {
      validateThreadState(thread);
    } catch (error) {
      throw new ApplicationError("internal", "thread_state_invalid", {
        cause: error,
      });
    }
    return thread;
  }

  async #authorize(actor: ActorContext, thread: ThreadState): Promise<void> {
    try {
      const decision = await this.#authorization.authorize({
        actor,
        action: "thread:rollback",
        resource: {
          kind: "thread",
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          threadId: thread.threadId,
        },
      });
      if (decision.outcome === "allow") return;
      throw new ApplicationError("authorization", "authorization_denied");
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError("authorization", "authorization_unavailable", {
        cause: error,
      });
    }
  }

  async #loadReplay(
    actor: ActorContext,
    threadId: string,
    idempotency: IdempotencyDescriptor,
  ): Promise<CommitThreadRollbackResult | null> {
    try {
      return await this.#store.loadThreadRollbackReceipt({
        tenantId: actor.tenantId,
        threadId,
        idempotency,
      });
    } catch (error) {
      throw mapError(error);
    }
  }

  async #loadRawHistory(
    actor: ActorContext,
    threadId: string,
  ): Promise<readonly ModelHistoryItem[]> {
    let head;
    try {
      head = await this.#store.loadModelHistoryHead({
        tenantId: actor.tenantId,
        threadId,
      });
    } catch (error) {
      throw mapError(error);
    }
    if (
      head === null ||
      head.tenantId !== actor.tenantId ||
      head.threadId !== threadId ||
      !Number.isSafeInteger(head.lastSequence) ||
      head.lastSequence < 0
    ) {
      throw new ApplicationError("internal", "model_history_head_invalid");
    }
    if (head.lastSequence > MAX_ROLLBACK_HISTORY_ITEMS) {
      throw new ApplicationError(
        "conflict",
        "thread_rollback_history_too_large",
      );
    }
    const history: ModelHistoryItem[] = [];
    let encodedBytes = 2;
    let cursor = 0;
    while (cursor < head.lastSequence) {
      let page: readonly ModelHistoryItem[];
      try {
        page = await this.#store.listModelHistoryItems(
          { tenantId: actor.tenantId, threadId },
          cursor,
          Math.min(HISTORY_PAGE_SIZE, head.lastSequence - cursor),
        );
      } catch (error) {
        throw mapError(error);
      }
      const previousCursor = cursor;
      for (const item of page) {
        if (item.sequence > head.lastSequence) break;
        let itemBytes: number;
        try {
          itemBytes = new TextEncoder().encode(canonicalJson(item)).byteLength;
        } catch (error) {
          throw new ApplicationError("internal", "model_history_invalid", {
            cause: error,
          });
        }
        encodedBytes += itemBytes + (history.length === 0 ? 0 : 1);
        if (encodedBytes > MAX_ROLLBACK_HISTORY_BYTES) {
          throw new ApplicationError(
            "conflict",
            "thread_rollback_history_too_large",
          );
        }
        history.push(item);
        cursor = item.sequence;
      }
      if (page.length === 0 || cursor <= previousCursor) {
        throw new ApplicationError("internal", "model_history_incomplete");
      }
    }
    if (history.length !== head.lastSequence) {
      throw new ApplicationError("internal", "model_history_incomplete");
    }
    return history;
  }

  #createArtifacts(
    actor: ActorContext,
    thread: ThreadState,
    command: RollbackThreadCommand,
    history: readonly ModelHistoryItem[],
  ): ThreadRollbackArtifacts {
    try {
      return createThreadRollbackArtifacts(history, {
        tenantId: actor.tenantId,
        threadId: thread.threadId,
        actorId: actor.actorId,
        rollbackId: this.#nextId("rollback"),
        markerItemId: this.#nextId("modelHistoryItem"),
        threadEventId: this.#nextId("threadEvent"),
        threadEventSequence: thread.lastEventSequence + 1,
        occurredAt: this.#now(),
        requestedTurns: command.numTurns,
      });
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError(
        "internal",
        "thread_rollback_history_invalid",
        {
          cause: error,
        },
      );
    }
  }

  #nextId(kind: ApplicationIdKind): string {
    const id = this.#ids.nextId(kind);
    requireNonEmpty(id, `${kind}_id_invalid`);
    return id;
  }

  #now(): string {
    const timestamp = this.#clock.now();
    if (!isRfc3339Utc(timestamp)) {
      throw new ApplicationError("internal", "clock_timestamp_invalid");
    }
    return timestamp;
  }
}

function idempotencyDescriptor(
  actor: ActorContext,
  command: RollbackThreadCommand,
): IdempotencyDescriptor {
  return {
    scope: canonicalJson({
      schemaVersion: "crewon.idempotency-scope.v0",
      tenantId: actor.tenantId,
      actorId: actor.actorId,
      namespace: "thread-rollback-command",
    }),
    key: command.idempotencyKey,
    requestFingerprint: canonicalJson({
      schemaVersion: "crewon.thread-rollback-command-fingerprint.v0",
      actor: {
        actorId: actor.actorId,
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
      },
      command: {
        kind: command.kind,
        threadId: command.threadId,
        expectedRevision: command.expectedRevision,
        numTurns: command.numTurns,
      },
    }),
  };
}

function validateCommand(command: RollbackThreadCommand): void {
  if (
    !isPlainObject(command) ||
    !hasExactKeys(command, [
      "kind",
      "idempotencyKey",
      "threadId",
      "expectedRevision",
      "numTurns",
    ]) ||
    command.kind !== "thread.rollback"
  ) {
    throw new ApplicationError("validation", "thread_rollback_command_invalid");
  }
  requireNonEmpty(command.idempotencyKey, "idempotency_key_invalid");
  requireNonEmpty(command.threadId, "thread_id_invalid");
  if (
    !Number.isSafeInteger(command.expectedRevision) ||
    command.expectedRevision < 1
  ) {
    throw new ApplicationError("validation", "expected_revision_invalid");
  }
  if (
    !Number.isSafeInteger(command.numTurns) ||
    command.numTurns < 1 ||
    command.numTurns > MAX_MODEL_HISTORY_ROLLBACK_TURNS
  ) {
    throw new ApplicationError("validation", "rollback_num_turns_invalid");
  }
}

function validateActor(actor: ActorContext): void {
  if (!isPlainObject(actor)) {
    throw new ApplicationError("validation", "actor_context_invalid");
  }
  requireNonEmpty(actor.principalId, "principal_id_invalid");
  requireNonEmpty(actor.actorId, "actor_id_invalid");
  requireNonEmpty(actor.tenantId, "tenant_id_invalid");
  requireNonEmpty(actor.spaceId, "space_id_invalid");
}

function requireNonEmpty(
  value: unknown,
  code: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApplicationError("validation", code);
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isRfc3339Utc(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function mapError(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) return error;
  if (error instanceof RunStoreError) {
    if (
      error.code === "idempotency_conflict" ||
      error.code === "message_already_invalidated" ||
      error.code.endsWith("_conflict")
    ) {
      return new ApplicationError("conflict", error.code, { cause: error });
    }
    if (error.code === "thread_not_found") {
      return new ApplicationError("notFound", "thread_not_found", {
        cause: error,
      });
    }
    return new ApplicationError(
      "internal",
      "thread_rollback_store_unavailable",
      {
        cause: error,
      },
    );
  }
  if (
    error instanceof ModelHistoryError ||
    error instanceof ThreadLifecycleError
  ) {
    return new ApplicationError("internal", "thread_rollback_internal", {
      cause: error,
    });
  }
  return new ApplicationError("internal", "thread_rollback_internal", {
    cause: error,
  });
}
