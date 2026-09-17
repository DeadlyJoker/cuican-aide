import { createHash } from "node:crypto";
import { AgentKernelError, type AgentKernelPort } from "@crewon/agent-kernel";
import { cacheReadReportingError } from "@crewon/domain";
import {
  CONTEXT_COMPACTION_PROMPT,
  type ContextCompactionContract,
  type ContextCompactionResult,
  type ContextCompactionCheckpointPort,
} from "@crewon/context";
import {
  CompactionSourcePlan,
  COMPACTION_PART_HEADER,
  COMPACTION_PART_SEPARATOR,
  MAX_COMPACTION_PARTS,
  MIN_COMPACTION_PART_OUTPUT_BYTES,
  type CompactionSourceRange,
} from "./compaction-source-plan.ts";
import { MAX_COMPACTION_CONTEXT_ATTEMPTS } from "./compaction-recovery-history.ts";
import { aggregateCompactionResults } from "./compaction-result-aggregate.ts";
const SCHEMA = "crewon.compaction-progress.v1";
const MAX_PAYLOAD_BYTES = 256 * 1024;
type Part = Readonly<{ range: CompactionSourceRange; outputBudget: number }>;
type FinishedPart = Part &
  Readonly<{
    result: ContextCompactionResult;
    segmentId: string;
    attempt: number;
  }>;
type State = {
  schemaVersion: typeof SCHEMA;
  pending: Part[];
  results: FinishedPart[];
  failures: number;
  parts: number;
  headerReserved: boolean;
};

