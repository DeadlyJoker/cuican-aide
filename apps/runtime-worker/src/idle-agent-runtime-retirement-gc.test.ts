import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

test("idle retired runtimes are collectible while the registry and deployment factory remain alive", async (t) => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--expose-gc",
      "--experimental-strip-types",
      fileURLToPath(
        new URL(
          "./idle-agent-runtime-retirement-gc.test-support.ts",
          import.meta.url,
        ),
      ),
    ],
    { timeout: 10000, maxBuffer: 4096 },
  );
  assert.deepEqual(JSON.parse(stdout), {
    created: 160,
    collectedDuringOperation: 96,
    retainedWorkingSet: 64,
    collectedAfterClose: 160,
  });
  t.diagnostic(stdout.trim());
});
