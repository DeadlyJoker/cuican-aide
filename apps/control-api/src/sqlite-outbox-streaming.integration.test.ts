import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test, type TestContext } from "node:test";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { ControlApiClient, streamRunEvents } from "@crewon/control-client";
import { SqliteRunStore } from "@crewon/store";
import type { RunLifecycleEvent } from "@crewon/domain";

import { createStandaloneControlApi } from "./standalone-composition.ts";
import { watchSqliteOutboxAvailability } from "./sqlite-outbox-wakeup.ts";

const SESSION = "wake-test-session-at-least-32-bytes";
const CSRF = "wake-test-csrf-at-least-32-bytes-000";
const ORIGIN = "http://127.0.0.1:5175";
const RUN = "wake-run";
const timing: Readonly<Record<string, number | string>>[] = [];

after(() =>
  writeFile(
    join(tmpdir(), "crewon-sqlite-outbox-streaming-timing.json"),
    `${JSON.stringify(timing, null, 2)}\n`,
  ),
);

test("an independent SQLite writer streams committed deltas before the 60-second scan and supports Last-Event-ID reconnect", async (context) => {
  const fixture = await createFixture(context, 60_000);
  let hints = 0;
  const owner = watchSqliteOutboxAvailability({
    databasePath: fixture.path,
    outbox: {
      notifyAvailability: () => {
        hints++;
        fixture.control.outboxDispatcher.notifyAvailability();
      },
    },
  });
  context.after(() => owner.close());
  assert.equal(owner.status(), "watching");
  const first = fixture.openStream(2);
  const firstRead = first.events.next();
  await first.ready;
  const committed = await append(fixture.child, "第一块😀");
  const visible = await within(firstRead);
  const elapsed = Date.now() - committed.committedAt;
  assert.equal(visible.value?.type, "model.output.delta");
  assert.deepEqual(visible.value?.data, {
    segmentId: "wake-segment",
    delta: "第一块😀",
  });
  assert.equal(visible.value?.sequence, 3);
  assert.notEqual(committed.pid, process.pid);
  assert.ok(elapsed < 1000, `first delta waited ${elapsed}ms`);
  assert.equal((await fixture.client.getRun(RUN)).run.status, "running");
  timing.push({
    mode: "file-hint",
    scanMs: 60_000,
    commitToClientMs: elapsed,
    writerPid: committed.pid,
    controlPid: process.pid,
  });
  first.controller.abort();
  await first.events.return?.(undefined);

  const resumed = fixture.openStream(3);
  const resumedRead = resumed.events.next();
  await resumed.ready;
  const second = await append(fixture.child, "第二块");
  const resumedEvent = await within(resumedRead);
  assert.equal(resumedEvent.value?.sequence, 4);
  assert.equal(resumedEvent.value?.type, "model.output.delta");
  assert.deepEqual(resumedEvent.value?.data, {
    segmentId: "wake-segment",
    delta: "第二块",
  });
  assert.equal((await fixture.client.getRun(RUN)).run.status, "running");
  const persisted = await fixture.store.listRunEvents(
    { tenantId: "wake-tenant", runId: RUN },
    2,
    10,
  );
  assert.deepEqual(
    persisted.map((event) => event.sequence),
    [3, 4],
  );
  timing.push({
    mode: "file-hint-reconnect",
    scanMs: 60_000,
    commitToClientMs: Date.now() - second.committedAt,
    writerPid: second.pid,
    controlPid: process.pid,
  });
  resumed.controller.abort();
  await resumed.events.return?.(undefined);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const settledHints = hints;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    hints,
    settledHints,
    "claim/ack WAL changes must converge after the durable queue empties",
  );
  assert.equal(
    fixture.control.outboxDispatcher.deliveryStatus().inFlight,
    false,
  );
});

test("unavailable file hints fall back to the unchanged 1000ms durable scan", async (context) => {
  const fixture = await createFixture(context, 1000);
  const owner = watchSqliteOutboxAvailability({
    databasePath: fixture.path,
    outbox: fixture.control.outboxDispatcher,
    watchFactory: () => {
      throw new Error("fixture_no_file_notifications");
    },
  });
  context.after(() => owner.close());
  assert.equal(owner.status(), "unavailable");
  const stream = fixture.openStream(2);
  const next = stream.events.next();
  await stream.ready;
  const committed = await append(fixture.child, "扫描恢复");
  const visible = await within(next, 2500);
  const elapsed = Date.now() - committed.committedAt;
  assert.equal(visible.value?.sequence, 3);
  assert.equal(visible.value?.type, "model.output.delta");
  assert.deepEqual(visible.value?.data, {
    segmentId: "wake-segment",
    delta: "扫描恢复",
  });
  assert.equal(fixture.control.outboxDispatcher.lastFailureCode(), null);
  timing.push({
    mode: "missing-hint-scan-fallback",
    scanMs: 1000,
    commitToClientMs: elapsed,
    writerPid: committed.pid,
    controlPid: process.pid,
  });
  stream.controller.abort();
  await stream.events.return?.(undefined);
});

