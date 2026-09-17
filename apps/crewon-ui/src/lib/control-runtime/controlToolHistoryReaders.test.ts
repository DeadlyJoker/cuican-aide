import { expect, it } from "vitest";
import { ControlToolHistoryReaders } from "./controlToolHistoryReaders";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it("transfers shared history across replacement reads without coupling other Threads", async () => {
  const readers = new ControlToolHistoryReaders();
  const first = deferred(),
    replacement = deferred(),
    other = deferred();
  const signals: AbortSignal[] = [];
  const run = (id: string, pending: ReturnType<typeof deferred>) =>
    readers.run(id, (signal) => {
      signals.push(signal);
      return pending.promise;
    });
  const old = run("same", first).catch((error: unknown) => error);
  const next = run("same", replacement);
  const separate = run("other", other);
  expect(signals[0]).toBe(signals[1]);
  expect(signals[2]).not.toBe(signals[0]);
  first.reject(new Error("superseded"));
  expect(await old).toMatchObject({ message: "superseded" });
  expect(signals[0]!.aborted).toBe(false);
  replacement.resolve();
  await next;
  expect(signals[0]!.aborted).toBe(true);
  expect(signals[2]!.aborted).toBe(false);
  other.resolve();
  await separate;
  expect(signals[2]!.aborted).toBe(true);
  await readers.run("same", async (signal) => {
    expect(signal).not.toBe(signals[0]);
    expect(signal.aborted).toBe(false);
  });
});

it("closes every owner and releases synchronous failures without restarting reads", async () => {
  const readers = new ControlToolHistoryReaders();
  let failedSignal: AbortSignal | undefined;
  await expect(
    readers.run("failed", (signal) => {
      failedSignal = signal;
      throw new Error("read-failed");
    }),
  ).rejects.toThrow("read-failed");
  expect(failedSignal?.aborted).toBe(true);
  const pending = deferred();
  let activeSignal: AbortSignal | undefined;
  const active = readers.run("active", (signal) => {
    activeSignal = signal;
    return pending.promise;
  });
  readers.close();
  readers.close();
  expect(activeSignal?.aborted).toBe(true);
  await expect(
    readers.run("active", async () => {
      throw new Error("must-not-start");
    }),
  ).rejects.toThrow("control_thread_runtime_closed");
  pending.resolve();
  await active;
});
