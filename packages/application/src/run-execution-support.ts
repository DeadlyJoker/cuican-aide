import {
  parseProviderCheckpoint,
  parseRateLimitSnapshot,
  type CanonicalAgentEvent,
} from "@crewon/contracts";
import type { RunLifecycleEvent, RunState } from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import { canonicalJson } from "./canonical-json.ts";
import type {
  WorkItem,
  WorkItemClaim,
  WorkItemLeaseInput,
} from "./durable-queue-port.ts";
import type { ThreadContinuationLocator } from "./run-execution-store-port.ts";
import { RunStoreError } from "./run-store-port.ts";

const MAX_MESSAGE_BYTES = 32 * 1024;

export function validateModelIdentity(
  identity: Omit<ThreadContinuationLocator, "tenantId" | "threadId">,
): void {
  for (const [value, code] of [
    [identity.agentVersionId, "agent_version_id_invalid"],
    [identity.adapterName, "model_adapter_name_invalid"],
    [identity.adapterVersion, "model_adapter_version_invalid"],
    [identity.modelId, "model_id_invalid"],
  ] as const) {
    requireNonEmpty(value, code);
  }
}

export function mapAgentEvent(
  event: CanonicalAgentEvent,
  runSequence: number,
  eventId: string,
  occurredAt: string,
  checkpointDigest: (checkpoint: unknown) => string,
): RunLifecycleEvent {
  const envelope = {
    schemaVersion: "crewon.run-event.v0" as const,
    identity: { runId: event.runId },
    eventId,
    sequence: runSequence,
    occurredAt,
  };
  const segment = {
    segmentId: event.segmentId,
    segmentSequence: event.sequence,
  };
  switch (event.type) {
    case "segment.started":
      return {
        ...envelope,
        type: event.type,
        data: {
          ...segment,
          attempt: requirePositiveInteger(
            event.data.attempt,
            "segment_attempt_invalid",
          ),
        },
      };
    case "model.output.delta":
      return {
        ...envelope,
        type: event.type,
        data: {
          ...segment,
          delta: requireNonEmpty(
            event.data.delta,
            "model_output_delta_invalid",
          ),
        },
      };
    case "model.sampling.retry": {
      const samplingAttempt = requirePositiveInteger(
        event.data.samplingAttempt,
        "sampling_attempt_invalid",
      );
      const maxRetries = requirePositiveInteger(
        event.data.maxRetries,
        "sampling_retries_invalid",
      );
      if (samplingAttempt > maxRetries) {
        throw new ApplicationError("validation", "sampling_attempt_invalid");
      }
      return {
        ...envelope,
        type: event.type,
        data: {
          ...segment,
          samplingAttempt,
          maxRetries,
          code: requireNonEmpty(event.data.code, "sampling_retry_code_invalid"),
          discardedOutput: requireBoolean(
            event.data.discardedOutput,
            "sampling_retry_discard_invalid",
          ),
        },
      };
    }
    case "model.transport.fallback":
      return {
        ...envelope,
        type: event.type,
        data: {
          ...segment,
          fromTransport: requireNonEmpty(
            event.data.fromTransport,
            "model_transport_from_invalid",
          ),
          toTransport: requireNonEmpty(
            event.data.toTransport,
            "model_transport_to_invalid",
          ),
          code: requireNonEmpty(
            event.data.code,
            "model_transport_fallback_code_invalid",
          ),
          discardedOutput: requireBoolean(
            event.data.discardedOutput,
            "model_transport_fallback_discard_invalid",
          ),
        },
      };
    case "usage.recorded":
      return {
        ...envelope,
        type: event.type,
        data: {
          ...segment,
          inputTokens: requireNonNegativeInteger(
            event.data.inputTokens,
            "usage_input_tokens_invalid",
          ),
          cachedInputTokens: requireNonNegativeInteger(
            event.data.cachedInputTokens ?? 0,
            "usage_cached_input_tokens_invalid",
          ),
          outputTokens: requireNonNegativeInteger(
            event.data.outputTokens,
            "usage_output_tokens_invalid",
          ),
          totalTokens: requireNonNegativeInteger(
            event.data.totalTokens,
            "usage_total_tokens_invalid",
          ),
        },
      };
    case "rate_limit.updated":
      return {
        ...envelope,
        type: event.type,
        data: {
          ...segment,
          snapshot: parseRateLimitSnapshot(event.data.snapshot),
        },
      };
    case "tool.requested":
      return {
        ...envelope,
        type: event.type,
        data: {
          ...segment,
          callId: requireNonEmpty(event.data.callId, "tool_call_id_invalid"),
          kind: requireToolKind(event.data.kind),
          name: requireNonEmpty(event.data.name, "tool_name_invalid"),
          input: requireString(event.data.input, "tool_input_invalid"),
        },
      };
    case "tool.completed":
      return {
        ...envelope,
        type: event.type,
        data: {
          ...segment,
          callId: requireNonEmpty(event.data.callId, "tool_call_id_invalid"),
          kind: requireToolKind(event.data.kind),
          name: requireNonEmpty(event.data.name, "tool_name_invalid"),
          output: requireString(event.data.output, "tool_output_invalid"),
          isError: requireBoolean(event.data.isError, "tool_result_invalid"),
          artifactRef: requireNullableString(
            event.data.artifactRef,
            "tool_artifact_ref_invalid",
          ),
          outputTruncated: requireBoolean(
            event.data.outputTruncated,
            "tool_result_invalid",
          ),
        },
      };
    case "segment.checkpointed": {
      const checkpoint = parseProviderCheckpoint(event.data.checkpoint);
      return {
        ...envelope,
        type: event.type,
        data: {
          ...segment,
          checkpointDigest: checkpointDigest(checkpoint),
        },
      };
    }
    case "segment.provider_response_created":
      throw new ApplicationError(
        "validation",
        "provider_response_receipt_internal_only",
      );
    case "segment.completed":
      return { ...envelope, type: event.type, data: segment };
    case "segment.failed":
      return {
        ...envelope,
        type: event.type,
        data: {
          ...segment,
          code: requireNonEmpty(
            event.data.code,
            "segment_failure_code_invalid",
          ),
          retryable: requireBoolean(
            event.data.retryable,
            "segment_failure_retryable_invalid",
          ),
        },
      };
    default:
      throw new ApplicationError(
        "validation",
        "agent_event_type_not_persistable",
      );
  }
}