test("a metadata hint without a committed Outbox cannot publish output", async (context) => {
  const fixture = await createFixture(context, 60_000);
  const stream = fixture.openStream(2);
  let observed = false;
  const next = stream.events.next().then((event) => {
    observed = true;
    return event;
  });
  await stream.ready;
  for (let index = 0; index < 20_000; index++)
    fixture.control.outboxDispatcher.notifyAvailability();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(observed, false);
  assert.deepEqual(await fixture.store.listPendingOutbox(10), []);
  stream.controller.abort();
  await next.catch(() => {});
  await stream.events.return?.(undefined);
});

async function createFixture(context: TestContext, scanIntervalMs: number) {
  const directory = await mkdtemp(
    join(tmpdir(), "crewon-sqlite-outbox-stream-"),
  );
  const path = join(directory, "control.sqlite");
  const control = createStandaloneControlApi({
    databasePath: path,
    actor: {
      tenantId: "wake-tenant",
      spaceId: "wake-space",
      actorId: "wake-actor",
      principalId: "wake-principal",
    },
    artifactStore: new InMemoryArtifactStore(),
    artifactEncryptionKeyId: "wake-artifact-key",
    defaultAgentVersionId: "wake-agent",
    sessionToken: SESSION,
    csrfToken: CSRF,
    allowedOrigins: [ORIGIN],
    heartbeatIntervalMs: null,
    outboxScanIntervalMs: scanIntervalMs,
    outboxRetention: null,
    artifactRetention: null,
  });
  const controllers: AbortController[] = [];
  context.after(async () => {
    for (const controller of controllers) controller.abort();
    await control.app.close();
    await rm(directory, { recursive: true, force: true });
  });
  await control.app.listen({ host: "127.0.0.1", port: 0 });
  const address = control.app.server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const client = new ControlApiClient({
    baseUrl,
    accessToken: SESSION,
    csrfToken: CSRF,
    origin: ORIGIN,
  });
  const thread = await client.createThread(
    { title: "Streaming wake test" },
    "wake-thread",
  );
  const store = new SqliteRunStore(path);
  context.after(() => store.close());
  const created: RunLifecycleEvent = {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: RUN },
    eventId: `${RUN}:1`,
    sequence: 1,
    occurredAt: new Date().toISOString(),
    type: "run.created",
    data: {
      tenantId: "wake-tenant",
      spaceId: "wake-space",
      threadId: thread.thread.threadId,
      createdByActorId: "wake-actor",
      authorityId: "wake-authority",
      runtimeGeneration: "wake-generation",
      agentVersionId: "wake-agent",
      policySnapshotId: "wake-policy",
      workspaceBindingId: null,
      collaborationMode: "default",
      goalBinding: null,
    },
  };
  await store.commitRun({
    tenantId: "wake-tenant",
    idempotency: {
      scope: "seed",
      key: "wake-run",
      requestFingerprint: "wake-run",
    },
    expectedRevision: 0,
    events: [
      created,
      {
        ...created,
        eventId: `${RUN}:2`,
        sequence: 2,
        type: "run.started",
        data: {},
      },
    ],
    outbox: [],
    workItems: [],
  });
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      fileURLToPath(
        new URL("./sqlite-outbox-writer.fixture.ts", import.meta.url),
      ),
      path,
      RUN,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  let errors = "";
  child.stderr!.on("data", (chunk: Buffer) => {
    errors = `${errors}${chunk}`.slice(-4096);
  });
  context.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    if (child.connected) child.send("close");
    try {
      await within(exited);
    } catch {
      child.kill("SIGKILL");
      await exited;
    }
  });
  const ready = await childMessage(child, "ready").catch((error: unknown) => {
    throw new Error("fixture_writer_startup_failed", { cause: error });
  });
  assert.equal(ready.pid, child.pid, errors);
  function openStream(afterSequence: number) {
    const controller = new AbortController();
    controllers.push(controller);
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const streamingClient = new ControlApiClient({
      baseUrl,
      accessToken: SESSION,
      csrfToken: CSRF,
      origin: ORIGIN,
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (
          response.status === 200 &&
          response.headers.get("content-type")?.startsWith("text/event-stream")
        )
          resolveReady();
        return response;
      },
    });
    return {
      controller,
      ready: within(ready),
      events: streamRunEvents(streamingClient, {
        runId: RUN,
        afterSequence,
        view: "transcript",
        signal: controller.signal,
      })[Symbol.asyncIterator](),
    };
  }
  return { path, control, store, client, child, openStream };
}

async function append(child: ChildProcess, delta: string) {
  const committed = childMessage(child, "committed");
  child.send({ kind: "append", delta });
  const message = await committed;
  assert.ok(
    typeof message.committedAt === "number" &&
      typeof message.sequence === "number",
  );
  return message as { committedAt: number; sequence: number; pid: number };
}

function childMessage(child: ChildProcess, kind: "ready" | "committed") {
  return within(
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const message = (value: unknown) => {
        if (
          typeof value !== "object" ||
          value === null ||
          !("kind" in value) ||
          value.kind !== kind
        )
          return;
        cleanup();
        resolve(value as Record<string, unknown>);
      };
      const exited = () => {
        cleanup();
        reject(new Error("fixture_writer_exited"));
      };
      const cleanup = () => {
        child.off("message", message);
        child.off("exit", exited);
      };
      child.on("message", message);
      child.once("exit", exited);
    }),
  );
}

async function within<T>(promise: Promise<T>, timeoutMs = 3000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("stream_fixture_deadline")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
