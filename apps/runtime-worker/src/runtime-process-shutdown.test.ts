import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { installRuntimeProcessShutdown } from "./runtime-process-shutdown.ts";

test("20,000 repeated and reentrant shutdown signals retain one close observer and wait for settlement", async (context) => {
  const signals = new EventEmitter();
  let resolve!: () => void;
  const closing = new Promise<void>((yes) => {
    resolve = yes;
  });
  let observations = 0;
  const originalThen = closing.then.bind(closing);
  context.after(async () => {
    resolve();
    await originalThen();
  });
  closing.then = (...args) => {
    observations++;
    return originalThen(...args);
  };
  let closes = 0,
    reports = 0;
  const exits: number[] = [];
  installRuntimeProcessShutdown({
    host: {
      on: signals.on.bind(signals),
      exit: (code) => {
        exits.push(code);
      },
    },
    close: () => {
      closes++;
      signals.emit("SIGTERM");
      return closing;
    },
    reportFailure: () => {
      reports++;
    },
  });
  for (let index = 0; index < 20_000; index++)
    signals.emit(index % 2 === 0 ? "SIGINT" : "SIGTERM");
  assert.equal(closes, 1);
  assert.equal(observations, 1);
  assert.deepEqual(exits, []);
  assert.equal(signals.listenerCount("SIGINT"), 1);
  assert.equal(signals.listenerCount("SIGTERM"), 1);
  resolve();
  await closing;
  assert.deepEqual(exits, [0]);
  assert.equal(reports, 0);
  signals.emit("SIGTERM");
  assert.deepEqual(exits, [0]);
});

for (const outcome of ["resolve", "reject"] as const) {
  test(
    `shutdown prevents natural exit while cleanup is the only pending work, ${outcome}`,
    { timeout: 10_000 },
    async (context) => {
      const child = spawn(
        process.execPath,
        [
          "--experimental-strip-types",
          fileURLToPath(
            new URL(
              "./runtime-process-shutdown.test-support.ts",
              import.meta.url,
            ),
          ),
          outcome,
        ],
        {
          env: { PATH: dirname(process.execPath) },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const completion = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      context.after(async () => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        await completion;
      });
      const deadline = Date.now() + 5000;
      while (!stdout.includes("cleanup pending")) {
        assert.ok(Date.now() < deadline, `fixture not ready: ${stderr}`);
        assert.equal(
          child.exitCode,
          null,
          `fixture exited: ${stdout} ${stderr}`,
        );
        await delay(10);
      }
      await delay(100);
      assert.equal(
        child.exitCode,
        null,
        "pending cleanup was silently treated as exit 0",
      );
      assert.equal(child.signalCode, null);
      assert.equal(stdout, "cleanup pending\n");
      child.kill("SIGTERM");
      await delay(20);
      assert.equal(child.signalCode, null);
      child.kill("SIGUSR2");
      assert.deepEqual(await completion, {
        code: outcome === "resolve" ? 0 : 1,
        signal: null,
      });
      assert.equal(stdout, "cleanup pending\ncleanup settled\n");
      assert.equal(stderr, outcome === "resolve" ? "" : "close failed\n");
    },
  );
}

for (const failure of ["synchronous", "asynchronous", "diagnostic"] as const) {
  test(`${failure} shutdown failure reports exit 1 once without exposing the error`, async () => {
    const signals = new EventEmitter();
    let closes = 0,
      reports = 0;
    const exits: number[] = [];
    installRuntimeProcessShutdown({
      host: {
        on: signals.on.bind(signals),
        exit: (code) => {
          exits.push(code);
        },
      },
      close: () => {
        closes++;
        if (failure === "asynchronous")
          return Promise.reject(new Error("secret"));
        throw new Error("secret");
      },
      reportFailure: () => {
        reports++;
        signals.emit("SIGTERM");
        if (failure === "diagnostic") throw new Error("sink unavailable");
      },
    });
    signals.emit("SIGTERM");
    signals.emit("SIGTERM");
    await Promise.resolve();
    assert.equal(closes, 1);
    assert.equal(reports, 1);
    assert.deepEqual(exits, [1]);
  });
}
