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

export class InMemoryModelCallStore implements ModelCallStore {
  readonly #byKey = new Map<string, ModelCallEntry>();
  readonly #byRun = new Map<string, ModelCallEntry[]>();
  readonly #validateAuthority: (input: RecordModelCallInput) => void;
  constructor(validateAuthority: (input: RecordModelCallInput) => void) {
    this.#validateAuthority = validateAuthority;
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
      if (merged !== null) {
        const entry = { order: prior.order, record: structuredClone(merged) };
        this.#byKey.set(key, entry);
        this.#byRun.get(runKey)![prior.order - 1] = entry;
        return "enriched";
      }
      return "replayed";
    }
    validateNewModelCall(input.record);
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
