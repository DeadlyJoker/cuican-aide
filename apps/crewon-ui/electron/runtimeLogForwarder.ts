import type { ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const MAX_QUEUED_BYTES = 128 * 1024;
const MAX_QUEUED_CHUNKS = 64;
const MAX_WRITE_BYTES = 16 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;

type LogChannel = "stdout" | "stderr";

/** Bounds diagnostic buffering; synchronous destinations can still block a write. */
export class RuntimeLogForwarder {
  readonly #outputs: Record<LogChannel, BoundedLogOutput>;

  constructor(outputs: Record<LogChannel, Writable>) {
    this.#outputs = {
      stdout: new BoundedLogOutput(outputs.stdout),
      stderr: new BoundedLogOutput(outputs.stderr),
    };
  }

  write(channel: LogChannel, source: string, chunk: Uint8Array | string): void {
    this.#outputs[channel].append(source, chunk);
  }

  /** Reuse these outputs across restarts, including any still blocked write. */
  resume(): void {
    for (const output of Object.values(this.#outputs)) output.resume();
  }

  suspend(): void {
    for (const output of Object.values(this.#outputs)) output.suspend();
  }

  status() {
    return {
      stdout: this.#outputs.stdout.status(),
      stderr: this.#outputs.stderr.status(),
    };
  }
}

class BoundedLogOutput {
  readonly #target: Writable;
  readonly #queue: Buffer[] = [];
  #queuedBytes = 0;
  #inFlightBytes = 0;
  #discardedBytes = 0;
  #unreportedDiscardedBytes = 0;
  #scheduled: NodeJS.Immediate | null = null;
  #suspended = false;
  #failed = false;
  #listening = false;
  #reportBeforeNextChunk = true;

  constructor(target: Writable) {
    this.#target = target;
  }

  append(source: string, chunk: Uint8Array | string): void {
    // Source names are internal labels, never child-controlled text.
    const prefix = Buffer.from(`[${source.slice(0, 64)}] `);
    const input =
      typeof chunk === "string"
        ? Buffer.from(chunk.slice(0, MAX_INPUT_BYTES))
        : chunk;
    const length = Math.min(input.byteLength, MAX_INPUT_BYTES);
    const omitted =
      (typeof chunk === "string"
        ? Buffer.byteLength(chunk)
        : input.byteLength) - length;
    this.#discard(omitted);
    if (this.#suspended || this.#failed || this.#target.destroyed) {
      this.#discard(length);
      return;
    }
    for (let offset = 0; offset < length; ) {
      const prefixBytes = offset === 0 ? prefix.byteLength : 0;
      const end = Math.min(length, offset + MAX_WRITE_BYTES - prefixBytes);
      // Copy small chunks: a queued view must not retain a huge source Buffer.
      const output = Buffer.allocUnsafe(prefixBytes + end - offset);
      if (prefixBytes > 0) prefix.copy(output);
      output.set(input.subarray(offset, end), prefixBytes);
      offset = end;
      while (
        this.#queue.length >= MAX_QUEUED_CHUNKS ||
        this.#queuedBytes + output.byteLength > MAX_QUEUED_BYTES
      ) {
        const removed = this.#queue.shift()!;
        this.#queuedBytes -= removed.byteLength;
        this.#discard(removed.byteLength);
      }
      this.#queue.push(output);
      this.#queuedBytes += output.byteLength;
    }
    this.#schedule();
  }

  resume(): void {
    this.#suspended = false;
    this.#schedule();
  }

  suspend(): void {
    this.#suspended = true;
    this.#discard(this.#queuedBytes);
    this.#queue.length = 0;
    this.#queuedBytes = 0;
    if (this.#scheduled !== null) clearImmediate(this.#scheduled);
    this.#scheduled = null;
    if (this.#inFlightBytes === 0) this.#stopListening();
  }

  status() {
    return {
      queuedBytes: this.#queuedBytes,
      queuedChunks: this.#queue.length,
      inFlightBytes: this.#inFlightBytes,
      discardedBytes: this.#discardedBytes,
      unavailable: this.#failed || this.#target.destroyed,
    };
  }

  #discard(bytes: number): void {
    this.#discardedBytes = Math.min(
      Number.MAX_SAFE_INTEGER,
      this.#discardedBytes + bytes,
    );
    this.#unreportedDiscardedBytes = Math.min(
      Number.MAX_SAFE_INTEGER,
      this.#unreportedDiscardedBytes + bytes,
    );
  }

  #schedule(): void {
    if (
      this.#suspended ||
      this.#failed ||
      this.#inFlightBytes > 0 ||
      this.#scheduled !== null ||
      (this.#queue.length === 0 && this.#unreportedDiscardedBytes === 0)
    )
      return;
    this.#scheduled = setImmediate(() => {
      this.#scheduled = null;
      this.#flush();
    });
    this.#scheduled.unref();
  }

  #flush(): void {
    if (this.#target.destroyed) {
      this.#onError();
      return;
    }
    let chunk: Buffer;
    if (
      this.#unreportedDiscardedBytes > 0 &&
      (this.#reportBeforeNextChunk || this.#queue.length === 0)
    ) {
      chunk = Buffer.from(
        `[CrewON logs] discarded ${this.#unreportedDiscardedBytes} diagnostic bytes under output pressure or shutdown\n`,
      );
      this.#unreportedDiscardedBytes = 0;
      this.#reportBeforeNextChunk = false;
    } else {
      chunk = this.#queue.shift()!;
      this.#queuedBytes -= chunk.byteLength;
      this.#reportBeforeNextChunk = true;
    }
    if (!this.#listening) {
      this.#target.on("error", this.#onError);
      this.#listening = true;
    }
    this.#inFlightBytes = chunk.byteLength;
    try {
      // One outstanding callback, regardless of the destination high-water mark.
      // Do not pause the child: its diagnostic pipe must not stall its work.
      this.#target.write(chunk, (error) => {
        this.#inFlightBytes = 0;
        if (error) this.#onError();
        if (this.#suspended && !this.#failed) this.#stopListening();
        this.#schedule();
      });
    } catch {
      this.#inFlightBytes = 0;
      this.#onError();
    }
  }

  readonly #onError = () => {
    this.#failed = true;
    this.suspend();
    // Writable may emit error just after invoking the failing write callback.
    // Keep one handler on a failed target; never replace it on runtime restart.
    if (!this.#listening) {
      this.#target.on("error", this.#onError);
      this.#listening = true;
    }
  };

  #stopListening(): void {
    if (!this.#listening) return;
    this.#target.off("error", this.#onError);
    this.#listening = false;
  }
}

/** Forward only ordinary child logs. Protocol stdout must use its own transport. */
export function forwardRuntimeChildLogs(
  child: ChildProcess,
  name: string,
  forwarder: RuntimeLogForwarder,
): void {
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  const stdout = (chunk: Buffer) =>
    forwarder.write("stdout", name, stdoutDecoder.write(chunk));
  const stderr = (chunk: Buffer) =>
    forwarder.write("stderr", name, stderrDecoder.write(chunk));
  const error = (value: Error) =>
    forwarder.write("stderr", name, `${value.message}\n`);
  const close = () => {
    forwarder.write("stdout", name, stdoutDecoder.end());
    forwarder.write("stderr", name, stderrDecoder.end());
    child.stdout?.off("data", stdout);
    child.stderr?.off("data", stderr);
    child.off("error", error);
    child.off("close", close);
  };
  child.stdout?.on("data", stdout);
  child.stderr?.on("data", stderr);
  child.once("error", error);
  child.once("close", close);
}
