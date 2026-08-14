import {
  MAX_AUTOMATION_INSTRUCTION_BYTES,
  parseAutomationInvocationOrigin,
  type AutomationInvocationOrigin,
} from "./automation.ts";
import {
  MAX_TURN_KNOWLEDGE_CONTENT_BYTES,
  parseKnowledgeContextBinding,
  type KnowledgeContextBinding,
} from "./knowledge.ts";

export const MODEL_HISTORY_MESSAGE_ROLES = [
  "user",
  "assistant",
  "system",
  "tool",
] as const;
export const MODEL_HISTORY_TOOL_KINDS = ["function", "custom"] as const;
export const MODEL_HISTORY_MESSAGE_SOURCES = [
  "thread_message",
  "assistant_completion",
  "turn_aborted",
  "goal_continuation",
  "goal_steering",
  "automation_invocation",
  "knowledge_context",
] as const;
export const MODEL_HISTORY_COMPACTION_MODES = ["auto", "manual"] as const;
export const MAX_MODEL_HISTORY_ROLLBACK_TURNS = 0xffff_ffff;
export const TURN_ABORTED_HISTORY_MARKER =
  "<turn_aborted>\nThe user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.\n</turn_aborted>";

export type ModelHistoryMessageRole =
  (typeof MODEL_HISTORY_MESSAGE_ROLES)[number];
export type ModelHistoryToolKind = (typeof MODEL_HISTORY_TOOL_KINDS)[number];
export type ModelHistoryMessageSource =
  (typeof MODEL_HISTORY_MESSAGE_SOURCES)[number];
export type ModelHistoryCompactionMode =
  (typeof MODEL_HISTORY_COMPACTION_MODES)[number];

export type ModelHistoryMessageItem = Extract<
  ModelHistoryItem,
  { type: "message" }
>;
export type ModelHistoryMessageBackedItem = ModelHistoryMessageItem &
  Readonly<{
    source: "thread_message" | "automation_invocation" | "assistant_completion";
  }>;
export type ModelHistoryInstructionBoundaryItem =
  ModelHistoryMessageBackedItem &
    Readonly<{
      role: "user";
      source: "thread_message" | "automation_invocation";
    }>;

type ModelHistoryItemBase = Readonly<{
  schemaVersion: "crewon.model-history-item.v0";
  itemId: string;
  tenantId: string;
  threadId: string;
  sequence: number;
  runId: string | null;
  segmentId: string | null;
  createdAt: string;
}>;

type ModelHistoryMessageBase = ModelHistoryItemBase & {
  type: "message";
  role: ModelHistoryMessageRole;
  content: string;
  contentDigest: string;
};

type OrdinaryModelHistoryMessageSource = Exclude<
  ModelHistoryMessageSource,
  "automation_invocation" | "knowledge_context"
>;

export type ModelHistoryItem =
  | (ModelHistoryMessageBase & {
      source: "automation_invocation";
      origin: AutomationInvocationOrigin;
    })
  | (ModelHistoryMessageBase & {
      source: "knowledge_context";
      role: "user";
      knowledge: KnowledgeContextBinding;
    })
  | (ModelHistoryMessageBase & {
      source: OrdinaryModelHistoryMessageSource;
      origin?: never;
    })
  | (ModelHistoryItemBase & {
      type: "tool_call";
      kind: ModelHistoryToolKind;
      callId: string;
      name: string;
      input: string;
    })
  | (ModelHistoryItemBase & {
      type: "tool_result";
      kind: ModelHistoryToolKind;
      callId: string;
      output: string;
      isError: boolean;
      status: "completed" | "aborted";
    })
  | (ModelHistoryItemBase & {
      type: "compaction";
      mode: ModelHistoryCompactionMode;
      replacesThroughSequence: number;
      sourceDigest: string;
      summary: string;
      summaryDigest: string;
      retainedUserMessages: readonly Readonly<{
        content: string;
        contentDigest: string;
      }>[];
    })
  | (ModelHistoryItemBase & {
      type: "rollback";
      rollbackId: string;
      threadEventId: string;
      requestedTurns: number;
      removedTurns: number;
      historyFromSequence: number | null;
      historyThroughSequence: number;
    });

/** True for durable messages that have a corresponding entry in the Message ledger. */
export function isModelHistoryMessageBacked(
  item: ModelHistoryItem,
): item is ModelHistoryMessageBackedItem {
  return (
    item.type === "message" &&
    (item.source === "thread_message" ||
      item.source === "automation_invocation" ||
      item.source === "assistant_completion")
  );
}

/** True for user instructions that define rollback turn boundaries. */
export function isModelHistoryInstructionBoundary(
  item: ModelHistoryItem,
): item is ModelHistoryInstructionBoundaryItem {
  return (
    isModelHistoryMessageBacked(item) &&
    item.role === "user" &&
    (item.source === "thread_message" ||
      item.source === "automation_invocation")
  );
}

