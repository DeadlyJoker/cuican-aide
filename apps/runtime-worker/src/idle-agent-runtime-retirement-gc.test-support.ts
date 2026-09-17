import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { AgentVersionRuntime } from "./agent-version-runtime.ts";
import { retirementFixture } from "./idle-agent-runtime-retirement.test-support.ts";

assert.ok(globalThis.gc);
const f = await retirementFixture({ count: 160 });
const references: WeakRef<AgentVersionRuntime>[] = [];
async function borrow(n: number) {
  const lease = await f.acquire(n);
  references.push(new WeakRef(lease.resource));
  lease.release();
}
function reachable() {
  return references.filter((reference) => reference.deref() !== undefined)
    .length;
}
try {
  for (let n = 0; n < 160; n++) await borrow(n);
  await f.drain();
  assert.equal(f.closed.length, 96);
  for (let n = 0; n < 20; n++) {
    await nextTurn();
    globalThis.gc();
    if (reachable() === 64) break;
  }
  assert.equal(reachable(), 64);
  const beforeClose = f.registry.resourceSnapshot();
  await f.close();
  for (let n = 0; n < 20; n++) {
    await nextTurn();
    globalThis.gc();
    if (reachable() === 0) break;
  }
  assert.equal(reachable(), 0);
  console.log(
    JSON.stringify({
      created: f.created.length,
      collectedDuringOperation: 96,
      retainedWorkingSet: beforeClose.resourceOwners,
      collectedAfterClose: 160,
    }),
  );
} finally {
  await f.close();
}
