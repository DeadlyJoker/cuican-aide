import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

test("abandoned reservation metadata stays bounded while another unacknowledged result prevents retirement", async (t) => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--expose-gc",
      "--experimental-strip-types",
      fileURLToPath(
        new URL(
          "./tool-retirement-metadata-gc.test-support.ts",
          import.meta.url,
        ),
      ),
    ],
    { timeout: 10000, maxBuffer: 4096 },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.abandoned, 4096);
  assert.equal(result.retainedResultProtected, true);
  assert.ok(result.liveBookkeeping <= 1536, stdout);
  t.diagnostic(stdout.trim());
});
