import { AgentKernelError } from "@crewon/agent-kernel";
import {
  CONTEXT_COMPACTION_PROMPT,
  ContextHistoryError,
  normalizeContextHistory,
  type ContextCompactionContract,
  type ContextHistoryItem,
} from "@crewon/context";

export const MAX_COMPACTION_PARTS = 16;
export const MIN_COMPACTION_PART_OUTPUT_BYTES = 512;
export const COMPACTION_PART_SEPARATOR = "\n\n---\n\n";
export const COMPACTION_PART_HEADER =
  "Context checkpoints in chronological source order (earlier to later):\n\n";
export type CompactionSourceRange = Readonly<{ start: number; end: number }>;

/** Validates the entire source before any call; boundaries never repair or discard evidence. */
export class CompactionSourcePlan {
  readonly #contract: ContextCompactionContract;
  readonly #prefixLength: number;
  readonly #bytes: number[] = [0];
  readonly #boundaries: number[] = [];
  readonly #partitionable: boolean;
  readonly ranges: readonly CompactionSourceRange[];

  constructor(contract: ContextCompactionContract) {
    this.#contract = contract;
    this.#prefixLength = contract.protectedPrefixLength ?? 0;
    try {
      const normalized = normalizeContextHistory(contract.history, {
        maxItems: 10000,
        maxBytes: 64 * 1024 * 1024,
      });
      if (normalized.historyRewritten)
        throw new AgentKernelError(
          "compaction_source_tool_boundary_invalid",
          false,
        );
    } catch (error) {
      if (error instanceof ContextHistoryError)
        throw new AgentKernelError(error.code, false, { cause: error });
      throw error;
    }
    const pending = new Map<string, "function" | "custom">();
    let partitionable = true;
    for (
      let index = this.#prefixLength;
      index < contract.history.length;
      index += 1
    ) {
      const item = contract.history[index]!;
      this.#bytes.push(this.#bytes.at(-1)! + itemBytes(item));
      if (item.type === "message") {
        if (item.role === "system" || item.role === "developer")
          partitionable = false;
      } else if (item.type === "tool_call") {
        pending.set(item.callId, item.kind);
      } else if (pending.get(item.callId) !== item.kind) {
        throw new AgentKernelError(
          "compaction_source_tool_boundary_invalid",
          false,
        );
      } else pending.delete(item.callId);
      if (pending.size === 0) this.#boundaries.push(index + 1);
    }
    if (pending.size !== 0)
      throw new AgentKernelError(
        "compaction_source_tool_boundary_invalid",
        false,
      );
    this.#partitionable = partitionable;
    const maxItems = contract.inputLimits?.maxItems ?? 256;
    const maxBytes = contract.inputLimits?.maxBytes ?? 512 * 1024;
    if (
      !Number.isSafeInteger(maxItems) ||
      maxItems < 2 ||
      maxItems > 10000 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 64 * 1024 * 1024
    )
      throw new AgentKernelError("compaction_input_limit_invalid", false);
    const prefixBytes =
      contract.history
        .slice(0, this.#prefixLength)
        .reduce((sum, item) => sum + itemBytes(item), 0) +
      itemBytes({
        type: "message",
        role: "user",
        content: CONTEXT_COMPACTION_PROMPT,
      });
    const ranges: CompactionSourceRange[] = [];
    let start = this.#prefixLength;
    let end = start;
    for (const boundary of this.#boundaries) {
      if (
        boundary - start + this.#prefixLength + 1 > maxItems ||
        this.bytes({ start, end: boundary }) + prefixBytes > maxBytes
      ) {
        if (end === start)
          throw new AgentKernelError(
            "compaction_source_unit_limit_exceeded",
            false,
          );
        ranges.push({ start, end });
        start = end;
        if (
          boundary - start + this.#prefixLength + 1 > maxItems ||
          this.bytes({ start, end: boundary }) + prefixBytes > maxBytes
        )
          throw new AgentKernelError(
            "compaction_source_unit_limit_exceeded",
            false,
          );
      }
      end = boundary;
      if (ranges.length >= MAX_COMPACTION_PARTS)
        throw new AgentKernelError(
          "compaction_partition_limit_exceeded",
          false,
        );
    }
    ranges.push({ start, end });
    if (ranges.length > 1 && !partitionable)
      throw new AgentKernelError("compaction_source_not_partitionable", false);
    this.ranges = ranges;
  }

  contains(range: CompactionSourceRange): boolean {
    return this.ranges.some(
      (parent) => range.start >= parent.start && range.end <= parent.end,
    );
  }

  isBoundary(index: number): boolean {
    return this.#boundaries.includes(index);
  }

  bytes(range: CompactionSourceRange): number {
    return (
      this.#bytes[range.end - this.#prefixLength]! -
      this.#bytes[range.start - this.#prefixLength]!
    );
  }

  history(range: CompactionSourceRange): readonly ContextHistoryItem[] {
    return [
      ...this.#contract.history.slice(0, this.#prefixLength),
      ...this.#contract.history.slice(range.start, range.end),
    ];
  }

  split(
    range: CompactionSourceRange,
  ): readonly [CompactionSourceRange, CompactionSourceRange] | null {
    if (!this.#partitionable) return null;
    const target = this.bytes(range) / 2;
    let middle: number | null = null;
    let distance = Infinity;
    for (const boundary of this.#boundaries) {
      if (boundary <= range.start) continue;
      if (boundary >= range.end) break;
      const candidate = Math.abs(
        this.bytes({ start: range.start, end: boundary }) - target,
      );
      if (candidate < distance) {
        middle = boundary;
        distance = candidate;
      }
    }
    return middle === null
      ? null
      : [
          { start: range.start, end: middle },
          { start: middle, end: range.end },
        ];
  }
}

function itemBytes(item: ContextHistoryItem): number {
  // Include message/Tool metadata as well as body bytes in the request projection budget.
  return Buffer.byteLength(JSON.stringify(item), "utf8");
}