/** True for ordinary or automation instructions retained across compaction. */
export function isModelHistoryRetainedUserMessage(
  item: ModelHistoryItem,
): item is ModelHistoryInstructionBoundaryItem {
  return isModelHistoryInstructionBoundary(item);
}

export type ModelHistoryHead = Readonly<{
  tenantId: string;
  threadId: string;
  lastSequence: number;
}>;

export class ModelHistoryError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ModelHistoryError";
    this.code = code;
  }
}

export function validateModelHistoryItem(item: ModelHistoryItem): void {
  if (
    !isPlainObject(item) ||
    item.schemaVersion !== "crewon.model-history-item.v0"
  ) {
    throw new ModelHistoryError("model_history_item_invalid");
  }
  requireBounded(item.itemId, 512, "model_history_item_id_invalid");
  requireBounded(item.tenantId, 256, "model_history_tenant_id_invalid");
  requireBounded(item.threadId, 512, "model_history_thread_id_invalid");
  if (!Number.isSafeInteger(item.sequence) || item.sequence < 1) {
    throw new ModelHistoryError("model_history_sequence_invalid");
  }
  requireOptionalBounded(item.runId, 512, "model_history_run_id_invalid");
  requireOptionalBounded(
    item.segmentId,
    512,
    "model_history_segment_id_invalid",
  );
  if (item.segmentId !== null && item.runId === null) {
    throw new ModelHistoryError("model_history_execution_identity_invalid");
  }
  if (!isRfc3339Utc(item.createdAt)) {
    throw new ModelHistoryError("model_history_created_at_invalid");
  }

  switch (item.type) {
    case "message":
      if (!MODEL_HISTORY_MESSAGE_ROLES.includes(item.role)) {
        throw new ModelHistoryError("model_history_message_role_invalid");
      }
      if (!MODEL_HISTORY_MESSAGE_SOURCES.includes(item.source)) {
        throw new ModelHistoryError("model_history_message_source_invalid");
      }
      requireBounded(
        item.content,
        item.source === "automation_invocation"
          ? MAX_AUTOMATION_INSTRUCTION_BYTES
          : item.source === "goal_continuation" ||
              item.source === "goal_steering"
            ? 36 * 1024
            : 32 * 1024,
        "model_history_content_invalid",
      );
      requireDigest(item.contentDigest, "model_history_content_digest_invalid");
      if (item.source === "automation_invocation") {
        validateAutomationInvocationMessage(item);
      } else if (item.source === "knowledge_context") {
        if (
          item.role !== "user" ||
          item.runId !== null ||
          item.segmentId !== null ||
          !Object.hasOwn(item, "knowledge")
        ) {
          throw new ModelHistoryError("model_history_knowledge_invalid");
        }
        requireBounded(
          item.content,
          MAX_TURN_KNOWLEDGE_CONTENT_BYTES,
          "model_history_knowledge_content_invalid",
        );
        try {
          const binding = parseKnowledgeContextBinding(item.knowledge);
          if (binding.contentDigest !== item.contentDigest) {
            throw new ModelHistoryError(
              "model_history_knowledge_digest_mismatch",
            );
          }
        } catch (error) {
          if (error instanceof ModelHistoryError) throw error;
          throw new ModelHistoryError("model_history_knowledge_invalid");
        }
      } else if (Object.hasOwn(item, "origin")) {
        throw new ModelHistoryError("model_history_message_origin_invalid");
      }
      if (
        item.source === "turn_aborted" &&
        (item.role !== "user" || item.content !== TURN_ABORTED_HISTORY_MARKER)
      ) {
        throw new ModelHistoryError("model_history_abort_marker_invalid");
      }
      if (item.source === "goal_continuation" && item.role !== "user") {
        throw new ModelHistoryError("model_history_goal_continuation_invalid");
      }
      if (item.source === "goal_steering" && item.role !== "user") {
        throw new ModelHistoryError("model_history_goal_steering_invalid");
      }
      return;
    case "tool_call":
      validateToolKind(item.kind);
      requireBounded(item.callId, 512, "model_history_call_id_invalid");
      requireBounded(item.name, 256, "model_history_tool_name_invalid");
      requireStringAtMost(
        item.input,
        32 * 1024,
        "model_history_tool_input_invalid",
      );
      if (item.runId === null || item.segmentId === null) {
        throw new ModelHistoryError("model_history_tool_run_id_missing");
      }
      return;
    case "tool_result":
      validateToolKind(item.kind);
      requireBounded(item.callId, 512, "model_history_call_id_invalid");
      requireStringAtMost(
        item.output,
        40_000,
        "model_history_tool_output_invalid",
      );
      if (typeof item.isError !== "boolean") {
        throw new ModelHistoryError("model_history_tool_error_invalid");
      }
      if (item.status !== "completed" && item.status !== "aborted") {
        throw new ModelHistoryError("model_history_tool_status_invalid");
      }
      if (item.status === "aborted" && item.isError !== true) {
        throw new ModelHistoryError("model_history_aborted_tool_not_error");
      }
      if (item.runId === null || item.segmentId === null) {
        throw new ModelHistoryError("model_history_tool_run_id_missing");
      }
      return;
    case "compaction": {
      if (
        !MODEL_HISTORY_COMPACTION_MODES.includes(item.mode) ||
        item.runId === null ||
        item.segmentId === null ||
        !Number.isSafeInteger(item.replacesThroughSequence) ||
        item.replacesThroughSequence < 1 ||
        item.replacesThroughSequence >= item.sequence ||
        !Array.isArray(item.retainedUserMessages) ||
        item.retainedUserMessages.length > 128
      ) {
        throw new ModelHistoryError("model_history_compaction_invalid");
      }
      requireBounded(
        item.summary,
        32 * 1024,
        "model_history_compaction_summary_invalid",
      );
      requireDigest(
        item.summaryDigest,
        "model_history_compaction_summary_digest_invalid",
      );
      requireDigest(
        item.sourceDigest,
        "model_history_compaction_source_digest_invalid",
      );
      let retainedBytes = 0;
      for (const retained of item.retainedUserMessages) {
        if (
          !isPlainObject(retained) ||
          typeof retained.content !== "string" ||
          typeof retained.contentDigest !== "string"
        ) {
          throw new ModelHistoryError(
            "model_history_compaction_retained_message_invalid",
          );
        }
        requireBounded(
          retained.content,
          32 * 1024,
          "model_history_compaction_retained_message_invalid",
        );
        requireDigest(
          retained.contentDigest,
          "model_history_compaction_retained_digest_invalid",
        );
        retainedBytes += new TextEncoder().encode(retained.content).byteLength;
      }
      if (retainedBytes > 32 * 1024) {
        throw new ModelHistoryError(
          "model_history_compaction_retained_messages_too_large",
        );
      }
      return;
    }
    case "rollback":
      requireBounded(item.rollbackId, 512, "model_history_rollback_id_invalid");
      requireBounded(
        item.threadEventId,
        512,
        "model_history_rollback_event_id_invalid",
      );
      if (
        item.runId !== null ||
        item.segmentId !== null ||
        !Number.isSafeInteger(item.requestedTurns) ||
        item.requestedTurns < 1 ||
        item.requestedTurns > MAX_MODEL_HISTORY_ROLLBACK_TURNS ||
        !Number.isSafeInteger(item.removedTurns) ||
        item.removedTurns < 0 ||
        item.removedTurns > item.requestedTurns ||
        !Number.isSafeInteger(item.historyThroughSequence) ||
        item.historyThroughSequence !== item.sequence - 1 ||
        (item.historyFromSequence === null) !== (item.removedTurns === 0) ||
        (item.historyFromSequence !== null &&
          (!Number.isSafeInteger(item.historyFromSequence) ||
            item.historyFromSequence < 1 ||
            item.historyFromSequence > item.historyThroughSequence))
      ) {
        throw new ModelHistoryError("model_history_rollback_invalid");
      }
      return;
  }
}

