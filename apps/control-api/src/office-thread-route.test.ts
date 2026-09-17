import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRunStore } from "@crewon/store";
import {
  definition,
  officeActor,
  officeHeaders,
  officeRouteFixture,
} from "./office-thread-route.test-support.ts";

const version = definition.officeVersionId;
const route = `/api/v1/offices/${version}/thread`;

test("the actual client creates and reopens a bound Office without scanning the catalog", async (t) => {
  const f = await officeRouteFixture(t);
  t.mock.method(f.store, "listThreads", () => {
    throw new Error("catalog must not be read");
  });
  assert.equal((await f.client.getOfficeThread(version)).thread, null);
  const created = await f.client.createOfficeThread(version, "first");
  assert.equal(created.disposition, "created");
  const reopened = await f.makeClient().getOfficeThread(version);
  assert.deepEqual(reopened.thread, created.thread);
  const retry = await f.client.createOfficeThread(version, "after-remount");
  assert.equal(retry.disposition, "existing");
  assert.equal(retry.thread.threadId, created.thread.threadId);
  assert.equal(
    (
      await f.store.listThreadEvents(
        { tenantId: officeActor.tenantId, threadId: created.thread.threadId },
        0,
        100,
      )
    ).length,
    1,
  );
  assert.ok(
    f.authorizationRequests.some(
      (r) =>
        r.action === "office:create" &&
        r.resource.kind === "office" &&
        r.resource.officeId === definition.officeId,
    ),
  );
});

test("concurrent HTTP callers produce one Thread and one association", async (t) => {
  const f = await officeRouteFixture(t);
  const [a, b] = await Promise.all([
    f.client.createOfficeThread(version, "a"),
    f.makeClient().createOfficeThread(version, "b"),
  ]);
  assert.equal(a.thread.threadId, b.thread.threadId);
  assert.deepEqual([a.disposition, b.disposition].sort(), [
    "created",
    "existing",
  ]);
  assert.equal(
    (await f.store.listThreads({ ...officeActor, before: null, limit: 100 }))
      .length,
    1,
  );
});

test("lost committed response remains discoverable and new-key retries do not create orphans", async (t) => {
  const f = await officeRouteFixture(t);
  const lost = f.makeClient(async (...args) => {
    await f.fetch(...args);
    throw new Error("response lost");
  });
  await assert.rejects(
    lost.createOfficeThread(version, "lost"),
    /response lost/u,
  );
  const reopened = await f.client.getOfficeThread(version);
  assert.ok(reopened.thread);
  const retry = await f.client.createOfficeThread(version, "new-window");
  assert.equal(retry.disposition, "existing");
  assert.equal(retry.thread.threadId, reopened.thread.threadId);
  assert.equal(
    (await f.store.listThreads({ ...officeActor, before: null, limit: 100 }))
      .length,
    1,
  );
});

test("explicit legacy adoption preserves model history and survives an Office title revision", async (t) => {
  const f = await officeRouteFixture(t);
  const created = await f.threads.createThread(officeActor, {
    kind: "thread.create",
    idempotencyKey: "legacy",
    title: "Legacy conversation",
  });
  const id = created.state.threadId;
  await f.threads.appendMessage(officeActor, {
    kind: "thread.message.append",
    idempotencyKey: "message",
    threadId: id,
    expectedRevision: 1,
    role: "user",
    content: "Retain this exact model prefix",
  });
  const locator = { tenantId: officeActor.tenantId, threadId: id };
  const history = await f.store.listModelHistoryItems(locator, 0, 100);
  const events = await f.store.listThreadEvents(locator, 0, 100);
  await assert.rejects(
    f.client.bindOfficeThread(version, { threadId: id, expectedRevision: 1 }),
    { code: "revision_conflict" },
  );
  assert.equal((await f.client.getOfficeThread(version)).thread, null);
  const adopted = await f.client.bindOfficeThread(version, {
    threadId: id,
    expectedRevision: 2,
  });
  assert.equal(adopted.disposition, "bound");
  assert.equal(adopted.thread.title, "Legacy conversation");
  assert.deepEqual(
    await f.store.listModelHistoryItems(locator, 0, 100),
    history,
  );
  assert.deepEqual(await f.store.listThreadEvents(locator, 0, 100), events);
  const revised = {
    ...definition,
    officeVersionId: "office-version-2",
    revision: 2,
    title: "Renamed Office",
  };
  await f.seedOffice(revised);
  assert.equal(
    (await f.client.getOfficeThread(revised.officeVersionId)).thread?.threadId,
    id,
  );
  assert.equal(
    (
      await f.client.bindOfficeThread(revised.officeVersionId, {
        threadId: id,
        expectedRevision: 1,
      })
    ).disposition,
    "existing",
  );
});

