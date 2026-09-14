import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  RuntimeLogForwarder,
  forwardRuntimeChildLogs,
} from "./runtimeLogForwarder.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

class ControlledOutput extends Writable {
  readonly writes: Buffer[] = [];
  pending: ((error?: Error | null) => void) | null = null;

  constructor() {
    // A huge destination watermark must not permit a huge producer queue.
    super({ highWaterMark: 1024 * 1024 * 1024 });
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.writes.push(Buffer.from(chunk));
    this.pending = callback;
  }

  finish(error?: Error): void {
    const pending = this.pending;
    this.pending = null;
    pending?.(error);
  }
}

function createFixture() {
  const stdout = new ControlledOutput();
  const stderr = new ControlledOutput();
  const logs = new RuntimeLogForwarder({ stdout, stderr });
  return { stdout, stderr, logs };
}

async function flush(output: ControlledOutput, logs: RuntimeLogForwarder) {
  for (let i = 0; i < 100; i++) {
    output.finish();
    await tick();
    const state = logs.status().stdout;
    if (state.queuedBytes === 0 && state.inFlightBytes === 0) return;
  }
  throw new Error("diagnostic_output_did_not_drain");
}

describe("bounded desktop runtime logs", () => {
  it("retained heap and buffers reach a plateau in an isolated GC-enabled process", () => {
    const report = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--expose-gc",
          "--experimental-strip-types",
          "--input-type=module",
          "-e",
          `
      import { Writable } from 'node:stream';
      const { RuntimeLogForwarder } = await import(process.argv[1]);
      const pending = [];
      const target = () => new Writable({write(_chunk,_encoding,callback) { pending.push(callback); }});
      const stdout = target(), stderr = target();
      const logs = new RuntimeLogForwarder({stdout,stderr});
      const chunk = Buffer.alloc(64*1024,120);
      const tick = () => new Promise(resolve=>setImmediate(resolve));
      const memory = () => { for(let i=0;i<3;i++) globalThis.gc(); return process.memoryUsage(); };
      logs.write('stdout','Worker',chunk); logs.write('stderr','Worker',chunk);
      await tick();
      for(let i=0;i<1000;i++) logs.write(i%2?'stdout':'stderr','Worker',chunk);
      const before = memory();
      for(let i=0;i<5000;i++) logs.write(i%2?'stdout':'stderr','Worker',chunk);
      for(let i=0;i<4;i++) logs.write('stdout','Worker',Buffer.alloc(20*1024*1024,65));
      await tick();
      const after = memory();
      const state = logs.status();
      logs.suspend();
      for(const callback of pending) callback();
      await tick();
      const released = memory();
      console.log(JSON.stringify({before,after,released,state}));
    `,
          new URL("./runtimeLogForwarder.ts", import.meta.url).href,
        ],
        { encoding: "utf8", timeout: 15_000, maxBuffer: 32 * 1024 },
      ),
    );
    expect(report.after.heapUsed - report.before.heapUsed).toBeLessThan(
      4 * 1024 * 1024,
    );
    expect(report.after.arrayBuffers - report.before.arrayBuffers).toBeLessThan(
      2 * 1024 * 1024,
    );
    expect(report.released.arrayBuffers).toBeLessThanOrEqual(
      report.after.arrayBuffers,
    );
    for (const state of Object.values(report.state) as {
      queuedBytes: number;
      inFlightBytes: number;
    }[]) {
      expect(state.queuedBytes).toBeLessThanOrEqual(128 * 1024);
      expect(state.inFlightBytes).toBeLessThanOrEqual(16 * 1024);
    }
  });

  it("bounds 125 MiB of blocked logs across all children and both destinations", async () => {
    const { logs, stdout, stderr } = createFixture();
    logs.write("stdout", "Worker", "first\n");
    logs.write("stderr", "Control", "first error\n");
    await tick();
    const chunk = Buffer.alloc(64 * 1024, 120);
    for (let i = 0; i < 2000; i++) {
      logs.write(i % 2 ? "stdout" : "stderr", `worker-${i % 3}`, chunk);
    }
    for (const [channel, output] of [
      ["stdout", stdout],
      ["stderr", stderr],
    ] as const) {
      const state = logs.status()[channel];
      expect(state.queuedBytes).toBeLessThanOrEqual(128 * 1024);
      expect(state.queuedChunks).toBeLessThanOrEqual(64);
      expect(state.inFlightBytes).toBeLessThanOrEqual(16 * 1024);
      expect(state.discardedBytes).toBeGreaterThan(60 * 1024 * 1024);
      expect(output.writableLength).toBeLessThanOrEqual(16 * 1024);
      expect(output.writes).toHaveLength(1);
    }
    logs.suspend();
    stdout.finish();
    stderr.finish();
    await tick();
    expect(stdout.listenerCount("error")).toBe(0);
    expect(stderr.listenerCount("error")).toBe(0);
  });

  it("bounds tiny chunks and preserves a recent tail with an explicit loss notice", async () => {
    const { logs, stdout } = createFixture();
    logs.write("stdout", "Worker", "start\n");
    await tick();
    for (let i = 0; i < 100_000; i++) logs.write("stdout", "Worker", ".");
    logs.write("stdout", "Worker", "latest-checkpoint\n");
    expect(logs.status().stdout.queuedChunks).toBe(64);
    await flush(stdout, logs);
    const text = Buffer.concat(stdout.writes).toString();
    expect(text).toContain("discarded");
    expect(text).toContain("latest-checkpoint");
    expect(text).toMatch(/^\[Worker\] start/);
    expect(stdout.writableLength).toBe(0);
    logs.suspend();
  });

  it("retains only copied slices of oversized source buffers and preserves UTF-8 without loss", async () => {
    const { logs, stdout } = createFixture();
    const text = "你🙂a".repeat(7000);
    logs.write("stdout", "Worker", text);
    await flush(stdout, logs);
    expect(Buffer.concat(stdout.writes).toString()).toBe(`[Worker] ${text}`);
    expect(logs.status().stdout.discardedBytes).toBe(0);
    stdout.writes.length = 0;
    const oversized = Buffer.alloc(10 * 1024 * 1024, 65);
    logs.write("stdout", "Worker", oversized);
    oversized.fill(66);
    expect(logs.status().stdout.queuedBytes).toBeLessThanOrEqual(
      64 * 1024 + 100,
    );
    expect(logs.status().stdout.discardedBytes).toBe(
      oversized.byteLength - 64 * 1024,
    );
    await flush(stdout, logs);
    const output = Buffer.concat(stdout.writes).toString();
    expect(output).toContain("AAAA");
    expect(output).not.toContain("BBBB");
    logs.suspend();
  });

  it("does not accumulate writes, drain listeners or callbacks across 1000 blocked restarts", async () => {
    const { logs, stdout } = createFixture();
    logs.write("stdout", "Worker", "in flight\n");
    await tick();
    for (let i = 0; i < 1000; i++) {
      logs.suspend();
      logs.resume();
      logs.write("stdout", "Worker", "new process\n");
      await tick();
    }
    expect(stdout.writes).toHaveLength(1);
    expect(stdout.listenerCount("error")).toBe(1);
    expect(stdout.listenerCount("drain")).toBe(0);
    expect(logs.status().stdout.queuedChunks).toBe(1);
    logs.suspend();
    expect(logs.status().stdout.queuedBytes).toBe(0);
    stdout.finish();
    await tick();
    expect(stdout.listenerCount("error")).toBe(0);
    expect(logs.status().stdout.inFlightBytes).toBe(0);
  });

  it("contains asynchronous destination errors and does not retry a failed output", async () => {
    const { logs, stdout } = createFixture();
    logs.write("stdout", "Worker", "first\n");
    await tick();
    stdout.finish(new Error("EPIPE"));
    await tick();
    for (let i = 0; i < 1000; i++) {
      logs.resume();
      logs.write("stdout", "Worker", "ignored\n");
    }
    await tick();
    expect(stdout.writes).toHaveLength(1);
    expect(logs.status().stdout.unavailable).toBe(true);
    expect(logs.status().stdout.queuedBytes).toBe(0);
    expect(stdout.listenerCount("error")).toBe(1);
    logs.suspend();
  });

  it("releases source listeners after close and decodes split multibyte characters", async () => {
    const { logs, stdout } = createFixture();
    for (let i = 0; i < 1000; i++) {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      forwardRuntimeChildLogs(child as unknown as ChildProcess, "Worker", logs);
      if (i === 0) {
        const bytes = Buffer.from("你🙂\n");
        child.stdout.write(bytes.subarray(0, 2));
        child.stdout.write(bytes.subarray(2));
      }
      child.emit("close");
      expect(child.stdout.listenerCount("data")).toBe(0);
      expect(child.stderr.listenerCount("data")).toBe(0);
      expect(child.listenerCount("error")).toBe(0);
      expect(child.listenerCount("close")).toBe(0);
      child.stdout.destroy();
      child.stderr.destroy();
    }
    await flush(stdout, logs);
    expect(Buffer.concat(stdout.writes).toString()).toBe("[Worker] 你🙂\n");
    logs.suspend();
  });

  it("keeps a real child progressing through 128 MiB of logs with stdout and stderr blocked", async () => {
    const { logs, stdout, stderr } = createFixture();
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { once } from 'node:events';
      const chunk = Buffer.alloc(64 * 1024, 120);
      for (let i=0;i<2048;i++) {
        const stream = i%2 ? process.stdout : process.stderr;
        if (!stream.write(chunk)) await once(stream, 'drain');
      }
      process.send({ checkpoint: 'committed', bytes: chunk.length * 2048 });
      process.disconnect();
    `,
      ],
      { stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    forwardRuntimeChildLogs(child, "Worker", logs);
    const deadline = setTimeout(() => child.kill("SIGKILL"), 15_000);
    deadline.unref();
    try {
      const message = once(child, "message");
      const closed = once(child, "close");
      const received = await Promise.race([
        message,
        closed.then(() => {
          throw new Error("child_closed_before_checkpoint");
        }),
      ]);
      expect(received[0]).toEqual({
        checkpoint: "committed",
        bytes: 128 * 1024 * 1024,
      });
      expect((await closed)[0]).toBe(0);
      expect(stdout.writableLength + stderr.writableLength).toBeLessThanOrEqual(
        32 * 1024,
      );
      expect(
        logs.status().stdout.discardedBytes +
          logs.status().stderr.discardedBytes,
      ).toBeGreaterThan(120 * 1024 * 1024);
      expect(child.stdout!.listenerCount("data")).toBe(0);
      expect(child.stderr!.listenerCount("data")).toBe(0);
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "close");
      }
      logs.suspend();
      stdout.finish();
      stderr.finish();
    }
  }, 20_000);
});
