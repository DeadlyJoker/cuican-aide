import type { PluginProjectGenerationReadClient } from "@crewon/plugin-sdk/ui";
import type {
  ConceptGenerationLocator,
  PublicConceptGeneration,
} from "@crewon/plugin-sdk/contracts";

export type ConceptGenerationSnapshot = Readonly<{
  phase: "idle" | "loading" | "ready" | "unavailable";
  source: ConceptGenerationLocator | null;
  generation: PublicConceptGeneration | null;
}>;
const initial = (): ConceptGenerationSnapshot => ({
  phase: "idle",
  source: null,
  generation: null,
});

/** Observes one immutable saved input. Refresh never generates, polls a supplier or selects a result. */
export class ConceptGenerationController {
  readonly #read: PluginProjectGenerationReadClient["getConceptGeneration"];
  readonly #listeners = new Set<() => void>();
  #snapshot = initial();
  #key: string | null = null;
  #disposed = false;
  #pending: AbortController | null = null;
  constructor(client: PluginProjectGenerationReadClient) {
    this.#read = client.getConceptGeneration.bind(client);
  }
  getSnapshot = () => this.#snapshot;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  #update(change: Partial<ConceptGenerationSnapshot>) {
    if (this.#disposed) return;
    this.#snapshot = { ...this.#snapshot, ...change };
    for (const listener of this.#listeners) listener();
  }
  bind(source: ConceptGenerationLocator | null, ready: boolean) {
    if (this.#disposed) return;
    const next = ready && source ? Object.freeze({ ...source }) : null;
    const key =
      next === null
        ? null
        : JSON.stringify([next.projectId, next.assetId, next.assetRevision]);
    if (key === this.#key) return;
    this.#pending?.abort();
    this.#pending = null;
    this.#key = key;
    this.#update({ ...initial(), source: next });
    if (next !== null) void this.refresh();
  }
  async refresh() {
    const source = this.#snapshot.source;
    if (this.#disposed || source === null) return;
    this.#pending?.abort();
    const controller = new AbortController();
    this.#pending = controller;
    const key = this.#key;
    const current = () =>
      !this.#disposed &&
      !controller.signal.aborted &&
      this.#pending === controller &&
      this.#key === key;
    // A failed or pending observation cannot masquerade as a previous successful record.
    this.#update({ phase: "loading", generation: null });
    try {
      const response = await this.#read(source, { signal: controller.signal });
      if (current())
        this.#update({ phase: "ready", generation: response.generation });
    } catch {
      if (current()) this.#update({ phase: "unavailable", generation: null });
    } finally {
      if (this.#pending === controller) this.#pending = null;
    }
  }
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#pending?.abort();
    this.#pending = null;
    this.#key = null;
    this.#listeners.clear();
  }
}
