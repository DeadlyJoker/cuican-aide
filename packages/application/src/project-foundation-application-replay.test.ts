import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationError } from "./application-error.ts";
import {
  actor,
  createCommand,
  createFixture,
} from "./project-foundation-application-test-support.ts";

// These memory-port tests cover Application publication contracts, not SQL COMMIT,
// installation rows, Worker dispatch membership or durable source adoption.
function withdrawalFixture(f: ReturnType<typeof createFixture>) {
  let active = true;
  let lateChecks = 0;
  const assertActive = () => {
    if (!active) {
      lateChecks++;
      throw new Error("fixture-authority-withdrawn");
    }
  };
  return {
    authority: {
      async assertCurrent() {
        assertActive();
      },
      assertActive,
    },
    withdraw() {
      f.allow = false;
      active = false;
    },
    get lateChecks() {
      return lateChecks;
    },
  };
}

test("memory App contract: withdrawal immediately after qualified receipt publication does not deny a committed replay", async () => {
  const f = createFixture();
  const command = createCommand("novel");
  const first = await f.service.createProject(actor, command);
  const before = {
    ids: f.idCalls,
    clocks: f.clockCalls,
    sources: f.sourceCalls,
    receipts: f.store.receipts.size,
  };
  f.uploads.clear();
  const withdrawal = withdrawalFixture(f);
  const original = f.store.loadMutationReceipt.bind(f.store);
  let publications = 0;
  f.store.loadMutationReceipt = async (...args) => {
    const qualified = await original(...args);
    assert.notEqual(qualified, null);
    publications++;
    // The Store port completed its current/active checks before publication.
    withdrawal.withdraw();
    return qualified;
  };
  assert.deepEqual(
    await f.service.createProject(actor, command, {
      authority: withdrawal.authority,
    }),
    { ...first, disposition: "replayed" },
  );
  assert.equal(publications, 1);
  assert.equal(withdrawal.lateChecks, 0);
  assert.deepEqual(
    {
      ids: f.idCalls,
      clocks: f.clockCalls,
      sources: f.sourceCalls,
      receipts: f.store.receipts.size,
    },
    before,
  );
  await assert.rejects(
    f.service.createProject(actor, command, {
      authority: withdrawal.authority,
    }),
    (error: unknown) =>
      error instanceof ApplicationError && error.category === "authorization",
  );
  assert.equal(publications, 1);
});

test("memory App contract: withdrawal immediately after commit returns a qualified replay cannot turn it into a false failure", async () => {
  const f = createFixture();
  const command = createCommand();
  const first = await f.service.createProject(actor, command);
  const withdrawal = withdrawalFixture(f);
  const originalRead = f.store.loadMutationReceipt.bind(f.store);
  const originalCommit = f.store.commitCreation.bind(f.store);
  let missedReads = 0;
  let replayPublications = 0;
  f.store.loadMutationReceipt = async (...args) => {
    await originalRead(...args);
    missedReads++;
    // Model an initial miss followed by another caller's durable same-key commit.
    // The commit port remains authoritative for that race and must publish replay.
    return null;
  };
  f.store.commitCreation = async (...args) => {
    const qualified = await originalCommit(...args);
    assert.equal(qualified.disposition, "replayed");
    replayPublications++;
    withdrawal.withdraw();
    return qualified;
  };
  assert.deepEqual(
    await f.service.createProject(actor, command, {
      authority: withdrawal.authority,
    }),
    { ...first, disposition: "replayed" },
  );
  assert.equal(missedReads, 1);
  assert.equal(replayPublications, 1);
  assert.equal(withdrawal.lateChecks, 0);
  assert.equal(f.store.projects.size, 1);
  assert.equal(f.store.foundations.size, 1);
  assert.equal(f.store.receipts.size, 1);
  assert.deepEqual([...f.store.projects.values()], [first.project]);
  await assert.rejects(
    f.service.createProject(actor, command, {
      authority: withdrawal.authority,
    }),
    (error: unknown) =>
      error instanceof ApplicationError && error.category === "authorization",
  );
  assert.equal(missedReads, 1);
  assert.equal(replayPublications, 1);
});
