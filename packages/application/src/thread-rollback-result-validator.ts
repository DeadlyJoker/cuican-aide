import {
  isModelHistoryMessageBacked,
  projectEffectiveModelHistory,
  reduceThreadLifecycleEvent,
  validateModelHistoryItem,
  validateThreadLifecycleEvent,
  validateThreadRollbackArtifacts,
  validateThreadState,
  type ModelHistoryItem,
  type ThreadRollbackArtifacts,
  type ThreadState,
} from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import { canonicalJson } from "./canonical-json.ts";
import type { RollbackThreadCommand } from "./thread-rollback-commands.ts";
import type { CommitThreadRollbackResult } from "./thread-rollback-store-port.ts";

export function validateThreadRollbackResult(
  actor: ActorContext,
  command: RollbackThreadCommand,
  result: CommitThreadRollbackResult,
  expectedDisposition: CommitThreadRollbackResult["disposition"],
  priorState?: ThreadState,
  history?: readonly ModelHistoryItem[],
  artifacts?: ThreadRollbackArtifacts,
): void {
  try {
    validateResultShape(result);
    validateThreadState(result.state);
    validateThreadLifecycleEvent(result.event);
    validateModelHistoryItem(result.marker);
    if (
      result.disposition !== expectedDisposition ||
      result.state.tenantId !== actor.tenantId ||
      result.state.spaceId !== actor.spaceId ||
      result.state.threadId !== command.threadId ||
      result.state.status !== "active" ||
      result.state.revision !== command.expectedRevision + 1 ||
      result.event.type !== "thread.rolled_back" ||
      result.event.identity.threadId !== command.threadId ||
      result.event.sequence !== result.state.lastEventSequence ||
      result.event.occurredAt !== result.state.updatedAt ||
      result.event.data.actorId !== actor.actorId ||
      result.event.data.requestedTurns !== command.numTurns ||
      result.marker.type !== "rollback" ||
      result.marker.tenantId !== actor.tenantId ||
      result.marker.threadId !== command.threadId ||
      result.marker.itemId !== result.event.data.markerItemId ||
      result.marker.threadEventId !== result.event.eventId ||
      result.marker.rollbackId !== result.event.data.rollbackId ||
      result.marker.requestedTurns !== result.event.data.requestedTurns ||
      result.marker.removedTurns !== result.event.data.removedTurns ||
      result.marker.historyFromSequence !==
        result.event.data.historyFromSequence ||
      result.marker.historyThroughSequence !==
        result.event.data.historyThroughSequence ||
      result.marker.sequence !== result.event.data.markerHistorySequence ||
      result.marker.createdAt !== result.event.occurredAt
    ) {
      throw invalidReceipt();
    }
    validateInvalidatedMessages(result);

    if (
      priorState !== undefined &&
      history !== undefined &&
      artifacts !== undefined
    ) {
      validateThreadRollbackArtifacts(history, artifacts);
      const expectedState = reduceThreadLifecycleEvent(
        priorState,
        artifacts.event,
      );
      if (
        canonicalJson(result.state) !== canonicalJson(expectedState) ||
        canonicalJson(result.event) !== canonicalJson(artifacts.event) ||
        canonicalJson(result.marker) !== canonicalJson(artifacts.marker) ||
        canonicalJson(
          result.invalidatedMessages.map(
            ({ invalidation }) => invalidation.historySequence,
          ),
        ) !== canonicalJson(invalidatedHistorySequences(history, artifacts))
      ) {
        throw invalidReceipt();
      }
    }
  } catch (error) {
    if (
      error instanceof ApplicationError &&
      error.code === "thread_rollback_receipt_invalid"
    ) {
      throw error;
    }
    throw new ApplicationError("internal", "thread_rollback_receipt_invalid", {
      cause: error,
    });
  }
}