for (const action of [
  "office:read",
  "office:create",
  "thread:create",
] as const) {
  test(`create enforces ${action} before writing`, async (t) => {
    const f = await officeRouteFixture(t);
    f.deny(action);
    await assert.rejects(f.client.createOfficeThread(version, "denied"), {
      status: 403,
    });
    assert.equal(await f.store.loadOfficeThreadBinding(definition), null);
    assert.equal(
      (await f.store.listThreads({ ...officeActor, before: null, limit: 100 }))
        .length,
      0,
    );
  });
}
for (const action of [
  "office:create",
  "thread:read",
  "thread:message:append",
] as const) {
  test(`adoption enforces ${action} before writing`, async (t) => {
    const f = await officeRouteFixture(t);
    const created = await f.threads.createThread(officeActor, {
      kind: "thread.create",
      idempotencyKey: "legacy",
      title: "Legacy",
    });
    f.deny(action);
    await assert.rejects(
      f.client.bindOfficeThread(version, {
        threadId: created.state.threadId,
        expectedRevision: 1,
      }),
      { status: 403 },
    );
    assert.equal(await f.store.loadOfficeThreadBinding(definition), null);
  });
}

test("inaccessible and deleted bound Threads never authorize replacement creation", async (t) => {
  const f = await officeRouteFixture(t);
  const created = await f.client.createOfficeThread(version, "first");
  f.deny("thread:read");
  await assert.rejects(f.client.getOfficeThread(version), { status: 403 });
  await assert.rejects(f.client.createOfficeThread(version, "retry"), {
    status: 403,
  });
  f.deny(null);
  await f.threads.deleteThread(officeActor, {
    kind: "thread.delete",
    threadId: created.thread.threadId,
    expectedRevision: 1,
    idempotencyKey: "delete",
  });
  await assert.rejects(f.client.createOfficeThread(version, "replacement"), {
    status: 404,
  });
  assert.equal(
    (await f.store.loadOfficeThreadBinding(definition))?.threadId,
    created.thread.threadId,
  );
});

test("both mutation routes require CSRF and reject client-owned authority", async (t) => {
  const f = await officeRouteFixture(t);
  const { "x-csrf-token": _csrf, ...withoutCsrf } = officeHeaders;
  for (const url of [route, `${route}-binding`]) {
    const response = await f.app.inject({
      method: "POST",
      url,
      headers: withoutCsrf,
      payload: {},
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, "csrf_invalid");
  }
  const invalid = await f.app.inject({
    method: "POST",
    url: route,
    headers: officeHeaders,
    payload: { tenantId: "other", title: "spoofed" },
  });
  assert.equal(invalid.statusCode, 400);
  const { "idempotency-key": _key, ...withoutKey } = officeHeaders;
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: route,
        headers: withoutKey,
        payload: {},
      })
    ).statusCode,
    400,
  );
  assert.equal(await f.store.loadOfficeThreadBinding(definition), null);
});

test("SQLite API restart preserves the association and does not write a replacement", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "crewon-office51-api-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "test.sqlite");
  const first = await officeRouteFixture(t, new SqliteRunStore(path));
  const original = await first.client.createOfficeThread(version, "first");
  await first.close();
  const restarted = await officeRouteFixture(t, new SqliteRunStore(path));
  assert.equal(
    (await restarted.client.getOfficeThread(version)).thread?.threadId,
    original.thread.threadId,
  );
  assert.equal(
    (await restarted.client.createOfficeThread(version, "after-restart"))
      .disposition,
    "existing",
  );
  await restarted.close();
});
