import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { RunScopedLocator, RunStore } from "@crewon/application";

/** Advance the real saved Run through its original event reducer; no model or supplier is invoked. */
export async function startExternalOperationFixtureRun(
  store: Pick<RunStore, "loadRunInSpace" | "commitRun">,
  locator: RunScopedLocator,
): Promise<void> {
  const before = await store.loadRunInSpace(locator);
  assert.ok(before);
  assert.equal(before.status, "queued");
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(["external-operation-fixture-start", locator]))
    .digest("hex");
  const result = await store.commitRun({
    tenantId: locator.tenantId,
    expectedRevision: before.revision,
    idempotency: {
      scope: "external-operation-fixture-start",
      key: before.runId,
      requestFingerprint: fingerprint,
    },
    events: [
      {
        schemaVersion: "crewon.run-event.v0",
        identity: { runId: before.runId },
        eventId: randomUUID(),
        sequence: before.lastSequence + 1,
        occurredAt: new Date(Date.parse(before.updatedAt) + 1).toISOString(),
        type: "run.started",
        data: {},
      },
    ],
    outbox: [],
    workItems: [],
  });
  assert.equal(result.disposition, "committed");
  assert.equal(result.state.status, "running");
}