/** One bounded staging row, overwritten only after a complete part or a known overflow split. */
export class CompactionProgress {
  readonly plan: CompactionSourcePlan;
  readonly #contract: ContextCompactionContract;
  readonly #checkpoint: ContextCompactionCheckpointPort | undefined;
  readonly #contextDigest: string;
  #revision = 0;
  #state: State;
  private constructor(
    contract: ContextCompactionContract,
    plan: CompactionSourcePlan,
    state: State,
    checkpoint: ContextCompactionCheckpointPort | undefined,
    contextDigest: string,
  ) {
    this.#contract = contract;
    this.plan = plan;
    this.#state = state;
    this.#checkpoint = checkpoint;
    this.#contextDigest = contextDigest;
  }
  static async open(
    contract: ContextCompactionContract,
    kernel: AgentKernelPort,
    checkpoint: ContextCompactionCheckpointPort | undefined,
    signal: AbortSignal,
  ): Promise<CompactionProgress> {
    const plan = new CompactionSourcePlan(contract);
    const segmented = plan.ranges.length > 1;
    const available =
      contract.maxOutputBytes -
      (segmented
        ? Buffer.byteLength(COMPACTION_PART_HEADER) +
          Buffer.byteLength(COMPACTION_PART_SEPARATOR) *
            (plan.ranges.length - 1)
        : 0);
    const outputBudget = Math.floor(available / plan.ranges.length);
    if (segmented && outputBudget < MIN_COMPACTION_PART_OUTPUT_BYTES)
      throw new AgentKernelError(
        "compaction_output_budget_insufficient",
        false,
      );
    const state: State = {
      schemaVersion: SCHEMA,
      pending: plan.ranges.map((range) => ({ range, outputBudget })),
      results: [],
      failures: 0,
      parts: plan.ranges.length,
      headerReserved: segmented,
    };
    let digest = "";
    if (checkpoint !== undefined) {
      if (kernel.compactionContextDigest === undefined)
        throw new AgentKernelError(
          "compaction_checkpoint_identity_unavailable",
          false,
        );
      const hash = createHash("sha256").update(
        JSON.stringify([
          SCHEMA,
          await kernel.compactionContextDigest(),
          kernel.modelIdentity,
          contract.runId,
          contract.agentVersionId,
          contract.policySnapshotId,
          contract.protectedPrefixLength ?? 0,
          contract.inputLimits ?? { maxItems: 256, maxBytes: 512 * 1024 },
          contract.maxOutputBytes,
          CONTEXT_COMPACTION_PROMPT,
          COMPACTION_PART_HEADER,
          COMPACTION_PART_SEPARATOR,
          MAX_COMPACTION_PARTS,
          MAX_COMPACTION_CONTEXT_ATTEMPTS,
          MIN_COMPACTION_PART_OUTPUT_BYTES,
        ]),
      );
      for (const item of contract.history)
        hash.update(JSON.stringify(item)).update("\n");
      digest = hash.digest("hex");
    }
    signal.throwIfAborted();
    const progress = new CompactionProgress(
      contract,
      plan,
      state,
      checkpoint,
      digest,
    );
    if (checkpoint !== undefined) {
      const restored = await checkpoint.load(digest);
      signal.throwIfAborted();
      if (restored !== null) {
        if (
          !Number.isSafeInteger(restored.revision) ||
          restored.revision < 1 ||
          restored.revision > 32 ||
          Buffer.byteLength(restored.payload) > MAX_PAYLOAD_BYTES
        )
          throw invalid();
        try {
          progress.#state = JSON.parse(restored.payload);
          progress.validate();
        } catch (error) {
          if (error instanceof AgentKernelError) throw error;
          throw invalid();
        }
        progress.#revision = restored.revision;
      }
    }
    return progress;
  }
  next(): Part | undefined {
    return this.#state.pending[0];
  }
  async completed(result: ContextCompactionResult): Promise<void> {
    const next = this.#state.pending.shift()!;
    this.#state.results.push({
      ...next,
      result,
      segmentId: this.#contract.segmentId,
      attempt: this.#contract.attempt,
    });
    this.validate();
    await this.save();
  }
  async overflow(error: AgentKernelError): Promise<void> {
    const next = this.#state.pending[0]!;
    if (
      this.#state.failures + 1 >= MAX_COMPACTION_CONTEXT_ATTEMPTS ||
      this.#state.parts >= MAX_COMPACTION_PARTS
    )
      throw error;
    const split = this.plan.split(next.range);
    const budget = Math.floor(
      (next.outputBudget -
        Buffer.byteLength(COMPACTION_PART_SEPARATOR) -
        (this.#state.headerReserved
          ? 0
          : Buffer.byteLength(COMPACTION_PART_HEADER))) /
        2,
    );
    if (split === null || budget < MIN_COMPACTION_PART_OUTPUT_BYTES)
      throw error;
    this.#state.failures += 1;
    this.#state.parts += 1;
    this.#state.headerReserved = true;
    this.#state.pending.splice(
      0,
      1,
      ...split.map((range) => ({ range, outputBudget: budget })),
    );
    this.validate();
    await this.save();
  }
  result(): ContextCompactionResult {
    this.validate();
    if (this.#state.pending.length) throw invalid();
    return aggregateCompactionResults(
      this.#state.results.map((part) => part.result),
      this.#contract.maxOutputBytes,
    );
  }
  private async save(): Promise<void> {
    if (this.#checkpoint === undefined) return;
    const payload = JSON.stringify(this.#state);
    if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) throw invalid();
    const revision = await this.#checkpoint.save({
      contextDigest: this.#contextDigest,
      expectedRevision: this.#revision,
      payload,
    });
    if (revision !== this.#revision + 1) throw invalid();
    this.#revision = revision;
  }
  private validate(): void {
    const state = this.#state;
    if (
      !state ||
      Object.keys(state).sort().join(",") !==
        "failures,headerReserved,parts,pending,results,schemaVersion" ||
      state.schemaVersion !== SCHEMA ||
      !Array.isArray(state.pending) ||
      !Array.isArray(state.results) ||
      !Number.isSafeInteger(state.failures) ||
      state.failures < 0 ||
      state.failures >= MAX_COMPACTION_CONTEXT_ATTEMPTS ||
      state.parts !== this.plan.ranges.length + state.failures ||
      state.parts < 1 ||
      state.parts > MAX_COMPACTION_PARTS ||
      state.pending.length + state.results.length !== state.parts ||
      state.headerReserved !== state.parts > 1
    )
      throw invalid();
    let cursor = this.#contract.protectedPrefixLength ?? 0;
    let bytes = state.headerReserved
      ? Buffer.byteLength(COMPACTION_PART_HEADER) +
        Buffer.byteLength(COMPACTION_PART_SEPARATOR) * (state.parts - 1)
      : 0;
    for (const part of [...state.results, ...state.pending]) {
      if (
        !part ||
        !part.range ||
        Object.keys(part.range).sort().join(",") !== "end,start" ||
        !Number.isSafeInteger(part.range.start) ||
        !Number.isSafeInteger(part.range.end) ||
        part.range.start !== cursor ||
        part.range.end <= cursor ||
        !this.plan.isBoundary(part.range.end) ||
        !this.plan.contains(part.range) ||
        !Number.isSafeInteger(part.outputBudget) ||
        part.outputBudget <
          (state.parts > 1 ? MIN_COMPACTION_PART_OUTPUT_BYTES : 1)
      )
        throw invalid();
      cursor = part.range.end;
      bytes += part.outputBudget;
    }
    if (
      cursor !== this.#contract.history.length ||
      bytes > this.#contract.maxOutputBytes
    )
      throw invalid();
    for (const part of state.pending)
      if (Object.keys(part).sort().join(",") !== "outputBudget,range")
        throw invalid();
    for (const part of state.results) {
      if (
        Object.keys(part).sort().join(",") !==
          "attempt,outputBudget,range,result,segmentId" ||
        typeof part.segmentId !== "string" ||
        !part.segmentId.length ||
        part.segmentId.length > 512 ||
        !Number.isSafeInteger(part.attempt) ||
        part.attempt < 1 ||
        !part.result ||
        Object.keys(part.result).sort().join(",") !== "summary,usage" ||
        typeof part.result.summary !== "string" ||
        !part.result.summary.trim() ||
        Buffer.byteLength(part.result.summary) > part.outputBudget
      )
        throw invalid();
      const usage = part.result.usage;
      if (
        !usage ||
        Object.keys(usage).some(
          (key) =>
            ![
              "inputTokens",
              "cachedInputTokens",
              "cachedInputTokensReported",
              "outputTokens",
              "totalTokens",
            ].includes(key),
        ) ||
        cacheReadReportingError(usage) !== null ||
        [
          usage.inputTokens,
          usage.cachedInputTokens,
          usage.outputTokens,
          usage.totalTokens,
        ].some((value) => !Number.isSafeInteger(value) || value < 0) ||
        usage.cachedInputTokens > usage.inputTokens ||
        usage.totalTokens !== usage.inputTokens + usage.outputTokens
      )
        throw invalid();
    }
  }
}
function invalid(): AgentKernelError {
  return new AgentKernelError("compaction_checkpoint_state_invalid", false);
}
