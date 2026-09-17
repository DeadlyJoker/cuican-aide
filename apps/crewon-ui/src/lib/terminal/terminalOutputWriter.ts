import type { TerminalOutputStream } from "./terminalOutputStream";

type TerminalOutputSink = Readonly<{
  reset: () => void;
  write: (text: string, onWritten: () => void) => void;
}>;

/** Keeps one xterm write in flight and one bounded, replaceable tail snapshot. */
export class TerminalOutputWriter {
  readonly #sink: TerminalOutputSink;
  #latest: TerminalOutputStream | null = null;
  #generation: number | null = null;
  #offset = 0;
  #writing = false;
  #closed = false;

  constructor(sink: TerminalOutputSink) {
    this.#sink = sink;
  }

  update(stream: TerminalOutputStream): void {
    if (this.#closed) return;
    this.#latest = stream;
    this.#flush();
  }

  dispose(): void {
    this.#closed = true;
    this.#latest = null;
  }

  #flush(): void {
    if (this.#closed || this.#writing || this.#latest === null) return;
    const stream = this.#latest;
    this.#latest = null;
    const endOffset = stream.startOffset + stream.text.length;
    if (
      this.#generation !== stream.generation ||
      this.#offset < stream.startOffset ||
      this.#offset > endOffset
    ) {
      // A new instance already has an empty screen. A missed tail or restart
      // resets only after the previous asynchronous write has drained.
      if (this.#generation !== null) this.#sink.reset();
      this.#generation = stream.generation;
      this.#offset = stream.startOffset;
    }
    const text = stream.text.slice(this.#offset - stream.startOffset);
    this.#offset = endOffset;
    if (!text) return;
    this.#writing = true;
    this.#sink.write(text, () => {
      this.#writing = false;
      this.#flush();
    });
  }
}
