import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ProjectMediaWorkflowReview } from "@crewon/application";
import { FilesystemProjectMediaResultArchive } from "@crewon/artifacts";
import { SqliteRunStore } from "@crewon/store";
import { ProjectMediaResultPublisher } from "./project-media-result-publisher.ts";
import { namedMediaWorkflowReviewHistory } from "../../../packages/application/src/project-media-workflow-reviews.test-support.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "crewon-result-review-history-"));
  const parent = new SqliteRunStore(join(root, "control.sqlite"));
  const archive = new FilesystemProjectMediaResultArchive({
    archiveId: "named-history-result-archive",
    rootDirectory: join(root, "archive"),
    encryptionKey: Buffer.alloc(32, 63),
    keyId: "named-history-result-key",
  });
  const publishers: ProjectMediaResultPublisher[] = [];
  const state = { authorizations: 0, dns: 0, transport: 0 };
  t.after(async () => {
    for (const publisher of publishers) await publisher.close();
    archive.close();
    await parent.close();
    rmSync(root, { recursive: true, force: true });
  });
  const open = (reviews: readonly ProjectMediaWorkflowReview[]) => {
    const publisher = new ProjectMediaResultPublisher({
      store: parent.extensionStore().projectMediaResults(),
      archive,
      reviews,
      authorization: {
        authorize: async () => {
          state.authorizations++;
          return { outcome: "deny", reasonCode: "named-no-media-grant" };
        },
        assertActive: () => {},
      },
      clock: { now: () => "2026-10-15T00:00:00.000Z" },
      dns: {
        resolveAll: async () => {
          state.dns++;
          throw new Error("history-cannot-grant-network");
        },
      },
      transport: {
        request: async () => {
          state.transport++;
          throw new Error("history-cannot-grant-output-read");
        },
      },
    });
    publishers.push(publisher);
    return publisher;
  };
  return { open, state };
}

test("actual SQLite/encrypted-archive publisher accepts 34 and 64 pinned metadata reviews but preserves original publish authorization", async (t) => {
  const f = fixture(t);
  for (const packages of [17, 32]) {
    const publisher = f.open(namedMediaWorkflowReviewHistory(packages));
    await assert.rejects(
      publisher.publish(
        {
          tenantId: "tenant",
          spaceId: "space",
          principalId: "principal",
          actorId: "actor",
        },
        { projectId: "project", runId: "original-run", resultIndex: 0 },
        { signal: new AbortController().signal },
      ),
      { code: "project_media_result_denied" },
    );
  }
  assert.deepEqual(f.state, { authorizations: 2, dns: 0, transport: 0 });
});

test("publisher rejects 65 reviews, duplicate complete pins and conflicting reviewed workflow bytes before any authority or I/O", (t) => {
  const f = fixture(t);
  const reviews = namedMediaWorkflowReviewHistory(1);
  const first = reviews[0]!;
  for (const invalid of [
    [],
    namedMediaWorkflowReviewHistory(33).slice(0, 65),
    [...reviews, first],
    [
      ...reviews,
      {
        ...first,
        workflow: {
          ...first.workflow,
          workflowDigest: `sha256:${"f".repeat(64)}`,
        },
      },
    ],
    [
      {
        ...first,
        targetIdentity: { ...first.targetIdentity, packageDigest: "bad-pin" },
      },
      ...reviews.slice(1),
    ],
    new Proxy(reviews, {}),
  ])
    assert.throws(() => f.open(invalid), {
      code: "project_media_result_review_invalid",
    });
  assert.deepEqual(f.state, { authorizations: 0, dns: 0, transport: 0 });
});
