import type { RunState } from "@crewon/domain";
import type { ThreadScopedLocator } from "@crewon/application";

const key = (value: ThreadScopedLocator) =>
  JSON.stringify([value.tenantId, value.spaceId, value.threadId]);
const live = (state: RunState) =>
  !["completed", "failed", "canceled"].includes(state.status);

/** Maintained by every snapshot mutation; terminal history never enters the live index. */
export class InMemoryRunMap extends Map<string, RunState> {
  readonly #active = new Map<string, Set<string>>();
  override set(id: string, state: RunState): this {
    this.#unlink(id);
    super.set(id, state);
    if (live(state)) {
      const scope = key(state);
      const ids = this.#active.get(scope) ?? new Set<string>();
      ids.add(id);
      this.#active.set(scope, ids);
    }
    return this;
  }
  override delete(id: string): boolean {
    this.#unlink(id);
    return super.delete(id);
  }
  #unlink(id: string): void {
    const prior = this.get(id);
    if (prior !== undefined && live(prior)) {
      const scope = key(prior);
      const ids = this.#active.get(scope);
      ids?.delete(id);
      if (ids?.size === 0) this.#active.delete(scope);
    }
  }
  override clear(): void {
    super.clear();
    this.#active.clear();
  }
  activeInThread(locator: ThreadScopedLocator): readonly RunState[] {
    const result: RunState[] = [];
    for (const id of this.#active.get(key(locator)) ?? []) {
      result.push(this.get(id)!);
      if (result.length === 2) break;
    }
    return result;
  }
}
