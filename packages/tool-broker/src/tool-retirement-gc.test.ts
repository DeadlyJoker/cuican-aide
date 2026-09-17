import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

test("isolated GC releases an abandoned reservation while an extracted execute closure protects its owner", async (t) => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--expose-gc",
      "--experimental-strip-types",
      fileURLToPath(
        new URL("./tool-retirement-gc.test-support.ts", import.meta.url),
      ),
    ],
    { timeout: 10000, maxBuffer: 4096 },
  );
  const result = JSON.parse(stdout);
  assert.deepEqual(result, {
    abandonedCollected: 1,
    extractedExecuteProtected: true,
    executed: 1,
    finalExecutionCount: 0,
    canRetire: true,
  });
  t.diagnostic(stdout.trim());
});