function validateResultShape(result: CommitThreadRollbackResult): void {
  if (
    !isPlainObject(result) ||
    !hasExactKeys(result, [
      "disposition",
      "state",
      "event",
      "marker",
      "invalidatedMessages",
      "invalidatedContinuationCount",
      "invalidatedModelState",
    ]) ||
    (result.disposition !== "committed" && result.disposition !== "replayed") ||
    !isPlainObject(result.state) ||
    !hasExactKeys(result.state, [
      "threadId",
      "tenantId",
      "spaceId",
      "createdByActorId",
      "title",
      "status",
      "revision",
      "lastEventSequence",
      "lastMessageSequence",
      "createdAt",
      "updatedAt",
      "archivedAt",
      "deletedAt",
      "deletedByActorId",
      "forkedFromThreadId",
      "forkedThroughHistorySequence",
    ]) ||
    !isPlainObject(result.event) ||
    !hasExactKeys(result.event, [
      "schemaVersion",
      "identity",
      "eventId",
      "sequence",
      "occurredAt",
      "type",
      "data",
    ]) ||
    !isPlainObject(result.event.identity) ||
    !hasExactKeys(result.event.identity, ["threadId"]) ||
    !isPlainObject(result.event.data) ||
    !hasExactKeys(result.event.data, [
      "actorId",
      "rollbackId",
      "markerItemId",
      "requestedTurns",
      "removedTurns",
      "historyFromSequence",
      "historyThroughSequence",
      "markerHistorySequence",
    ]) ||
    !isPlainObject(result.marker) ||
    !hasExactKeys(result.marker, [
      "schemaVersion",
      "type",
      "itemId",
      "tenantId",
      "threadId",
      "sequence",
      "runId",
      "segmentId",
      "createdAt",
      "rollbackId",
      "threadEventId",
      "requestedTurns",
      "removedTurns",
      "historyFromSequence",
      "historyThroughSequence",
    ]) ||
    !Array.isArray(result.invalidatedMessages) ||
    !Number.isSafeInteger(result.invalidatedContinuationCount) ||
    result.invalidatedContinuationCount < 0 ||
    typeof result.invalidatedModelState !== "boolean"
  ) {
    throw invalidReceipt();
  }
}

function validateInvalidatedMessages(result: CommitThreadRollbackResult): void {
  let previousMessageSequence = 0;
  let previousHistorySequence = 0;
  const messageIds = new Set<string>();
  for (const invalidated of result.invalidatedMessages) {
    if (
      !isPlainObject(invalidated) ||
      !hasExactKeys(invalidated, [
        "messageId",
        "messageSequence",
        "invalidation",
      ]) ||
      !isPlainObject(invalidated.invalidation) ||
      !hasExactKeys(invalidated.invalidation, [
        "rollbackId",
        "markerItemId",
        "historySequence",
        "invalidatedAt",
      ]) ||
      typeof invalidated.messageId !== "string" ||
      invalidated.messageId.trim().length === 0 ||
      messageIds.has(invalidated.messageId) ||
      !Number.isSafeInteger(invalidated.messageSequence) ||
      invalidated.messageSequence <= previousMessageSequence ||
      !Number.isSafeInteger(invalidated.invalidation.historySequence) ||
      invalidated.invalidation.historySequence <= previousHistorySequence ||
      invalidated.messageSequence > result.state.lastMessageSequence ||
      invalidated.invalidation.rollbackId !== result.marker.rollbackId ||
      invalidated.invalidation.markerItemId !== result.marker.itemId ||
      invalidated.invalidation.invalidatedAt !== result.event.occurredAt ||
      result.marker.historyFromSequence === null ||
      invalidated.invalidation.historySequence <
        result.marker.historyFromSequence ||
      invalidated.invalidation.historySequence >
        result.marker.historyThroughSequence
    ) {
      throw invalidReceipt();
    }
    messageIds.add(invalidated.messageId);
    previousMessageSequence = invalidated.messageSequence;
    previousHistorySequence = invalidated.invalidation.historySequence;
  }
}

function invalidatedHistorySequences(
  history: readonly ModelHistoryItem[],
  artifacts: ThreadRollbackArtifacts,
): readonly number[] {
  const fromSequence = artifacts.boundary.historyFromSequence;
  if (fromSequence === null) return [];
  return projectEffectiveModelHistory(history)
    .items.filter(
      (item) =>
        isModelHistoryMessageBacked(item) &&
        item.sequence >= fromSequence &&
        item.sequence <= artifacts.boundary.historyThroughSequence,
    )
    .map(({ sequence }) => sequence);
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

function invalidReceipt(): ApplicationError {
  return new ApplicationError("internal", "thread_rollback_receipt_invalid");
}
