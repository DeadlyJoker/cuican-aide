import type {
  AgentVersionRuntime,
  AgentVersionRuntimeLocator,
} from "./agent-version-runtime.ts";

const MAX_ENTRIES = 64;
const MAX_DEFINITION_BYTES = 8 * 1024 * 1024;

/** Only resource-free projections belong here. Removing a reference never closes a runtime. */
export class SharedAgentRuntimeCache {
  readonly #entries = new Map<
    string,
    { runtime: AgentVersionRuntime; bytes: number }
  >();
  #definitionBytes = 0;

  get(locator: AgentVersionRuntimeLocator): AgentVersionRuntime | null {
    const key = cacheKey(locator);
    const entry = this.#entries.get(key);
    if (entry === undefined) return null;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.runtime;
  }

  put(locator: AgentVersionRuntimeLocator, runtime: AgentVersionRuntime): void {
    const key = cacheKey(locator);
    // This accounts for serialized definitions and identity, not total V8 heap.
    const bytes =
      Buffer.byteLength(key) +
      Buffer.byteLength(JSON.stringify(runtime.version));
    if (bytes > MAX_DEFINITION_BYTES) return;
    const previous = this.#entries.get(key);
    if (previous !== undefined) this.#remove(key, previous.bytes);
    while (
      this.#entries.size >= MAX_ENTRIES ||
      this.#definitionBytes + bytes > MAX_DEFINITION_BYTES
    ) {
      const [oldestKey, oldest] = this.#entries.entries().next().value!;
      this.#remove(oldestKey, oldest.bytes);
    }
    this.#entries.set(key, { runtime: Object.freeze(runtime), bytes });
    this.#definitionBytes += bytes;
  }

  clear(): void {
    this.#entries.clear();
    this.#definitionBytes = 0;
  }

  snapshot() {
    return {
      entries: this.#entries.size,
      definitionBytes: this.#definitionBytes,
      maxEntries: MAX_ENTRIES,
      maxDefinitionBytes: MAX_DEFINITION_BYTES,
    };
  }

  #remove(key: string, bytes: number): void {
    this.#entries.delete(key);
    this.#definitionBytes -= bytes;
  }
}

function cacheKey(locator: AgentVersionRuntimeLocator): string {
  return JSON.stringify([locator.tenantId, locator.agentVersionId]);
}
