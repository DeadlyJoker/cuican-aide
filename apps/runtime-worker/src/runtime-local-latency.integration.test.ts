import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { deferred } from "./runtime-store-access.test-support.ts";
import { createFixture } from "./runtime-tool-continuation.test-support.ts";

test("measures local SQLite preparation, tool execution and durable result return separately", async (t) => {
  const slowGate = deferred<void>();
  t.after(() => slowGate.resolve());
  const operations = new Map<string, { calls: number; ms: number }>();
  const marks: Record<string, number> = {};
  let origin = 0;
  const mark = (name: string) => {
    marks[name] = performance.now() - origin;
  };
  const f = await createFixture(t, {
    backend: "sqlite",
    storeResponses: true,
    crashAfterCommit: false,
    toolCount: 2,
    execution: "parallel",
    observeModelHeaders: () =>
      mark(
        `modelRequest${Object.keys(marks).filter((k) => k.startsWith("modelRequest")).length + 1}`,
      ),
    executeFixtureTool: async (callId) => {
      mark(`${callId}:started`);
      if (callId === "call-1") await setTimeout(5);
      else await slowGate.promise;
      mark(`${callId}:resolved`);
    },
    decorateStore: (store) =>
      new Proxy(store, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (typeof value !== "function") return value;
          return async (...args: unknown[]) => {
            const started = performance.now();
            try {
              const result = await Reflect.apply(value, target, args);
              if (key === "commitToolExecutionCompletion")
                mark(
                  `toolCommit${Object.keys(marks).filter((k) => k.startsWith("toolCommit")).length + 1}`,
                );
              return result;
            } finally {
              const name = String(key);
              const prior = operations.get(name) ?? { calls: 0, ms: 0 };
              prior.calls++;
              prior.ms += performance.now() - started;
              operations.set(name, prior);
            }
          };
        },
      }),
  });
  origin = performance.now();
  const work = f.worker().wake();
  let earlyCompleted = 0;
  while (marks["call-1:resolved"] === undefined) await setTimeout(5);
  await setTimeout(60);
  earlyCompleted = (await f.events()).filter(
    (e) => e.type === "tool.completed",
  ).length;
  await setTimeout(
    Math.max(0, 300 - (performance.now() - origin - marks["call-2:started"]!)),
  );
  slowGate.resolve();
  const result = await work;
  assert.equal(
    earlyCompleted,
    1,
    "fast prefix must be durable while the slow sibling is executing",
  );
  mark("runCompleted");
  assert.equal(result.kind, "completed");
  assert.equal(f.executions(), 2);
  const calls = await f.callRecords();
  t.diagnostic(
    JSON.stringify({
      marks,
      earlyCompleted,
      model: calls.map((c) => ({
        startedAt: c.record.observation.startedAt,
        finishedAt: c.record.observation.finishedAt,
        httpTiming: c.record.observation.httpTiming,
      })),
      store: Object.fromEntries(
        [...operations].map(([name, v]) => [
          name,
          { calls: v.calls, ms: +v.ms.toFixed(2) },
        ]),
      ),
    }),
  );
});

test("measures a real Node child reading a workspace file through the full tool continuation", async (t) => {
  const execute = promisify(execFile);
  let childMs = 0,
    readMs = 0;
  const f = await createFixture(t, {
    backend: "sqlite",
    storeResponses: true,
    crashAfterCommit: false,
    executeFixtureTool: async () => {
      const started = performance.now();
      const result = await execute(process.execPath, [
        "-e",
        `
        const fs = require('node:fs');
        const started = performance.now();
        const value = fs.readFileSync(process.argv[1]);
        process.stdout.write(JSON.stringify({ bytes: value.length, readMs: performance.now() - started }));
      `,
        fileURLToPath(new URL("../../../package.json", import.meta.url)),
      ]);
      childMs = performance.now() - started;
      const measured = JSON.parse(result.stdout);
      assert.ok(measured.bytes > 0);
      readMs = measured.readMs;
    },
  });
  const started = performance.now();
  assert.equal((await f.worker().wake()).kind, "completed");
  t.diagnostic(
    JSON.stringify({
      scenario: "actual-local-file-child",
      totalMs: performance.now() - started,
      childMs,
      readMs,
    }),
  );
});
