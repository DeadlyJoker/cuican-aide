import type { PluginUiLease } from "@crewon/contracts/plugins";

/** This stores approved code, never a lease, service object, props or authorization result. */
export class PluginUiModuleCodeCache {
  readonly #entries = new Map<string, unknown>();
  readonly #capacity = 8;

  async getOrImport(
    lease: PluginUiLease,
    operation: () => Promise<unknown>,
  ): Promise<unknown> {
    const cached = this.get(lease);
    if (cached !== undefined) return cached;
    // Before a first import, the bundle's resource contract is unknown. Keep
    // independent cold downloads parallel instead of serializing old plugins.
    return operation();
  }

  get(lease: PluginUiLease): unknown | undefined {
    const key = this.#key(lease);
    const value = this.#entries.get(key);
    if (value !== undefined) {
      this.#entries.delete(key);
      this.#entries.set(key, value);
    }
    return value;
  }

  /** Called only after the normal live fence and module identity validation. */
  remember(lease: PluginUiLease, module: object): void {
    if (!this.#selfContained(module)) return;
    const key = this.#key(lease);
    this.#entries.delete(key);
    this.#entries.set(key, module);
    if (this.#entries.size > this.#capacity)
      this.#entries.delete(this.#entries.keys().next().value!);
  }

  #selfContained(module: unknown): boolean {
    if (!module || typeof module !== "object") return false;
    // Mount-relative resources must keep their own URL and cannot be reused.
    // A self-contained bundle opts in through a named, literal ESM export.
    let mode: PropertyDescriptor | undefined;
    try {
      mode = Object.getOwnPropertyDescriptor(module, "crewonUiResourceMode");
    } catch {
      return false;
    }
    return !!mode && "value" in mode && mode.value === "self-contained.v1";
  }

  #key(lease: PluginUiLease): string {
    const entry = lease.descriptor.entrypoints.ui;
    return JSON.stringify([
      lease.descriptor.pluginId,
      lease.descriptor.publisherId,
      lease.descriptor.version,
      lease.packageDigest,
      entry?.path,
      lease.descriptor.files.find((file) => file.path === entry?.path)?.sha256,
    ]);
  }
}
