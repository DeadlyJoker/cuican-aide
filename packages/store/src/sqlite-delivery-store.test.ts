import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { XLSX_MEDIA_TYPE, type DeliveryVersionRecord } from "@crewon/domain";
import { SqliteDeliveryStore } from "./sqlite-delivery-store.ts";

test("F01-R05/R06 encrypted bytes survive reopen; CAS and durable idempotency preserve manual changes", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "crewon-delivery-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = {
    databasePath: path.join(dir, "files.sqlite"),
    encryptionKey: new Uint8Array(32).fill(9),
  };
  const content = new TextEncoder().encode("private original workbook bytes");
  const target = {
    schemaVersion: "crewon.delivery-target.v1",
    tenantId: "t",
    spaceId: "s",
    threadId: "thread",
    targetId: "thread-deliveries",
  } as const;
  const scope = { target, ownerActorId: "owner" };
  const record: DeliveryVersionRecord = {
    schemaVersion: "crewon.delivery-result.v1",
    target,
    deliveryId: "d",
    versionId: "v1",
    contentDigest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    byteLength: content.length,
    mediaType: XLSX_MEDIA_TYPE,
    sourceRunId: null,
    availability: "ready",
    ownerActorId: "owner",
    name: "out.xlsx",
    createdAt: "2026-09-14T00:00:00Z",
    parentVersionId: null,
    inputIds: [],
    inspection: { sheets: [], formulaCount: 0 },
    validation: {
      status: "verified",
      sources: [],
      writtenRows: 0,
      numericTotals: {},
      formulaCount: 0,
      warnings: [],
    },
    retention: "saved",
  };
  const store = new SqliteDeliveryStore(config);
  await store.commitVersion({
    scope,
    record,
    content,
    expected: null,
    key: "create",
    fingerprint: "one",
  });
  const manual = { ...record, versionId: "v2", parentVersionId: "v1" };
  const expected = { versionId: "v1", contentDigest: record.contentDigest };
  const concurrent = await Promise.allSettled([
    store.commitVersion({
      scope,
      record: manual,
      content,
      expected,
      key: "manual",
      fingerprint: "two",
    }),
    store.commitVersion({
      scope,
      record: { ...manual, versionId: "v3" },
      content,
      expected,
      key: "agent",
      fingerprint: "three",
    }),
  ]);
  assert.equal(concurrent.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(concurrent.filter((r) => r.status === "rejected").length, 1);
  await store.close();
  const reopened = new SqliteDeliveryStore(config);
  t.after(() => reopened.close());
  assert.deepEqual((await reopened.getVersion(scope, "v1"))?.content, content);
  assert.equal((await reopened.catalog(scope)).deliveries[0]?.versionId, "v2");
  assert.equal((await reopened.history(scope, "d")).length, 2);
  assert.equal(
    (
      await reopened.commitVersion({
        scope,
        record: manual,
        content,
        expected,
        key: "manual",
        fingerprint: "two",
      })
    ).versionId,
    "v2",
  );
  await assert.rejects(
    reopened.findOperation(scope, "manual", "changed"),
    /idempotency_conflict/,
  );
  assert.equal(
    await reopened.getVersion({ ...scope, ownerActorId: "other" }, "v1"),
    null,
  );
  assert.equal(
    await reopened.getVersion(
      { ...scope, target: { ...target, threadId: "other" } },
      "v1",
    ),
    null,
  );
  assert.equal(
    readFileSync(config.databasePath).includes(Buffer.from(content)),
    false,
  );
});
