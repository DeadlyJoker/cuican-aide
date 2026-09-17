import { once } from "node:events";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { RuntimeLogForwarder } from "./runtimeLogForwarder.ts";
import { RuntimeLogProcess } from "./runtimeLogProcess.ts";

const entry = new URL("./runtimeLogWriter.ts", import.meta.url);

it("starts lazily, writes exact UTF-8 bytes to both files and reuses one process", async () => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-log-process-"));
  const stdout = openSync(join(directory, "stdout"), "w");
  const stderr = openSync(join(directory, "stderr"), "w");
  const writer = new RuntimeLogProcess({ entry, stdout, stderr });
  const logs = new RuntimeLogForwarder(writer.outputs);
  try {
    expect(writer.snapshot().started).toBe(false);
    let pid: number | null = null;
    for (let n = 0; n < 10; n++) {
      const out = once(writer.outputs.stdout, "drain");
      // The output is exactly one high-water mark, so drain also proves the writer ACKed.
      const bytes = Buffer.alloc(16 * 1024, n + 65);
      expect(writer.outputs.stdout.write(bytes)).toBe(false);
      await out;
      if (pid === null) pid = writer.snapshot().pid;
      expect(writer.snapshot().pid).toBe(pid);
      logs.suspend();
      logs.resume();
    }
    await new Promise<void>((resolve, reject) =>
      writer.outputs.stderr.write("你好🙂\n", (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    expect(readFileSync(join(directory, "stdout"))).toEqual(
      Buffer.concat(
        Array.from({ length: 10 }, (_, n) => Buffer.alloc(16 * 1024, n + 65)),
      ),
    );
    expect(readFileSync(join(directory, "stderr"), "utf8")).toBe("你好🙂\n");
    expect(writer.snapshot().inFlightWrites).toBe(0);
    expect(writer.snapshot().rssBytes).toBeGreaterThan(0);
  } finally {
    logs.suspend();
    await writer.close();
    closeSync(stdout);
    closeSync(stderr);
    rmSync(directory, { recursive: true });
  }
  expect(writer.snapshot().pid).toBe(null);
});

it("failed startup settles pending writes once and never starts another writer", async () => {
  const writer = new RuntimeLogProcess({
    entry: new URL("./missing-log-writer.mjs", import.meta.url),
    stdout: -1,
    stderr: -1,
  });
  const logs = new RuntimeLogForwarder(writer.outputs);
  let callbacks = 0;
  writer.outputs.stdout.on("error", () => {});
  await new Promise<void>((resolve) => {
    writer.outputs.stdout.write("first", (error) => {
      callbacks++;
      expect(error).toBeInstanceOf(Error);
      resolve();
    });
  });
  await writer.close();
  for (let n = 0; n < 1000; n++) {
    logs.resume();
    logs.write("stdout", "Worker", "later");
    logs.suspend();
  }
  expect(writer.snapshot().inFlightWrites).toBe(0);
  expect(writer.snapshot().pid).toBe(null);
  expect(writer.snapshot().failed).toBe(true);
  expect(callbacks).toBe(1);
});

it("a failing output does not destroy the other direction", async () => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-log-error-"));
  const file = join(directory, "readonly");
  const created = openSync(file, "w");
  closeSync(created);
  const stdout = openSync(file, "r");
  const stderr = openSync(join(directory, "stderr"), "w");
  const writer = new RuntimeLogProcess({ entry, stdout, stderr });
  writer.outputs.stdout.on("error", () => {});
  try {
    await expect(
      new Promise<void>((resolve, reject) =>
        writer.outputs.stdout.write("failed", (error) =>
          error ? reject(error) : resolve(),
        ),
      ),
    ).rejects.toThrow("runtime_log_write_failed");
    await new Promise<void>((resolve, reject) =>
      writer.outputs.stderr.write("survives", (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    expect(readFileSync(join(directory, "stderr"), "utf8")).toBe("survives");
    expect(writer.snapshot().failed).toBe(false);
  } finally {
    await writer.close();
    closeSync(stdout);
    closeSync(stderr);
    rmSync(directory, { recursive: true });
  }
});
