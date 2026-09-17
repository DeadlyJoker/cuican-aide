import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// pnpm --filter @crewon/ui exec node --experimental-strip-types scripts/measure-thread-detail-cache.ts
const output = await build({
  stdin: {
    loader: "ts",
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    contents: `
      import { createHash, randomBytes } from "node:crypto";
      import { measureThreadDetailMemory } from ${JSON.stringify(fileURLToPath(new URL("../src/lib/thread/threadDetailCache.memory-test-support.ts", import.meta.url)))};
      if (typeof globalThis.gc !== "function") throw new Error("cache_probe_requires_expose_gc");
      const mode = process.argv[2];
      if (mode !== "legacy" && mode !== "bounded") throw new Error("cache_probe_mode_invalid");
      const result = measureThreadDetailMemory({
        mode,
        heapAfterGc: () => { for (let i = 0; i < 3; i++) globalThis.gc(); return process.memoryUsage().heapUsed; },
        freshPayload: () => randomBytes(12 * 1024).toString("hex"),
        digest: value => createHash("sha256").update(JSON.stringify(value)).digest("hex"),
      });
      process.stdout.write(JSON.stringify(result) + "\\n");
    `,
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
});
const source = output.outputFiles[0]!.text;
type Result = {
  mode: string;
  threadCount: number;
  retainedDetails: number;
  selectedPayloadPreserved: boolean;
  samples: { pass: number; elapsedMs: number; retainedHeapDelta: number }[];
};
const results: Result[] = [];
for (const mode of ["legacy", "bounded"]) {
  const child = spawnSync(
    process.execPath,
    ["--expose-gc", "--input-type=module", "-", mode],
    {
      input: source,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (child.error || child.status !== 0)
    throw new Error(`cache_probe_failed:${mode}\n${child.stderr}`, {
      cause: child.error,
    });
  results.push(JSON.parse(child.stdout) as Result);
}
process.stdout.write(
  `${JSON.stringify(
    {
      scope:
        "UI collection reducer in isolated Node/V8 processes; not React, Electron or multi-day App testing",
      nodeVersion: process.version,
      results,
    },
    null,
    2,
  )}\n`,
);
const [legacy, bounded] = results;
assert.equal(legacy!.retainedDetails, 1_000);
assert.equal(bounded!.retainedDetails, 3);
assert.equal(bounded!.selectedPayloadPreserved, true);
assert.equal(bounded!.threadCount, 1_000);
const baseline = legacy!.samples.at(-1)!.retainedHeapDelta;
const actual = bounded!.samples.at(-1)!.retainedHeapDelta;
assert.ok(
  actual < baseline * 0.35,
  "cache_heap_retains_large_history_backings",
);
const growth =
  bounded!.samples.at(-1)!.retainedHeapDelta -
  bounded!.samples[0]!.retainedHeapDelta;
assert.ok(
  growth < 8 * 1024 * 1024,
  "cache_heap_grows_across_identical_worksets",
);