function validateAutomationInvocationMessage(
  item: Extract<
    ModelHistoryItem,
    { type: "message"; source: "automation_invocation" }
  >,
): void {
  const expectedKeys = [
    "content",
    "contentDigest",
    "createdAt",
    "itemId",
    "origin",
    "role",
    "runId",
    "schemaVersion",
    "segmentId",
    "sequence",
    "source",
    "tenantId",
    "threadId",
    "type",
  ];
  const actualKeys = Object.keys(item).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    item.role !== "user" ||
    item.runId === null ||
    item.segmentId !== null
  ) {
    throw new ModelHistoryError("model_history_automation_invocation_invalid");
  }
  try {
    const origin = parseAutomationInvocationOrigin(item.origin);
    if (origin.binding.runId !== item.runId) {
      throw new ModelHistoryError(
        "model_history_automation_invocation_run_id_mismatch",
      );
    }
    if (origin.binding.instructionDigest !== item.contentDigest) {
      throw new ModelHistoryError(
        "model_history_automation_invocation_instruction_digest_mismatch",
      );
    }
  } catch (error) {
    if (error instanceof ModelHistoryError) throw error;
    throw new ModelHistoryError(
      "model_history_automation_invocation_origin_invalid",
    );
  }
}

function validateToolKind(kind: ModelHistoryToolKind): void {
  if (!MODEL_HISTORY_TOOL_KINDS.includes(kind)) {
    throw new ModelHistoryError("model_history_tool_kind_invalid");
  }
}

function requireDigest(value: string, code: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new ModelHistoryError(code);
  }
}

function requireOptionalBounded(
  value: string | null,
  maxBytes: number,
  code: string,
): void {
  if (value !== null) {
    requireBounded(value, maxBytes, code);
  }
}

function requireBounded(value: string, maxBytes: number, code: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ModelHistoryError(code);
  }
  requireStringAtMost(value, maxBytes, code);
}

function requireStringAtMost(
  value: string,
  maxBytes: number,
  code: string,
): void {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).byteLength > maxBytes
  ) {
    throw new ModelHistoryError(code);
  }
}

function isRfc3339Utc(value: string): boolean {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
