const DEFAULT_MAX_ITEMS = 256;
const MAX_CONTEXT_BYTES = 512 * 1024;
const MAX_NORMALIZABLE_CONTEXT_BYTES = 64 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_TOOL_INPUT_BYTES = 32 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 40_000;
const MISSING_TOOL_RESULT_OUTPUT = "aborted";

export type ContextHistoryItem =
  | Readonly<{
      type: "message";
      role: "user" | "assistant" | "developer" | "system";
      content: string;
    }>
  | Readonly<{
      type: "tool_call";
      kind: "function" | "custom";
      callId: string;
      name: string;
      input: string;
    }>
  | Readonly<{
      type: "tool_result";
      kind: "function" | "custom";
      callId: string;
      output: string;
    }>;

export type ContextHistoryRepair = Readonly<{
  kind: "missingToolResultInserted" | "orphanToolResultDropped";
  toolKind: "function" | "custom";
  callId: string;
}>;

export type ContextProjectionEntry = Readonly<{
  sourceSequence: number;
  item: ContextHistoryItem;
}>;

export type NormalizedContextHistory = Readonly<{
  items: readonly ContextHistoryItem[];
  sourceSequences: readonly number[];
  repairs: readonly ContextHistoryRepair[];
  historyRewritten: boolean;
  byteLength: number;
}>;

type ContextNormalizationOptions = Readonly<{
  maxItems?: number;
  maxBytes?: number;
}>;

export class ContextHistoryError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ContextHistoryError";
    this.code = code;
  }
}

/**
 * Produces a bounded model projection without mutating durable history.
 *
 * The operation preserves the exact input array when no repair is required so callers can keep
 * provider checkpoints and cache prefixes. Any repair sets `historyRewritten`, which requires
 * manual replay from the repaired projection.
 */
export function normalizeContextHistory(
  input: readonly ContextHistoryItem[],
  options: ContextNormalizationOptions = {},
): NormalizedContextHistory {
  const normalized = normalizeContextHistoryEntries(
    input.map((item, index) => ({ sourceSequence: index + 1, item })),
    options,
  );
  return normalized.historyRewritten
    ? normalized
    : { ...normalized, items: input };
}

/** Keeps the newest bounded suffix and repairs any Tool pair cut by the boundary. */
export function boundedContextTail(
  input: readonly ContextHistoryItem[],
  maxItems: number,
  maxBytes = MAX_CONTEXT_BYTES,
): NormalizedContextHistory {
  validateLimits(maxItems, maxBytes);
  const inputBytes = input.reduce(
    (total, item) => total + validateItem(item),
    0,
  );
  if (input.length <= maxItems && inputBytes <= maxBytes) {
    return normalizeContextHistory(input, { maxItems, maxBytes });
  }
  let start = input.length;
  let bytes = 0;
  while (start > 0 && input.length - start < maxItems - 1) {
    const next = input[start - 1]!;
    const nextBytes =
      validateItem(next) +
      (next.type === "tool_call" ? byteLength(MISSING_TOOL_RESULT_OUTPUT) : 0);
    if (bytes + nextBytes > maxBytes) {
      break;
    }
    bytes += nextBytes;
    start -= 1;
  }
  const normalized = normalizeContextHistory(input.slice(start), {
    maxItems,
    maxBytes,
  });
  return { ...normalized, historyRewritten: true };
}

