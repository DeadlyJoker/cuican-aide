import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRunStore } from "@crewon/store";
import { ControlApiClient } from "@crewon/control-client";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { createStandaloneControlApi } from "./standalone-composition.ts";
import { definition, officeActor } from "./office-thread-route.test-support.ts";

test("standalone HTTP composition retains one Office conversation across concurrent clients and server restart", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "crewon-office51-standalone-"),
  );
  const databasePath = join(directory, "control.sqlite");
  const store = new SqliteRunStore(databasePath);
  try {
    await store.commitOfficeDefinition({
      definition,
      expectedRevision: 0,
      receipt: {
        actorId: officeActor.actorId,
        idempotencyKey: "seed-office",
        requestDigest: "seed-office-digest",
      },
    });
  } finally {
    await store.close();
  }
  const origin = "http://127.0.0.1:5175";
  const sessionToken = "office-session-token-".repeat(3);
  const csrfToken = "office-csrf-token-".repeat(3);
  const apps: ReturnType<typeof createStandaloneControlApi>["app"][] = [];
  t.after(async () => {
    for (const app of apps) await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const open = async () => {
    const { app } = createStandaloneControlApi({
      databasePath,
      actor: officeActor,
      defaultAgentVersionId: "agent-1",
      artifactStore: new InMemoryArtifactStore(),
      artifactEncryptionKeyId: "test-key",
      sessionToken,
      csrfToken,
      allowedOrigins: [origin],
      heartbeatIntervalMs: null,
      outboxScanIntervalMs: null,
    });
    apps.push(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address !== "string");
    const client = () =>
      new ControlApiClient({
        baseUrl: `http://127.0.0.1:${address.port}`,
        accessToken: sessionToken,
        csrfToken,
        origin,
      });
    return { app, client };
  };
  const first = await open();
  const version = definition.officeVersionId;
  assert.equal((await first.client().getOfficeThread(version)).thread, null);
  const [a, b] = await Promise.all([
    first.client().createOfficeThread(version, "window-a"),
    first.client().createOfficeThread(version, "window-b"),
  ]);
  assert.equal(a.thread.threadId, b.thread.threadId);
  assert.deepEqual([a.disposition, b.disposition].sort(), [
    "created",
    "existing",
  ]);
  await first.app.close();
  const second = await open();
  const reopened = await second.client().getOfficeThread(version);
  assert.equal(reopened.thread?.threadId, a.thread.threadId);
  const retry = await second
    .client()
    .createOfficeThread(version, "new-window-after-restart");
  assert.equal(retry.disposition, "existing");
  assert.equal(retry.thread.threadId, a.thread.threadId);
});
