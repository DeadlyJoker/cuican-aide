import { spawn, type ChildProcess } from "node:child_process";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  MAX_RUNTIME_LOG_WRITE_BYTES,
  type RuntimeLogChannel,
  type RuntimeLogWrite,
  type RuntimeLogWritten,
} from "./runtimeLogProtocol.ts";

type PendingWrite = {
  id: number;
  bytes: number;
  done: (error?: Error | null) => void;
};

/** One process for the lifetime of the App; at most one outstanding chunk per output. */
export class RuntimeLogProcess {
  readonly outputs: Record<RuntimeLogChannel, Writable>;
  readonly #entry: URL;
  readonly #fds: Readonly<{ stdout: number; stderr: number }>;
  readonly #pending = new Map<RuntimeLogChannel, PendingWrite>();
  #child: ChildProcess | null = null;
  #exit: Promise<void> | null = null;
  #nextId = 1;
  #started = false;
  #failed = false;
  #closed = false;
  #rssBytes: number | null = null;

  constructor(input: { entry: URL; stdout?: number; stderr?: number }) {
    this.#entry = input.entry;
    this.#fds = { stdout: input.stdout ?? 1, stderr: input.stderr ?? 2 };
    const output = (channel: RuntimeLogChannel) =>
      new Writable({
        highWaterMark: MAX_RUNTIME_LOG_WRITE_BYTES,
        write: (chunk: Buffer, _encoding, done) =>
          this.#write(channel, chunk, done),
      });
    this.outputs = { stdout: output("stdout"), stderr: output("stderr") };
  }

  snapshot() {
    return {
      started: this.#started,
      pid: this.#child?.pid ?? null,
      inFlightWrites: this.#pending.size,
      inFlightBytes: [...this.#pending.values()].reduce(
        (sum, value) => sum + value.bytes,
        0,
      ),
      rssBytes: this.#rssBytes,
      failed: this.#failed,
      closed: this.#closed,
    };
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#fail();
    return this.#exit ?? Promise.resolve();
  }

  #write(
    channel: RuntimeLogChannel,
    bytes: Buffer,
    done: PendingWrite["done"],
  ): void {
    if (
      this.#closed ||
      this.#failed ||
      bytes.length < 1 ||
      bytes.length > MAX_RUNTIME_LOG_WRITE_BYTES ||
      this.#pending.has(channel)
    ) {
      done(new Error("runtime_log_output_unavailable"));
      return;
    }
    let submitted = false;
    try {
      const child = this.#child ?? this.#start();
      const id = this.#nextId;
      this.#nextId = id === Number.MAX_SAFE_INTEGER ? 1 : id + 1;
      this.#pending.set(channel, { id, bytes: bytes.length, done });
      submitted = true;
      child.send(
        { kind: "write", id, channel, bytes } satisfies RuntimeLogWrite,
        (error) => {
          if (error) this.#fail();
        },
      );
    } catch {
      this.#fail();
      if (!submitted) done(new Error("runtime_log_output_unavailable"));
    }
  }

  #start(): ChildProcess {
    this.#started = true;
    const entry = fileURLToPath(this.#entry);
    const child = spawn(
      process.execPath,
      [...(entry.endsWith(".ts") ? ["--experimental-strip-types"] : []), entry],
      {
        // The writer needs neither credentials nor user-provided Node preloads.
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          ...(process.env.SystemRoot
            ? { SystemRoot: process.env.SystemRoot }
            : {}),
        },
        stdio: ["ignore", this.#fds.stdout, this.#fds.stderr, "ipc"],
        serialization: "advanced",
        windowsHide: true,
      },
    );
    this.#child = child;
    child.on("message", this.#onMessage);
    child.once("error", this.#onFailure);
    child.once("disconnect", this.#onFailure);
    this.#exit = new Promise((resolve) =>
      child.once("close", () => {
        this.#fail();
        child.off("message", this.#onMessage);
        child.off("error", this.#onFailure);
        child.off("disconnect", this.#onFailure);
        process.off("exit", this.#onParentExit);
        this.#child = null;
        resolve();
      }),
    );
    process.once("exit", this.#onParentExit);
    child.unref();
    child.channel?.unref();
    return child;
  }

  readonly #onMessage = (input: unknown) => {
    const message = input as Partial<RuntimeLogWritten> | null;
    if (
      message === null ||
      typeof message !== "object" ||
      message.kind !== "written" ||
      (message.channel !== "stdout" && message.channel !== "stderr") ||
      typeof message.failed !== "boolean" ||
      !Number.isSafeInteger(message.rssBytes) ||
      message.rssBytes! <= 0
    ) {
      this.#fail();
      return;
    }
    const pending = this.#pending.get(message.channel);
    if (pending === undefined || pending.id !== message.id) {
      this.#fail();
      return;
    }
    this.#pending.delete(message.channel);
    this.#rssBytes = message.rssBytes!;
    pending.done(
      message.failed ? new Error("runtime_log_write_failed") : undefined,
    );
  };

  readonly #onFailure = () => this.#fail();
  readonly #onParentExit = () => {
    this.#child?.kill("SIGKILL");
  };

  #fail(): void {
    this.#failed = true;
    for (const [channel, pending] of this.#pending) {
      this.#pending.delete(channel);
      pending.done(new Error("runtime_log_output_unavailable"));
    }
    // Terminate native writes without waiting for their completion. No restart loop.
    this.#child?.kill("SIGKILL");
  }
}
