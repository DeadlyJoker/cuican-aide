import type {
  CommitThreadInput,
  ContentDigester,
  MessageRecord,
} from "@crewon/application";
import type {
  ModelHistoryItem,
  ModelHistoryMessageRole,
  ThreadLifecycleEvent,
} from "@crewon/domain";

const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_LINES = 100_000;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_HISTORY_ITEMS = 10_000;
const MAX_MESSAGE_BYTES = 32 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 40_000;

export type LegacyImportedMessage = Readonly<{
  role: "user" | "assistant";
  content: string;
  occurredAt: string;
}>;

type ImportedModelItem =
  | Readonly<{
      type: "message";
      role: Exclude<ModelHistoryMessageRole, "tool">;
      content: string;
      occurredAt: string;
    }>
  | Readonly<{
      type: "tool_call";
      kind: "function" | "custom";
      callId: string;
      name: string;
      input: string;
      occurredAt: string;
    }>
  | Readonly<{
      type: "tool_result";
      kind: "function" | "custom";
      callId: string;
      output: string;
      occurredAt: string;
    }>
  | Readonly<{
      type: "compaction";
      replacesThroughSequence: number;
      retainedUserMessages: readonly string[];
      summary: string;
      occurredAt: string;
    }>;

export type LegacyRolloutImportTarget = Readonly<{
  tenantId: string;
  spaceId: string;
  actorId: string;
  threadId: string;
  title: string | null;
  importedAt: string;
  idempotencyKey: string;
}>;

export type LegacyRolloutImportIds = Readonly<{
  nextThreadEventId(): string;
  nextMessageId(): string;
  nextModelHistoryItemId(): string;
}>;

export type LegacyRolloutImportPlan = Readonly<{
  schemaVersion: "crewon.legacy-rollout-import.v0";
  source: Readonly<{
    kind: "rust_rollout_jsonl";
    legacyThreadId: string;
    digest: string;
    lineCount: number;
    firstTimestamp: string;
    latestTimestamp: string;
  }>;
  initialMessages: readonly LegacyImportedMessage[];
  commit: CommitThreadInput;
}>;

export class LegacyRolloutImportError extends Error {
  readonly code: string;

  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "LegacyRolloutImportError";
    this.code = code;
  }
}

