import type {
  ModelUsageEntry,
  ModelUsagePageQuery,
  ModelUsageStore,
  RecordModelUsageInput,
} from "@crewon/application";
import {
  modelUsageKey,
  validateModelUsageInput,
  validateModelUsagePage,
  mergeModelUsageReplay,
} from "./model-usage-store-support.ts";

export class InMemoryModelUsageStore implements ModelUsageStore {
  readonly #byKey = new Map<string, ModelUsageEntry>();
  readonly #byRun = new Map<string, ModelUsageEntry[]>();
  readonly #validateAuthority: (input: RecordModelUsageInput) => void;
  constructor(validateAuthority: (input: RecordModelUsageInput) => void) {
    this.#validateAuthority = validateAuthority;
  }

  async recordModelUsage(
    input: RecordModelUsageInput,
  ): Promise<"recorded" | "enriched" | "replayed"> {
    validateModelUsageInput(input);
    this.#validateAuthority(input);
    const key = modelUsageKey(input.record);
    const runKey = JSON.stringify([input.record.tenantId, input.record.runId]);
    const prior = this.#byKey.get(key);
    if (prior !== undefined) {
      const merged = mergeModelUsageReplay(prior.record, input.record);
      if (merged !== null) {
        const entry = { order: prior.order, record: structuredClone(merged) };
        this.#byKey.set(key, entry);
        this.#byRun.get(runKey)![prior.order - 1] = entry;
        return "enriched";
      }
      return "replayed";
    }
    const entries = this.#byRun.get(runKey) ?? [];
    const entry = {
      order: entries.length + 1,
      record: structuredClone(input.record),
    };
    entries.push(entry);
    this.#byRun.set(runKey, entries);
    this.#byKey.set(key, entry);
    return "recorded";
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
