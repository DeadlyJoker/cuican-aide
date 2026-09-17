import { preserveModelCallPricing } from "./model-pricing-store-support.ts";
import type { ModelTokenPricingSnapshot } from "@crewon/domain";
import type {
  ModelCallEntry,
  ModelUsagePageQuery,
  ModelCallStore,
  RecordModelCallInput,
} from "@crewon/application";
import {
  modelCallKey,
  validateNewModelCall,
  validateModelCallInput,
  mergeModelCallReplay,
} from "./model-call-store-support.ts";
import { validateModelUsagePage } from "./model-usage-store-support.ts";
import {
  generationResponseKey,
  usageGeneration,
  usageGenerationLookup,
} from "./model-usage-generation.ts";
import type {
  ModelCallRecord,
  ModelUsageRecord,
  RunState,
} from "@crewon/domain";
import { attributeNewModelCall } from "./model-call-goal-attribution.ts";

export class InMemoryModelCallStore implements ModelCallStore {
  readonly #byKey = new Map<string, ModelCallEntry>();
  readonly #byRun = new Map<string, ModelCallEntry[]>();
  readonly #generationResponses = new Map<string, string | null>();
  readonly #validateAuthority: (input: RecordModelCallInput) => void;
  readonly #completeUsage: (record: ModelCallRecord) => void;
  readonly #pricing: (
    record: ModelCallRecord,
  ) => ModelTokenPricingSnapshot | undefined;
  readonly #loadRun: (record: ModelCallRecord) => RunState | null;
  readonly #reserveSpending: (record: ModelCallRecord, run: RunState) => void;
  constructor(
    validateAuthority: (input: RecordModelCallInput) => void,
    options: {
      completeUsage: (record: ModelCallRecord) => void;
      pricing: (
        record: ModelCallRecord,
      ) => ModelTokenPricingSnapshot | undefined;
      loadRun: (record: ModelCallRecord) => RunState | null;
      reserveSpending?: (record: ModelCallRecord, run: RunState) => void;
    },
  ) {
    this.#validateAuthority = validateAuthority;
    this.#completeUsage = options.completeUsage;
    this.#loadRun = options.loadRun;
    this.#pricing = options.pricing;
    this.#reserveSpending = options.reserveSpending ?? (() => {});
  }

  async recordModelCall(
    input: RecordModelCallInput,
  ): Promise<"recorded" | "enriched" | "replayed"> {
    validateModelCallInput(input);
    this.#validateAuthority(input);
    const key = modelCallKey(input.record);
    const runKey = JSON.stringify([input.record.tenantId, input.record.runId]);
    const prior = this.#byKey.get(key);
    if (prior !== undefined) {
      const merged = mergeModelCallReplay(prior.record, input.record);
      this.#completeUsage(merged ?? prior.record);
      const responseKey = generationResponseKey(merged ?? prior.record);
      if (responseKey !== null) {
        const owner = this.#generationResponses.get(responseKey);
        this.#generationResponses.set(
          responseKey,
          owner === undefined || owner === key ? key : null,
        );
      }
      if (merged !== null) {
        const entry = { order: prior.order, record: structuredClone(merged) };
        this.#byKey.set(key, entry);
        this.#byRun.get(runKey)![prior.order - 1] = entry;
        return "enriched";
      }
      return "replayed";
    }
    validateNewModelCall(input.record);
    const run = this.#loadRun(input.record);
    const entries = this.#byRun.get(runKey) ?? [];
    const entry = {
      order: entries.length + 1,
      record: structuredClone(
        preserveModelCallPricing(
          attributeNewModelCall(input.record, run),
          input.record.observation.operation !== "generate" ||
            input.record.observation.transport === "cloudAgent"
            ? undefined
            : this.#pricing(input.record),
        ),
      ),
    };
    this.#reserveSpending(entry.record, run!);
    entries.push(entry);
    this.#byRun.set(runKey, entries);
    this.#byKey.set(key, entry);
    return "recorded";
  }
  generationForUsage(record: ModelUsageRecord): ModelUsageRecord["generation"] {
    if (record.observation.callId === undefined) return undefined;
    const call =
      this.#byKey.get(
        modelCallKey({
          ...record,
          observation: { callId: record.observation.callId },
        }),
      )?.record ?? null;
    const lookup = usageGenerationLookup(record, call);
    if (lookup.kind === "unknown") return undefined;
    if (lookup.kind === "generate") return usageGeneration(record, lookup.call);
    const key = this.#generationResponses.get(lookup.responseKey);
    return usageGeneration(
      record,
      key == null ? null : (this.#byKey.get(key)?.record ?? null),
      lookup.responseKey,
    );
  }
  async listModelCalls(
    query: ModelUsagePageQuery,
  ): Promise<readonly ModelCallEntry[]> {
    validateModelUsagePage(query);
    const entries =
      this.#byRun.get(JSON.stringify([query.tenantId, query.runId])) ?? [];
    return structuredClone(
      entries.slice(query.afterOrder, query.afterOrder + query.limit),
    );
  }
}
