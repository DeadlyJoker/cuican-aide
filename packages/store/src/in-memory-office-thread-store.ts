import {
  RunStoreError,
  type BindOfficeThreadInput,
  type BindOfficeThreadResult,
  type OfficeLocator,
  type OfficeThreadBinding,
  type OfficeThreadLocator,
  type ThreadScopedLocator,
} from "@crewon/application";
import type { OfficeDefinition, ThreadState } from "@crewon/domain";
import {
  assertOfficeThreadAdoption,
  assertOfficeThreadDefinition,
  validateOfficeThreadAdoption,
  validateOfficeThreadLocator,
} from "./office-thread-binding.ts";

export class InMemoryOfficeThreadStore {
  readonly #bindings = new Map<string, OfficeThreadBinding>();
  readonly #owners = new Map<string, string>();
  private readonly loadOffice: (
    locator: OfficeLocator,
  ) => OfficeDefinition | null;
  private readonly loadThread: (
    locator: ThreadScopedLocator,
  ) => ThreadState | null;
  constructor(
    loadOffice: (locator: OfficeLocator) => OfficeDefinition | null,
    loadThread: (locator: ThreadScopedLocator) => ThreadState | null,
  ) {
    this.loadOffice = loadOffice;
    this.loadThread = loadThread;
  }

  load(locator: OfficeThreadLocator): OfficeThreadBinding | null {
    validateOfficeThreadLocator(locator);
    return structuredClone(this.#bindings.get(key(locator)) ?? null);
  }

  assertOffice(binding: OfficeThreadBinding): void {
    assertOfficeThreadDefinition(binding, this.loadOffice(binding));
  }

  assertAvailable(binding: OfficeThreadBinding): void {
    if (this.#bindings.has(key(binding)))
      throw new RunStoreError("office_thread_already_bound");
    if (this.#owners.has(threadKey(binding)))
      throw new RunStoreError("office_thread_already_claimed");
  }

  insert(binding: OfficeThreadBinding): void {
    this.#bindings.set(key(binding), structuredClone(binding));
    this.#owners.set(threadKey(binding), binding.officeId);
  }

  bind(input: BindOfficeThreadInput): BindOfficeThreadResult {
    validateOfficeThreadAdoption(input);
    const { binding } = input;
    this.assertOffice(binding);
    const prior = this.load(binding);
    if (prior !== null) {
      if (prior.threadId !== binding.threadId)
        throw new RunStoreError("office_thread_already_bound");
      return { disposition: "existing", binding: prior };
    }
    this.assertAvailable(binding);
    assertOfficeThreadAdoption(input, this.loadThread(binding));
    this.insert(binding);
    return { disposition: "bound", binding: structuredClone(binding) };
  }
}

function key(locator: OfficeThreadLocator): string {
  return JSON.stringify([locator.tenantId, locator.spaceId, locator.officeId]);
}
function threadKey(binding: OfficeThreadBinding): string {
  return JSON.stringify([binding.tenantId, binding.spaceId, binding.threadId]);
}
