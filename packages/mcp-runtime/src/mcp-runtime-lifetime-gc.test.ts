import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("old MCP catalog brokers are collectible while the original uncommitted result stays owned", async (context) => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--expose-gc",
      "--experimental-strip-types",
      fileURLToPath(
        new URL(
          "./fixtures/retained-mcp-catalog-gc.test-support.ts",
          import.meta.url,
        ),
      ),
    ],
    { timeout: 10000, maxBuffer: 32768 },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.refreshes, 1000);
  assert.ok(result.liveBrokerGenerations <= 2);
  assert.equal(result.executions, 1);
  assert.equal(result.retainedBytesAfterAck, 0);
  context.diagnostic(JSON.stringify(result));
});
