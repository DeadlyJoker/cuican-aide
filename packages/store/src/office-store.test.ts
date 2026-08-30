import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteRunStore } from "./sqlite-run-store.ts";

const definition = {
  schemaVersion: "crewon.office-definition.v0" as const,
  tenantId: "tenant-1",
  spaceId: "space-1",
  officeId: "office-1",
  officeVersionId: "office-version-1",
  revision: 1,
  title: "Delivery",
  members: [
    {
      memberId: "member-1",
      displayName: "Delivery agent",
      agentVersionId: "agent-version-1",
    },
  ],
  executionTargets: [
    { targetId: "primary", agentVersionId: "agent-version-1" },
  ],
  createdByActorId: "actor-1",
  createdAt: "2026-08-13T00:00:00.000Z",
};

test("SQLite persists and replays an immutable Office definition", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "crewon-office-store-"));
  context.after(() => rm(directory, { force: true, recursive: true }));
  const path = join(directory, "control.sqlite");
  const input = {
    definition,
    expectedRevision: 0,
    receipt: {
      actorId: "actor-1",
      idempotencyKey: "office-create-1",
      requestDigest: "digest-1",
    },
  };

  const store = new SqliteRunStore(path);
  assert.deepEqual(await store.commitOfficeDefinition(input), {
    disposition: "created",
    definition,
  });
  assert.deepEqual(await store.commitOfficeDefinition(input), {
    disposition: "replayed",
    definition,
  });
  await store.close();

  const reopened = new SqliteRunStore(path);
  context.after(() => reopened.close());
  assert.deepEqual(
    await reopened.loadOfficeDefinition({
      tenantId: "tenant-1",
      spaceId: "space-1",
      officeVersionId: "office-version-1",
    }),
    definition,
  );
  assert.deepEqual(
    await reopened.listOfficeDefinitions({
      tenantId: "tenant-1",
      spaceId: "space-1",
      before: null,
      limit: 100,
    }),
    [definition],
  );
});