/** Compiles one read-only Rust rollout into a new Thread transaction. */
export function compileLegacyRolloutImport(
  jsonl: string,
  target: LegacyRolloutImportTarget,
  dependencies: Readonly<{
    ids: LegacyRolloutImportIds;
    digester: ContentDigester;
  }>,
): LegacyRolloutImportPlan {
  requireBounded(target.tenantId, 256, "legacy_import_tenant_invalid");
  requireBounded(target.spaceId, 256, "legacy_import_space_invalid");
  requireBounded(target.actorId, 256, "legacy_import_actor_invalid");
  requireBounded(target.threadId, 512, "legacy_import_thread_invalid");
  requireBounded(
    target.idempotencyKey,
    512,
    "legacy_import_idempotency_key_invalid",
  );
  requireTimestamp(target.importedAt, "legacy_import_timestamp_invalid");
  if (
    target.title !== null &&
    (target.title.trim().length === 0 || target.title.length > 256)
  ) {
    throw new LegacyRolloutImportError("legacy_import_title_invalid");
  }

  const parsed = parseRollout(jsonl);
  const modelMessages = parsed.modelHistory.filter(
    (item): item is Extract<ImportedModelItem, { type: "message" }> =>
      item.type === "message",
  );
  if (
    modelMessages.length !== parsed.initialMessages.length ||
    modelMessages.some((message, index) => {
      const initial = parsed.initialMessages[index];
      return (
        initial === undefined ||
        initial.role !== message.role ||
        initial.content !== message.content
      );
    })
  ) {
    throw new LegacyRolloutImportError(
      "legacy_rollout_message_history_mismatch",
    );
  }
  const sourceDigest = dependencies.digester.sha256(jsonl);
  const events: ThreadLifecycleEvent[] = [
    {
      schemaVersion: "crewon.thread-event.v0",
      identity: { threadId: target.threadId },
      eventId: dependencies.ids.nextThreadEventId(),
      sequence: 1,
      occurredAt: parsed.firstTimestamp,
      type: "thread.created",
      data: {
        tenantId: target.tenantId,
        spaceId: target.spaceId,
        createdByActorId: target.actorId,
        title: target.title,
      },
    },
  ];
  const messages: MessageRecord[] = parsed.initialMessages.map(
    (message, index) => {
      const messageId = dependencies.ids.nextMessageId();
      const sequence = index + 1;
      const contentDigest = dependencies.digester.sha256(message.content);
      events.push({
        schemaVersion: "crewon.thread-event.v0",
        identity: { threadId: target.threadId },
        eventId: dependencies.ids.nextThreadEventId(),
        sequence: sequence + 1,
        occurredAt: message.occurredAt,
        type: "thread.message.appended",
        data: {
          messageId,
          messageSequence: sequence,
          role: message.role,
          contentDigest,
        },
      });
      return {
        messageId,
        tenantId: target.tenantId,
        threadId: target.threadId,
        sequence,
        role: message.role,
        content: message.content,
        contentDigest,
        createdAt: message.occurredAt,
      };
    },
  );
  const syntheticRunId = `legacy-rollout:${parsed.legacyThreadId}`;
  const historyItems: ModelHistoryItem[] = [];
  for (const [index, item] of parsed.modelHistory.entries()) {
    const base = {
      schemaVersion: "crewon.model-history-item.v0" as const,
      itemId: dependencies.ids.nextModelHistoryItemId(),
      tenantId: target.tenantId,
      threadId: target.threadId,
      sequence: index + 1,
      runId: item.type === "message" ? null : syntheticRunId,
      segmentId: item.type === "message" ? null : syntheticRunId,
      createdAt: item.occurredAt,
    };
    switch (item.type) {
      case "message":
        historyItems.push({
          ...base,
          type: "message" as const,
          role: item.role,
          source:
            item.role === "assistant"
              ? ("assistant_completion" as const)
              : ("thread_message" as const),
          content: item.content,
          contentDigest: dependencies.digester.sha256(item.content),
        });
        break;
      case "tool_call":
        historyItems.push({
          ...base,
          type: "tool_call" as const,
          kind: item.kind,
          callId: item.callId,
          name: item.name,
          input: item.input,
        });
        break;
      case "tool_result":
        historyItems.push({
          ...base,
          type: "tool_result" as const,
          kind: item.kind,
          callId: item.callId,
          output: item.output,
          isError: false,
          status: "completed" as const,
        });
        break;
      case "compaction": {
        const replaced = historyItems.filter(
          (historyItem) => historyItem.sequence <= item.replacesThroughSequence,
        );
        historyItems.push({
          ...base,
          type: "compaction" as const,
          mode: "manual" as const,
          replacesThroughSequence: item.replacesThroughSequence,
          sourceDigest: dependencies.digester.sha256(JSON.stringify(replaced)),
          summary: item.summary,
          summaryDigest: dependencies.digester.sha256(item.summary),
          retainedUserMessages: item.retainedUserMessages.map((content) => ({
            content,
            contentDigest: dependencies.digester.sha256(content),
          })),
        });
        break;
      }
    }
  }

  return {
    schemaVersion: "crewon.legacy-rollout-import.v0",
    source: {
      kind: "rust_rollout_jsonl",
      legacyThreadId: parsed.legacyThreadId,
      digest: sourceDigest,
      lineCount: parsed.lineCount,
      firstTimestamp: parsed.firstTimestamp,
      latestTimestamp: parsed.latestTimestamp,
    },
    initialMessages: parsed.initialMessages,
    commit: {
      tenantId: target.tenantId,
      idempotency: {
        scope: "legacyRollout:import",
        key: target.idempotencyKey,
        requestFingerprint: dependencies.digester.sha256(
          JSON.stringify({
            schemaVersion: "crewon.legacy-rollout-import-request.v0",
            sourceDigest,
            legacyThreadId: parsed.legacyThreadId,
            target,
          }),
        ),
      },
      expectedRevision: 0,
      events,
      messages,
      history: { expectedLastSequence: 0, items: historyItems },
    },
  };
}