export function normalizeContextHistoryEntries(
  input: readonly ContextProjectionEntry[],
  options: ContextNormalizationOptions = {},
): NormalizedContextHistory {
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  const maxBytes = options.maxBytes ?? MAX_CONTEXT_BYTES;
  validateLimits(maxItems, maxBytes);
  if (!Array.isArray(input) || input.length === 0) {
    throw new ContextHistoryError("context_history_empty");
  }
  if (input.length > maxItems) {
    throw new ContextHistoryError("context_history_item_limit_exceeded");
  }

  const calls = new Map<
    string,
    Readonly<{
      index: number;
      entry: ContextProjectionEntry & {
        item: Extract<ContextHistoryItem, { type: "tool_call" }>;
      };
    }>
  >();
  let totalBytes = 0;
  for (const [index, entry] of input.entries()) {
    validateSourceSequence(entry.sourceSequence);
    const { item } = entry;
    totalBytes += validateItem(item);
    if (item.type === "tool_call") {
      if (calls.has(item.callId)) {
        throw new ContextHistoryError("context_tool_call_duplicate");
      }
      calls.set(item.callId, {
        index,
        entry: entry as ContextProjectionEntry & {
          item: Extract<ContextHistoryItem, { type: "tool_call" }>;
        },
      });
    }
  }
  if (totalBytes > maxBytes) {
    throw new ContextHistoryError("context_history_byte_limit_exceeded");
  }

  const matchedResults = new Set<number>();
  const matchedCalls = new Set<string>();
  for (const [index, { item }] of input.entries()) {
    if (item.type !== "tool_result") {
      continue;
    }
    const call = calls.get(item.callId);
    if (
      call !== undefined &&
      call.index < index &&
      call.entry.item.kind === item.kind &&
      !matchedCalls.has(item.callId)
    ) {
      matchedCalls.add(item.callId);
      matchedResults.add(index);
    }
  }

  const entries: ContextProjectionEntry[] = [];
  const repairs: ContextHistoryRepair[] = [];
  for (const [index, entry] of input.entries()) {
    const { item } = entry;
    if (item.type === "tool_result" && !matchedResults.has(index)) {
      repairs.push({
        kind: "orphanToolResultDropped",
        toolKind: item.kind,
        callId: item.callId,
      });
      continue;
    }
    entries.push(entry);
    if (item.type === "tool_call" && !matchedCalls.has(item.callId)) {
      entries.push({
        sourceSequence: entry.sourceSequence,
        item: {
          type: "tool_result",
          kind: item.kind,
          callId: item.callId,
          output: MISSING_TOOL_RESULT_OUTPUT,
        },
      });
      repairs.push({
        kind: "missingToolResultInserted",
        toolKind: item.kind,
        callId: item.callId,
      });
    }
  }
  if (entries.length > maxItems) {
    throw new ContextHistoryError("normalized_context_item_limit_exceeded");
  }
  const normalizedBytes = entries.reduce(
    (total, { item }) => total + validateItem(item),
    0,
  );
  if (normalizedBytes > maxBytes) {
    throw new ContextHistoryError("normalized_context_byte_limit_exceeded");
  }
  return {
    items: entries.map(({ item }) => item),
    sourceSequences: entries.map(({ sourceSequence }) => sourceSequence),
    repairs,
    historyRewritten: repairs.length > 0,
    byteLength: normalizedBytes,
  };
}

function validateLimits(maxItems: number, maxBytes: number): void {
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 10_000) {
    throw new ContextHistoryError("context_item_limit_invalid");
  }
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_NORMALIZABLE_CONTEXT_BYTES
  ) {
    throw new ContextHistoryError("context_byte_limit_invalid");
  }
}

function validateSourceSequence(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ContextHistoryError("context_source_sequence_invalid");
  }
}

function validateItem(item: ContextHistoryItem): number {
  if (!isPlainObject(item) || typeof item.type !== "string") {
    throw new ContextHistoryError("context_history_item_invalid");
  }
  switch (item.type) {
    case "message":
      if (
        (item.role !== "user" &&
          item.role !== "assistant" &&
          item.role !== "developer" &&
          item.role !== "system") ||
        !isBoundedString(item.content, MAX_MESSAGE_BYTES)
      ) {
        throw new ContextHistoryError("context_message_invalid");
      }
      return byteLength(item.content);
    case "tool_call":
      if (
        !isToolKind(item.kind) ||
        !isBoundedString(item.callId, 512) ||
        !isBoundedString(item.name, 256) ||
        typeof item.input !== "string" ||
        byteLength(item.input) > MAX_TOOL_INPUT_BYTES
      ) {
        throw new ContextHistoryError("context_tool_call_invalid");
      }
      return byteLength(item.input);
    case "tool_result":
      if (
        !isToolKind(item.kind) ||
        !isBoundedString(item.callId, 512) ||
        typeof item.output !== "string" ||
        byteLength(item.output) > MAX_TOOL_OUTPUT_BYTES
      ) {
        throw new ContextHistoryError("context_tool_result_invalid");
      }
      return byteLength(item.output);
  }
}

function isToolKind(value: unknown): value is "function" | "custom" {
  return value === "function" || value === "custom";
}

function isBoundedString(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    byteLength(value) <= maxBytes
  );
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
