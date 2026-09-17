import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";
import {
  createRunningCommitFixture,
  ManualLeaseClock,
} from "./run-store-conformance.test-support.ts";
import {
  prepareAtomicToolCompletion,
  atomicToolCompletionInput,
} from "./run-execution-store-conformance.test-support.ts";

export async function createToolResultFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "crewon-tool-result-codec-")),
    path = join(root, "store.sqlite"),
    clock = new ManualLeaseClock();
  let store = new SqliteRunStore(path, { clock });
  const db = new DatabaseSync(path);
  t.after(async () => {
    await store.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  await seedThread(store);
  await store.commitRun(createRunningCommitFixture());
  const claim = await store.claimNextWorkItem({
    ownerId: "worker",
    leaseId: "lease",
    leaseDurationMs: 30000,
  });
  assert.ok(claim);
  const prepared = await prepareAtomicToolCompletion(store, claim),
    base = atomicToolCompletionInput(claim, prepared.receipt.revision);
  const output = "persisted output 界🚀\n".repeat(300),
    source = base.commit.events[0]!;
  assert.equal(source.type, "tool.completed");
  if (source.type !== "tool.completed") throw new Error("unexpected fixture");
  const event = { ...source, data: { ...source.data, output } };
  const input = {
    ...base,
    receipt: {
      ...base.receipt,
      result: {
        ...base.receipt.result,
        output,
        outputDigest: `sha256:${createHash("sha256").update(output).digest("hex")}`,
      },
    },
    commit: { ...base.commit, events: [event] },
    history: {
      ...base.history,
      items: base.history.items.map((item) => ({ ...item, output })),
    },
  };
  const locator = {
    tenantId: "tenant-1",
    runId: "run-store-1",
    receiptId: prepared.receipt.receiptId,
  };
  return {
    get store() {
      return store;
    },
    db,
    path,
    input,
    prepared,
    locator,
    output,
    async reopen() {
      await store.close();
      store = new SqliteRunStore(path, { clock });
    },
  };
}