function parseRollout(jsonl: string): Readonly<{
  legacyThreadId: string;
  lineCount: number;
  firstTimestamp: string;
  latestTimestamp: string;
  initialMessages: readonly LegacyImportedMessage[];
  modelHistory: readonly ImportedModelItem[];
}> {
  if (byteLength(jsonl) > MAX_SOURCE_BYTES) {
    throw new LegacyRolloutImportError("legacy_rollout_source_too_large");
  }
  const lines = jsonl.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length === 0 || lines.length > MAX_LINES) {
    throw new LegacyRolloutImportError("legacy_rollout_line_count_invalid");
  }
  let legacyThreadId: string | null = null;
  let firstTimestamp = "";
  let latestTimestamp = "";
  let modelHistory: ImportedModelItem[] = [];
  let visibleHistory: ImportedModelItem[] = [];
  const initialMessages: LegacyImportedMessage[] = [];
  for (const [index, line] of lines.entries()) {
    if (byteLength(line) > MAX_LINE_BYTES) {
      throw new LegacyRolloutImportError("legacy_rollout_line_too_large");
    }
    const record = parseObject(line, "legacy_rollout_line_invalid");
    const timestamp = requireTimestamp(
      record.timestamp,
      "legacy_rollout_timestamp_invalid",
    );
    if (firstTimestamp === "") {
      firstTimestamp = timestamp;
    }
    if (latestTimestamp !== "" && timestamp < latestTimestamp) {
      throw new LegacyRolloutImportError(
        "legacy_rollout_timestamp_order_invalid",
      );
    }
    latestTimestamp = timestamp;
    const type = requireString(record.type, "legacy_rollout_type_invalid");
    const payload = requireObject(
      record.payload,
      "legacy_rollout_payload_invalid",
    );
    switch (type) {
      case "session_meta":
        if (index !== 0 || legacyThreadId !== null) {
          throw new LegacyRolloutImportError(
            "legacy_rollout_session_meta_invalid",
          );
        }
        legacyThreadId = boundedString(
          payload.id,
          512,
          "legacy_rollout_thread_id_invalid",
        );
        break;
      case "response_item":
        requireSessionMeta(legacyThreadId);
        modelHistory.push(parseResponseItem(payload, timestamp));
        visibleHistory.push(modelHistory.at(-1)!);
        break;
      case "compacted": {
        requireSessionMeta(legacyThreadId);
        const replacement = payload.replacement_history;
        if (replacement === undefined || replacement === null) {
          const summary = boundedString(
            payload.message,
            MAX_MESSAGE_BYTES,
            "legacy_rollout_compaction_summary_invalid",
          );
          const retainedUserMessages = visibleHistory
            .filter(
              (item): item is Extract<ImportedModelItem, { type: "message" }> =>
                item.type === "message" && item.role === "user",
            )
            .map((item) => item.content);
          if (modelHistory.length === 0 || retainedUserMessages.length > 128) {
            throw new LegacyRolloutImportError(
              "legacy_rollout_compaction_history_invalid",
            );
          }
          modelHistory.push({
            type: "compaction",
            replacesThroughSequence: modelHistory.length,
            retainedUserMessages,
            summary,
            occurredAt: timestamp,
          });
          visibleHistory = [
            ...retainedUserMessages.map((content) => ({
              type: "message" as const,
              role: "user" as const,
              content,
              occurredAt: timestamp,
            })),
            {
              type: "message",
              role: "user",
              content: summary,
              occurredAt: timestamp,
            },
          ];
        } else {
          if (!Array.isArray(replacement)) {
            throw new LegacyRolloutImportError(
              "legacy_rollout_replacement_history_invalid",
            );
          }
          const replacementHistory = replacement.map((item) =>
            parseResponseItem(
              requireObject(item, "legacy_rollout_replacement_item_invalid"),
              timestamp,
            ),
          );
          if (
            modelHistory.length === 0 ||
            replacementHistory.length === 0 ||
            replacementHistory.some(
              (item) => item.type !== "message" || item.role !== "user",
            )
          ) {
            throw new LegacyRolloutImportError(
              "legacy_rollout_replacement_history_unsupported",
            );
          }
          const replacementMessages = replacementHistory as readonly Extract<
            ImportedModelItem,
            { type: "message" }
          >[];
          const summary = replacementMessages.at(-1)!.content;
          const retainedUserMessages = replacementMessages
            .slice(0, -1)
            .map((item) => item.content);
          if (retainedUserMessages.length > 128) {
            throw new LegacyRolloutImportError(
              "legacy_rollout_retained_messages_too_large",
            );
          }
          modelHistory.push({
            type: "compaction",
            replacesThroughSequence: modelHistory.length,
            retainedUserMessages,
            summary,
            occurredAt: timestamp,
          });
          visibleHistory = [...replacementHistory];
        }
        break;
      }
      case "event_msg": {
        requireSessionMeta(legacyThreadId);
        const eventType = requireString(
          payload.type,
          "legacy_rollout_event_type_invalid",
        );
        if (eventType === "user_message" || eventType === "agent_message") {
          initialMessages.push({
            role: eventType === "user_message" ? "user" : "assistant",
            content: boundedString(
              payload.message,
              MAX_MESSAGE_BYTES,
              "legacy_rollout_event_message_invalid",
            ),
            occurredAt: timestamp,
          });
        }
        break;
      }
      case "turn_context":
      case "user_input_once_marker":
        requireSessionMeta(legacyThreadId);
        break;
      default:
        throw new LegacyRolloutImportError("legacy_rollout_type_unsupported");
    }
    if (modelHistory.length > MAX_HISTORY_ITEMS) {
      throw new LegacyRolloutImportError("legacy_rollout_history_too_large");
    }
  }
  if (legacyThreadId === null || modelHistory.length === 0) {
    throw new LegacyRolloutImportError("legacy_rollout_incomplete");
  }
  return {
    legacyThreadId,
    lineCount: lines.length,
    firstTimestamp,
    latestTimestamp,
    initialMessages,
    modelHistory,
  };
}

