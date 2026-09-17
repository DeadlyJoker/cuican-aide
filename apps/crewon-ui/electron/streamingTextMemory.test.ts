import { buildSync } from "esbuild";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("releases owned pages and bounds live heap across more than 100 million streamed UTF-16 units", () => {
  const bundled = buildSync({
    entryPoints: [
      fileURLToPath(
        new URL(
          "../src/lib/thread/threadStreamingTextBuffer.ts",
          import.meta.url,
        ),
      ),
    ],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
  }).outputFiles[0]!.text;
  const child = spawnSync(
    process.execPath,
    ["--expose-gc", "--input-type=commonjs"],
    {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      input:
        bundled +
        String.raw`
const assert = require("node:assert/strict");
const { createStreamingTextBuffer: create, DEFAULT_STREAMING_TEXT_BUDGET: budget } = module.exports;
let visible = {}, scheduled = null, transferred = 0;
const buffer = create((update) => { visible = update(visible); }, {
  requestFrame(callback) { scheduled = callback; return 1; },
  cancelFrame() { scheduled = null; },
});
function snapshot() { global.gc(); return process.memoryUsage(); }
function run(count, offset) {
  buffer.setVisible(false);
  for (let index = offset; index < offset + count; index++) {
    const delta = String(index).padEnd(4095, "x") + "😀" + "中".repeat(4095);
    transferred += delta.length;
    buffer.append("thread-" + (index % 32), delta);
    if (index % 97 === 0) {
      buffer.setVisible(true);
      if (scheduled) scheduled();
      buffer.setVisible(false);
    }
    const size = buffer.usage();
    assert(size.pendingBytes <= budget.totalPendingBytes);
    assert(size.visibleBytes <= budget.totalVisibleBytes);
    assert(size.streams <= budget.maxStreams);
  }
  buffer.setVisible(true);
}
run(1000, 0);
buffer.replace({});
const empty = snapshot();
run(2000, 1000);
const warm = snapshot();
run(12000, 3000);
const after = snapshot();
assert(transferred > 100_000_000);
assert(after.heapUsed - warm.heapUsed < 8 * 1024 * 1024);
assert(after.arrayBuffers - warm.arrayBuffers < 1024 * 1024);
assert.equal(buffer.usage().pendingBytes, 0);
assert(Object.values(visible).reduce((n, text) => n + text.length * 2, 0) <= budget.totalVisibleBytes);
buffer.replace({});
buffer.dispose();
const released = snapshot();
assert.equal(scheduled, null);
assert.deepEqual(visible, {});
assert.equal(buffer.usage().streams, 0);
assert(released.arrayBuffers - empty.arrayBuffers < 1024 * 1024);
assert(released.heapUsed - empty.heapUsed < 2 * 1024 * 1024);
console.log(JSON.stringify({ transferred, warm, after, released, empty }));
`,
    },
  );
  expect(child.error, child.stderr).toBeUndefined();
  expect(child.status, child.stderr || child.stdout).toBe(0);
  const result = JSON.parse(child.stdout.trim()) as { transferred: number };
  expect(result.transferred).toBeGreaterThan(100_000_000);
}, 35_000);
