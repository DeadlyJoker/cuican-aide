import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { KnowledgeStore } from "@crewon/application";
import type { KnowledgeRecord } from "@crewon/domain";
import { Pool } from "pg";
import { PostgresDomainStore } from "./postgres-domain-store.ts";
import { SqliteRunStore } from "./sqlite-run-store.ts";

describe("SQLite Knowledge authority", () => {
  test("commits receipt-first, replays, isolates scope, and paginates", async (context) => {
    const store = new SqliteRunStore(
      join(mkdtempSync(join(tmpdir(), "knowledge-")), "store.db"),
    );
    context.after(() => store.close());
    await conformance(store);
  });
});

const postgresUrl = process.env.CREWON_TEST_POSTGRES_URL;
if (postgresUrl === undefined || postgresUrl.length === 0) {
  test.skip("PostgreSQL Knowledge conformance requires CREWON_TEST_POSTGRES_URL", () => {});
} else {
  test("PostgreSQL Knowledge authority matches SQLite", async (context) => {
    const schema = `knowledge_${process.pid}_${Date.now()}`;
    const store = await PostgresDomainStore.open({
      connectionString: postgresUrl,
      schema,
    });
    context.after(async () => {
      await store.close();
      const pool = new Pool({ connectionString: postgresUrl });
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    });
    await conformance(store);
  });
}

async function conformance(store: KnowledgeStore): Promise<void> {
  const first = record("knowledge-1", "2026-08-13T00:00:00.000Z");
  const second = record("knowledge-2", "2026-08-13T00:00:01.000Z");
  const descriptor = {
    scope: "knowledge.create:space-1",
    key: "request-1",
    requestFingerprint: "sha256:request-1",
  };
  assert.deepEqual(
    await store.loadKnowledgeReceipt({
      tenantId: "tenant-1",
      spaceId: "space-1",
      idempotency: descriptor,
    }),
    null,
  );
  assert.deepEqual(
    await store.commitKnowledge({
      tenantId: "tenant-1",
      spaceId: "space-1",
      idempotency: descriptor,
      record: first,
    }),
    { disposition: "committed", record: first },
  );
  assert.deepEqual(
    await store.commitKnowledge({
      tenantId: "tenant-1",
      spaceId: "space-1",
      idempotency: descriptor,
      record: record("ignored", "2026-08-13T00:00:02.000Z"),
    }),
    { disposition: "replayed", record: first },
  );
  await store.commitKnowledge({
    tenantId: "tenant-1",
    spaceId: "space-1",
    idempotency: {
      ...descriptor,
      key: "request-2",
      requestFingerprint: "sha256:request-2",
    },
    record: second,
  });
  await assert.rejects(
    store.loadKnowledgeReceipt({
      tenantId: "tenant-1",
      spaceId: "space-1",
      idempotency: { ...descriptor, requestFingerprint: "changed" },
    }),
    /knowledge_idempotency_conflict/,
  );
  await assert.rejects(
    store.commitKnowledge({
      tenantId: "tenant-1",
      spaceId: "other-space",
      idempotency: {
        ...descriptor,
        key: "scope-mismatch",
        requestFingerprint: "sha256:scope-mismatch",
      },
      record: record("scope-mismatch", "2026-08-13T00:00:03.000Z"),
    }),
    /knowledge_scope_mismatch/,
  );
  assert.equal(
    await store.loadKnowledge({
      tenantId: "tenant-1",
      spaceId: "other-space",
      knowledgeId: first.knowledgeId,
    }),
    null,
  );
  const page1 = await store.listKnowledge({
    tenantId: "tenant-1",
    spaceId: "space-1",
    before: null,
    limit: 1,
  });
  assert.deepEqual(page1, {
    data: [second],
    next: { createdAt: second.createdAt, knowledgeId: second.knowledgeId },
  });
  assert.deepEqual(
    await store.listKnowledge({
      tenantId: "tenant-1",
      spaceId: "space-1",
      before: page1.next,
      limit: 1,
    }),
    { data: [first], next: null },
  );
}

function record(knowledgeId: string, createdAt: string): KnowledgeRecord {
  return {
    schemaVersion: "crewon.knowledge.v0",
    knowledgeId,
    tenantId: "tenant-1",
    spaceId: "space-1",
    ownerActorId: "actor-1",
    kind: "memory",
    sourceId: "source-1",
    title: "Bounded memory",
    content: "Remember this.",
    contentDigest: `sha256:${"a".repeat(64)}`,
    createdAt,
  };
}
