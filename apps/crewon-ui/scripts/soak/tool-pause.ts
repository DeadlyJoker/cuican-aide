/** One test-owned barrier; it never keeps request bodies or application task state. */
export class SoakToolPause {
  #entry: {
    marker: string;
    waiting: boolean;
    release: (() => void) | null;
    reject: ((error: Error) => void) | null;
    timer: ReturnType<typeof setTimeout> | null;
  } | null = null;
  #paused = 0;
  #released = 0;
  #failed = 0;
  #closed = false;
  readonly #timeoutMs: number;
  constructor(timeoutMs = 30000) {
    this.#timeoutMs = timeoutMs;
  }
  arm(marker: string): void {
    if (this.#closed || this.#entry || !/^SOAK-tool-\d+$/.test(marker))
      throw new Error("soak_pause_arm_invalid");
    this.#entry = {
      marker,
      waiting: false,
      release: null,
      reject: null,
      timer: null,
    };
  }
  async wait(marker: string, callId: string | undefined): Promise<void> {
    const entry = this.#entry;
    if (!entry || entry.marker !== marker || callId !== `fixture_${marker}_2`)
      return;
    if (entry.waiting) throw new Error("soak_pause_duplicate_request");
    entry.waiting = true;
    this.#paused++;
    await new Promise<void>((resolve, reject) => {
      entry.release = resolve;
      entry.reject = reject;
      entry.timer = setTimeout(
        () => this.#fail("soak_pause_timeout"),
        this.#timeoutMs,
      );
    });
  }
  release(marker: string): void {
    const entry = this.#entry;
    if (!entry || !entry.waiting || entry.marker !== marker)
      throw new Error("soak_pause_release_invalid");
    if (entry.timer) clearTimeout(entry.timer);
    this.#entry = null;
    this.#released++;
    entry.release!();
  }
  snapshot() {
    return {
      current: this.#entry
        ? { marker: this.#entry.marker, waiting: this.#entry.waiting }
        : null,
      paused: this.#paused,
      released: this.#released,
      failed: this.#failed,
    };
  }
  close(): void {
    this.#closed = true;
    this.#fail("soak_pause_closed");
  }
  #fail(code: string): void {
    const entry = this.#entry;
    this.#entry = null;
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.#failed++;
    entry.reject?.(new Error(code));
  }
}
