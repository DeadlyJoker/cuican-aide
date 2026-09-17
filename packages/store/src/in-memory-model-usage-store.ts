import type {
  ModelUsageEntry,
  ModelUsagePageQuery,
  ModelUsageStore,
  RecordModelUsageInput,
} from "@crewon/application";
import { RunStoreError } from "@crewon/application";
import { modelUsageCallKey } from "./model-usage-identity.ts";
import {
  preserveUsageGeneration,
  assertUsageGenerationReplay,
  needsUsageGenerationCheck,
} from "./model-usage-generation.ts";
import type { ModelCallRecord, ModelUsageRecord } from "@crewon/domain";
import { completedCallUsage } from "./model-usage-call-completion.ts";
import {
  modelUsageKey,
  modelUsageLookupKey,
  validateModelUsageInput,
  validateModelUsagePage,
  mergeModelUsageReplay,
} from "./model-usage-store-support.ts";

export class InMemoryModelUsageStore implements ModelUsageStore {
  readonly #byKey = new Map<string, ModelUsageEntry>();
  readonly #byRun = new Map<string, ModelUsageEntry[]>();
  readonly #byCall = new Map<string, number>();
  readonly #callScopes = new Map<string, string>();
  readonly #validateAuthority: (input: RecordModelUsageInput) => void;
  readonly #generation: (
    record: ModelUsageRecord,
  ) => ModelUsageRecord["generation"];
  readonly #settleSpending: (record: ModelUsageRecord) => void;
  constructor(
    validateAuthority: (input: RecordModelUsageInput) => void,
    generation: (record: ModelUsageRecord) => ModelUsageRecord["generation"],
    options: { settleSpending?: (record: ModelUsageRecord) => void } = {},
  ) {
    this.#generation = generation;
    this.#validateAuthority = validateAuthority;
    this.#settleSpending = options.settleSpending ?? (() => {});
  }

  async recordModelUsage(
    input: RecordModelUsageInput,
  ): Promise<"recorded" | "enriched" | "replayed"> {
    validateModelUsageInput(input);
    this.#validateAuthority(input);
    const key = modelUsageKey(input.record);
    const runKey = JSON.stringify([input.record.tenantId, input.record.runId]);
    const callKey = modelUsageCallKey(input.record);
    const invocation = JSON.stringify([
      input.record.tenantId,
      input.record.runId,
      input.record.observation.callId,
    ]);
    const knownScope =
      callKey === null ? undefined : this.#callScopes.get(invocation);
    if (knownScope !== undefined && knownScope !== callKey)
      throw new RunStoreError("model_usage_conflict");
    const bindCall = (order: number) => {
      if (callKey !== null) {
        this.#byCall.set(callKey, order);
        this.#callScopes.set(invocation, callKey);
      }
    };
    const aliasOrder = callKey === null ? undefined : this.#byCall.get(callKey);
    const aliased =
      aliasOrder === undefined
        ? undefined
        : this.#byRun.get(runKey)?.[aliasOrder - 1];
    const keyed = this.#byKey.get(key);
    if (
      keyed !== undefined &&
      aliased !== undefined &&
      keyed.order !== aliased.order
    )
      throw new RunStoreError("model_usage_conflict");
    const prior = keyed ?? aliased;
    if (prior !== undefined) {
      if (
        needsUsageGenerationCheck(
          prior.record,
          input.record,
          aliased !== undefined,
        )
      )
        assertUsageGenerationReplay(
          prior.record,
          this.#generation(input.record),
        );
      const merged = mergeModelUsageReplay(prior.record, input.record, {
        verifiedCallAlias: aliased !== undefined,
      });
      this.#settleSpending(merged ?? prior.record);
      if (merged !== null) {
        const entry = { order: prior.order, record: structuredClone(merged) };
        this.#byKey.delete(modelUsageKey(prior.record));
        this.#byKey.set(modelUsageKey(merged), entry);
        this.#byRun.get(runKey)![prior.order - 1] = entry;
        bindCall(entry.order);
        return "enriched";
      }
      bindCall(prior.order);
      return "replayed";
    }
    const entries = this.#byRun.get(runKey) ?? [];
    const entry = {
      order: entries.length + 1,
      record: structuredClone(
        preserveUsageGeneration(input.record, this.#generation(input.record)),
      ),
    };
    this.#settleSpending(entry.record);
    entries.push(entry);
    this.#byRun.set(runKey, entries);
    this.#byKey.set(key, entry);
    bindCall(entry.order);
    return "recorded";
  }

  completeCallUsage(call: ModelCallRecord): void {
    if (
      call.observation.outcome === "unknown" ||
      call.observation.providerResponseId === null ||
      !call.observation.usageEventObserved
    )
      return;
    const callKey = modelUsageLookupKey({
      ...call,
      identity: ["call", call.observation.callId],
    });
    const order = this.#byCall.get(callKey);
    if (order === undefined) return;
    const run = this.#byRun.get(JSON.stringify([call.tenantId, call.runId]))!;
    const prior = run[order - 1]!;
    const merged = completedCallUsage(prior.record, call);
    if (merged === null) return;
    const key = modelUsageKey(merged),
      existing = this.#byKey.get(key);
    if (existing !== undefined && existing.order !== prior.order)
      throw new RunStoreError("model_usage_conflict");
    const entry = { order, record: structuredClone(merged) };
    this.#byKey.delete(modelUsageKey(prior.record));
    this.#byKey.set(key, entry);
    run[order - 1] = entry;
  }
  async listModelUsage(
    query: ModelUsagePageQuery,
  ): Promise<readonly ModelUsageEntry[]> {
    validateModelUsagePage(query);
    const entries =
      this.#byRun.get(JSON.stringify([query.tenantId, query.runId])) ?? [];
    return structuredClone(
      entries.slice(query.afterOrder, query.afterOrder + query.limit),
    );
  }
}
