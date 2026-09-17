/** Conservative UI payload estimate, not a V8 heap or RSS measurement. */
export class ThreadDetailSize {
  readonly #sizes = new WeakMap<object, number>();
  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = limit;
  }

  measure(value: unknown): number {
    return this.#measure(value, new Set(), 0);
  }

  #measure(value: unknown, ancestors: Set<object>, depth: number): number {
    const overflow = this.#limit + 1;
    if (typeof value === "string")
      return Math.min(overflow, 24 + value.length * 2);
    if (value === null || value === undefined) return 8;
    if (typeof value === "boolean" || typeof value === "number") return 8;
    if (typeof value !== "object") return overflow;
    if (ancestors.has(value) || depth > 100) return overflow;
    const cached = this.#sizes.get(value);
    if (cached !== undefined) return cached;
    let size = 64;
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        for (const item of value) {
          size += 16 + this.#measure(item, ancestors, depth + 1);
          if (size > this.#limit) break;
        }
      } else {
        for (const key in value) {
          if (!Object.hasOwn(value, key)) continue;
          size += 16 + key.length * 2;
          if (size > this.#limit) break;
          size += this.#measure(
            (value as Record<string, unknown>)[key],
            ancestors,
            depth + 1,
          );
          if (size > this.#limit) break;
        }
      }
    } finally {
      ancestors.delete(value);
    }
    size = Math.min(overflow, size);
    // UI updates replace changed objects; weak keys cannot retain old payloads.
    this.#sizes.set(value, size);
    return size;
  }
}