function parseResponseItem(
  item: Readonly<Record<string, unknown>>,
  occurredAt: string,
): ImportedModelItem {
  const type = requireString(item.type, "legacy_response_item_type_invalid");
  switch (type) {
    case "message": {
      const role = requireString(item.role, "legacy_message_role_invalid");
      if (role !== "user" && role !== "assistant") {
        throw new LegacyRolloutImportError("legacy_message_role_unsupported");
      }
      if (!Array.isArray(item.content) || item.content.length !== 1) {
        throw new LegacyRolloutImportError(
          "legacy_message_content_unsupported",
        );
      }
      const content = requireObject(
        item.content[0],
        "legacy_message_content_invalid",
      );
      const expectedType = role === "assistant" ? "output_text" : "input_text";
      if (content.type !== expectedType) {
        throw new LegacyRolloutImportError(
          "legacy_message_content_unsupported",
        );
      }
      return {
        type: "message",
        role,
        content: boundedString(
          content.text,
          MAX_MESSAGE_BYTES,
          "legacy_message_text_invalid",
        ),
        occurredAt,
      };
    }
    case "function_call":
    case "custom_tool_call":
      return {
        type: "tool_call",
        kind: type === "function_call" ? "function" : "custom",
        callId: boundedString(item.call_id, 512, "legacy_tool_call_id_invalid"),
        name: boundedString(item.name, 256, "legacy_tool_name_invalid"),
        input: boundedPossiblyEmptyString(
          type === "function_call" ? item.arguments : item.input,
          MAX_MESSAGE_BYTES,
          "legacy_tool_input_invalid",
        ),
        occurredAt,
      };
    case "function_call_output":
    case "custom_tool_call_output":
      return {
        type: "tool_result",
        kind: type === "function_call_output" ? "function" : "custom",
        callId: boundedString(item.call_id, 512, "legacy_tool_call_id_invalid"),
        output: boundedPossiblyEmptyString(
          item.output,
          MAX_TOOL_OUTPUT_BYTES,
          "legacy_tool_output_invalid",
        ),
        occurredAt,
      };
    default:
      throw new LegacyRolloutImportError("legacy_response_item_unsupported");
  }
}

function parseObject(
  value: string,
  code: string,
): Readonly<Record<string, unknown>> {
  try {
    return requireObject(JSON.parse(value), code);
  } catch (error) {
    if (error instanceof LegacyRolloutImportError) {
      throw error;
    }
    throw new LegacyRolloutImportError(code, { cause: error });
  }
}

function requireObject(
  value: unknown,
  code: string,
): Readonly<Record<string, unknown>> {
  if (!isPlainObject(value)) {
    throw new LegacyRolloutImportError(code);
  }
  return value;
}

function requireString(value: unknown, code: string): string {
  if (typeof value !== "string") {
    throw new LegacyRolloutImportError(code);
  }
  return value;
}

function boundedString(value: unknown, maxBytes: number, code: string): string {
  const result = requireString(value, code);
  if (result.trim().length === 0 || byteLength(result) > maxBytes) {
    throw new LegacyRolloutImportError(code);
  }
  return result;
}

function boundedPossiblyEmptyString(
  value: unknown,
  maxBytes: number,
  code: string,
): string {
  const result = requireString(value, code);
  if (byteLength(result) > maxBytes) {
    throw new LegacyRolloutImportError(code);
  }
  return result;
}

function requireBounded(value: string, maxBytes: number, code: string): void {
  boundedString(value, maxBytes, code);
}

function requireTimestamp(value: unknown, code: string): string {
  const timestamp = requireString(value, code);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(timestamp) ||
    Number.isNaN(Date.parse(timestamp))
  ) {
    throw new LegacyRolloutImportError(code);
  }
  return timestamp;
}

function requireSessionMeta(value: string | null): asserts value is string {
  if (value === null) {
    throw new LegacyRolloutImportError("legacy_rollout_session_meta_missing");
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
