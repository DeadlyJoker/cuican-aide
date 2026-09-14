import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type {
  ArtifactRetentionCandidate,
  DomainStore,
  WorkItemClaim,
} from "@crewon/application";
import type { ToolExecutionReceiptState } from "@crewon/domain";
import { atomicToolCompletionInput } from "./run-execution-store-conformance.test-support.ts";

export function registerArtifactRetentionGuardConformance(
  name: string,
  create: (context: TestContext) => Promise<{
    store: DomainStore;
    claim: WorkItemClaim;
    receipt: ToolExecutionReceiptState;
  }>,
): void {
  test(`${name}: artifact retirement requires terminal Run and exact completed Tool reference without changing history`, async (context) => {
    const { store, claim, receipt } = await create(context);
    const run = await store.loadRun(receipt);
    assert.ok(run);
    const candidate: ArtifactRetentionCandidate = {
      idempotencyKey: receipt.idempotencyKey,
      record: {
        schemaVersion: "crewon.artifact.v0",
        artifactId: "artifact-1",
        tenantId: run.tenantId,
        spaceId: run.spaceId,
        ownerActorId: run.createdByActorId,
        kind: "toolOutput",
        mediaType: "text/plain",
        sensitivity: "workspaceSensitive",
        source: {
          kind: "toolOutput",
          runId: run.runId,
          stepId: receipt.stepId,
          attemptId: receipt.attemptId,
          callId: receipt.call.callId,
        },
        byteLength: 32768,
        contentDigest: `sha256:${"b".repeat(64)}`,
        createdAt: "2026-08-08T00:01:03Z",
        retention: { kind: "run", expiresAt: "2026-08-09T00:01:03Z" },
        encryption: { scheme: "aes256gcm", keyId: "key" },
        scan: { status: "notRequired", scannedAt: null, scanner: null },
      },
    };
    const imageCandidate: ArtifactRetentionCandidate = {
      idempotencyKey: "model-image:no-tool-receipt",
      record: {
        ...candidate.record,
        artifactId: "artifact-image",
        kind: "modelImage",
        mediaType: "image/png",
        source: {
          kind: "modelImage",
          runId: run.runId,
          segmentId: "segment-1",
          itemId: "image-1",
        },
      },
    };
    assert.equal(
      await store.canRetireArtifact(imageCandidate),
      false,
      "running Run images cannot retire",
    );
    assert.equal(await store.canRetireArtifact(candidate), false);
    const base = atomicToolCompletionInput(claim, receipt.revision);
    const event = base.commit.events[0]!;
    assert.equal(event.type, "tool.completed");
    if (event.type !== "tool.completed") throw new Error("fixture_invalid");
    await store.commitToolExecutionCompletion({
      ...base,
      commit: {
        ...base.commit,
        events: [
          {
            ...event,
            data: { ...event.data, artifactRef: candidate.record.artifactId },
          },
        ],
      },
      receipt: {
        ...base.receipt,
        result: {
          ...base.receipt.result,
          artifactRef: candidate.record.artifactId,
        },
      },
    });
    assert.equal(
      await store.canRetireArtifact(candidate),
      false,
      "completed Tool still belongs to an active Run",
    );
    await store.commitRun({
      tenantId: run.tenantId,
      idempotency: {
        scope: "artifact-test",
        key: "finish",
        requestFingerprint: "finish",
      },
      expectedRevision: 4,
      events: [
        {
          schemaVersion: "crewon.run-event.v0",
          identity: { runId: run.runId },
          eventId: "artifact-run-failed",
          sequence: 5,
          occurredAt: "2026-08-08T00:01:05Z",
          type: "run.failed",
          data: { code: "test_done", retryable: false },
        },
      ],
      outbox: [],
      workItems: [],
    });
    const history = await store.listRunEvents(run, 0, 100),
      state = await store.loadRun(run);
    assert.equal(
      await store.canRetireArtifact(imageCandidate),
      true,
      "terminal Run images need no Tool receipt",
    );
    for (const record of [
      { ...imageCandidate.record, tenantId: "other" },
      { ...imageCandidate.record, spaceId: "other" },
      { ...imageCandidate.record, ownerActorId: "other" },
      {
        ...imageCandidate.record,
        source: { ...imageCandidate.record.source, runId: "other" },
      },
    ])
      assert.equal(
        await store.canRetireArtifact({ ...imageCandidate, record }),
        false,
      );
    for (let n = 0; n < 10; n++)
      assert.equal(await store.canRetireArtifact(candidate), true);
    for (const record of [
      { ...candidate.record, tenantId: "other" },
      { ...candidate.record, spaceId: "other" },
      { ...candidate.record, ownerActorId: "other" },
      { ...candidate.record, artifactId: "other" },
      ...["runId", "stepId", "attemptId", "callId"].map((field) => ({
        ...candidate.record,
        source: { ...candidate.record.source, [field]: "other" },
      })),
    ])
      assert.equal(
        await store.canRetireArtifact({ ...candidate, record }),
        false,
      );
    assert.equal(
      await store.canRetireArtifact({ ...candidate, idempotencyKey: "other" }),
      false,
    );
    assert.deepEqual(await store.listRunEvents(run, 0, 100), history);
    assert.deepEqual(await store.loadRun(run), state);
  });
}