export function executionIdempotency(
  run: RunState,
  workItem: WorkItem,
  phase: string,
  semanticCommand: unknown,
) {
  return {
    scope: canonicalJson({
      schemaVersion: "crewon.idempotency-scope.v0",
      tenantId: run.tenantId,
      runId: run.runId,
      workItemId: workItem.workItemId,
      namespace: "run-execution",
    }),
    key: phase,
    requestFingerprint: canonicalJson({
      schemaVersion: "crewon.run-execution-fingerprint.v0",
      runId: run.runId,
      workItemId: workItem.workItemId,
      phase,
      command: semanticCommand,
    }),
  } as const;
}

export function leaseInput(claim: WorkItemClaim): WorkItemLeaseInput {
  return {
    workItemId: claim.workItem.workItemId,
    ownerId: claim.lease.ownerId,
    leaseId: claim.lease.leaseId,
    leaseEpoch: claim.lease.epoch,
  };
}

export function validateClaim(claim: WorkItemClaim): void {
  if (
    claim.workItem.kind !== "run.execute" ||
    claim.workItem.runId.trim().length === 0 ||
    claim.workItem.tenantId.trim().length === 0 ||
    claim.workItem.workItemId.trim().length === 0 ||
    claim.lease.ownerId.trim().length === 0 ||
    claim.lease.leaseId.trim().length === 0 ||
    !Number.isSafeInteger(claim.lease.epoch) ||
    claim.lease.epoch < 1
  ) {
    throw new ApplicationError("validation", "work_item_claim_invalid");
  }
}

export function requireBoundedContent(content: string): void {
  requireNonEmpty(content, "message_content_invalid");
  if (new TextEncoder().encode(content).byteLength > MAX_MESSAGE_BYTES) {
    throw new ApplicationError("validation", "message_content_too_large");
  }
}

export function requireNonEmpty(value: unknown, code: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApplicationError("validation", code);
  }
  return value;
}

export function requirePositiveInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new ApplicationError("validation", code);
  }
  return Number(value);
}

export function requireNonNegativeInteger(
  value: unknown,
  code: string,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new ApplicationError("validation", code);
  }
  return Number(value);
}

function requireBoolean(value: unknown, code: string): boolean {
  if (typeof value !== "boolean") {
    throw new ApplicationError("validation", code);
  }
  return value;
}

function requireString(value: unknown, code: string): string {
  if (typeof value !== "string") {
    throw new ApplicationError("validation", code);
  }
  return value;
}

function requireNullableString(value: unknown, code: string): string | null {
  if (value === null) {
    return null;
  }
  return requireNonEmpty(value, code);
}

function requireToolKind(value: unknown): "function" | "custom" {
  if (value !== "function" && value !== "custom") {
    throw new ApplicationError("validation", "tool_kind_invalid");
  }
  return value;
}

export function mapExecutionError(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) {
    return error;
  }
  if (error instanceof RunStoreError) {
    const category =
      error.code === "revision_conflict" ||
      error.code === "idempotency_conflict" ||
      error.code === "stale_lease" ||
      error.code === "lease_expired" ||
      error.code.endsWith("_conflict")
        ? "conflict"
        : error.code.endsWith("_invalid") || error.code.endsWith("_too_large")
          ? "validation"
          : "internal";
    return new ApplicationError(
      category,
      category === "internal" ? "store_unavailable" : error.code,
      { cause: error },
    );
  }
  return new ApplicationError("internal", "execution_internal", {
    cause: error,
  });
}
