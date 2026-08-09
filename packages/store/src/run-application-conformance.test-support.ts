import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";

import {
  ApplicationError,
  RunApplicationService,
  type ActorContext,
  type ApplicationClock,
  type ApplicationIdGenerator,
  type ApplicationIdKind,
  type AuthorizationDecision,
  type AuthorizationPort,
  type CreateRunCommand,
  type RunStore,
  type ThreadStore,
} from "@crewon/application";
import { seedThread } from "./thread-store-conformance.test-support.ts";

/** Registers application behavior against every durable RunStore adapter. */
export function registerRunApplicationConformance(
  name: string,
  createStore: () =>
    | RunApplicationConformanceStore
    | Promise<RunApplicationConformanceStore>,
): void {
  describe(name, () => {
    test("replays create when regenerated identifiers and time differ", async (context) => {
      const store = await managedStore(context, createStore);
      const authorization = new MutableAuthorization();
      const service = new RunApplicationService({
        store,
        authorization,
        ids: new ScriptedIds([
          "run-first",
          "event-first",
          "outbox-first",
          "work-first",
          "run-retry",
          "event-retry",
          "outbox-retry",
          "work-retry",
        ]),
        clock: new ScriptedClock([
          "2026-08-08T00:00:01Z",
          "2026-08-08T00:01:01Z",
        ]),
      });

      const committed = await service.createRun(actor(), createCommand());
      const replayed = await service.createRun(actor(), createCommand());

      assert.deepEqual(replayed, {
        ...committed,
        disposition: "replayed",
      });
      assert.equal(
        await store.loadRun({ tenantId: "tenant-1", runId: "run-retry" }),
        null,
      );
      assert.deepEqual(await store.listPendingOutbox(100), committed.outbox);
      assert.deepEqual(
        await store.listPendingWorkItems(100),
        committed.workItems,
      );
      assert.equal(authorization.requests.length, 2);
    });

    test("rejects semantic reuse of an idempotency key without a second run", async (context) => {
      const store = await managedStore(context, createStore);
      const service = new RunApplicationService({
        store,
        authorization: new MutableAuthorization(),
        ids: new ScriptedIds([
          "run-first",
          "event-first",
          "outbox-first",
          "work-first",
          "run-conflict",
          "event-conflict",
          "outbox-conflict",
          "work-conflict",
        ]),
        clock: new ScriptedClock([
          "2026-08-08T00:00:01Z",
          "2026-08-08T00:01:01Z",
        ]),
      });
      await service.createRun(actor(), createCommand());

      await assert.rejects(
        service.createRun(actor(), {
          ...createCommand(),
          threadId: "thread-changed",
        }),
        hasApplicationError("conflict", "idempotency_conflict"),
      );
      assert.equal(
        await store.loadRun({ tenantId: "tenant-1", runId: "run-conflict" }),
        null,
      );
      assert.equal((await store.listPendingOutbox(100)).length, 1);
    });

    test("scopes the same idempotency key independently per actor", async (context) => {
      const store = await managedStore(context, createStore);
      const service = new RunApplicationService({
        store,
        authorization: new MutableAuthorization(),
        ids: new ScriptedIds([
          "run-actor-1",
          "event-actor-1",
          "outbox-actor-1",
          "work-actor-1",
          "run-actor-2",
          "event-actor-2",
          "outbox-actor-2",
          "work-actor-2",
        ]),
        clock: new ScriptedClock([
          "2026-08-08T00:00:01Z",
          "2026-08-08T00:00:02Z",
        ]),
      });

      await service.createRun(actor(), createCommand());
      await service.createRun(
        {
          ...actor(),
          principalId: "principal-2",
          actorId: "actor-2",
        },
        createCommand(),
      );

      assert.notEqual(
        await store.loadRun({
          tenantId: "tenant-1",
          runId: "run-actor-1",
        }),
        null,
      );
      assert.notEqual(
        await store.loadRun({
          tenantId: "tenant-1",
          runId: "run-actor-2",
        }),
        null,
      );
      assert.equal((await store.listPendingOutbox(100)).length, 2);
    });

    test("replays an earlier transition after later revisions without mutating current state", async (context) => {
      const store = await managedStore(context, createStore);
      const service = new RunApplicationService({
        store,
        authorization: new MutableAuthorization(),
        ids: new ScriptedIds([
          "run-1",
          "event-1",
          "outbox-1",
          "work-1",
          "event-2",
          "outbox-2",
          "event-3",
          "outbox-3",
          "event-retry",
          "outbox-retry",
        ]),
        clock: new ScriptedClock([
          "2026-08-08T00:00:01Z",
          "2026-08-08T00:00:02Z",
          "2026-08-08T00:00:03Z",
          "2026-08-08T00:01:02Z",
        ]),
      });
      await service.createRun(actor(), createCommand());
      const started = await service.transitionRun(actor(), {
        kind: "run.start",
        runId: "run-1",
        expectedRevision: 1,
        idempotencyKey: "start-1",
      });
      await service.transitionRun(actor(), {
        kind: "run.suspend",
        runId: "run-1",
        expectedRevision: 2,
        idempotencyKey: "suspend-1",
        reasonCode: "manual_pause",
      });

      const replayed = await service.transitionRun(actor(), {
        kind: "run.start",
        runId: "run-1",
        expectedRevision: 1,
        idempotencyKey: "start-1",
      });
      assert.deepEqual(replayed, { ...started, disposition: "replayed" });
      assert.equal(
        (await service.getRun(actor(), "run-1")).status,
        "suspended",
      );
      assert.equal(
        (
          await service.listRunEvents(actor(), {
            runId: "run-1",
            afterSequence: 0,
            limit: 100,
          })
        ).length,
        3,
      );
      assert.equal((await store.listPendingOutbox(100)).length, 3);
    });

    test("hides tenant and space existence and denies an unauthorized read", async (context) => {
      const store = await managedStore(context, createStore);
      const authorization = new MutableAuthorization();
      const service = new RunApplicationService({
        store,
        authorization,
        ids: new ScriptedIds(["run-1", "event-1", "outbox-1", "work-1"]),
        clock: new ScriptedClock(["2026-08-08T00:00:01Z"]),
      });
      await service.createRun(actor(), createCommand());
      const requestsAfterCreate = authorization.requests.length;

      await assert.rejects(
        service.getRun({ ...actor(), tenantId: "tenant-2" }, "run-1"),
        hasApplicationError("notFound", "run_not_found"),
      );
      await assert.rejects(
        service.getRun({ ...actor(), spaceId: "space-2" }, "run-1"),
        hasApplicationError("notFound", "run_not_found"),
      );
      assert.equal(authorization.requests.length, requestsAfterCreate);

      authorization.decision = {
        outcome: "deny",
        reasonCode: "membership_revoked",
      };
      await assert.rejects(
        service.getRun(actor(), "run-1"),
        hasApplicationError("authorization", "authorization_denied"),
      );
      assert.equal(authorization.requests.at(-1)?.action, "run:read");
    });
  });
}

class MutableAuthorization implements AuthorizationPort {
  readonly requests: Parameters<AuthorizationPort["authorize"]>[0][] = [];
  decision: AuthorizationDecision = { outcome: "allow" };

  async authorize(
    request: Parameters<AuthorizationPort["authorize"]>[0],
  ): Promise<AuthorizationDecision> {
    this.requests.push(structuredClone(request));
    return this.decision;
  }
}

class ScriptedIds implements ApplicationIdGenerator {
  readonly #ids: string[];

  constructor(ids: string[]) {
    this.#ids = [...ids];
  }

  nextId(_kind: ApplicationIdKind): string {
    const id = this.#ids.shift();
    if (id === undefined) {
      throw new Error("scripted id exhausted");
    }
    return id;
  }
}

class ScriptedClock implements ApplicationClock {
  readonly #timestamps: string[];

  constructor(timestamps: string[]) {
    this.#timestamps = [...timestamps];
  }

  now(): string {
    const timestamp = this.#timestamps.shift();
    if (timestamp === undefined) {
      throw new Error("scripted clock exhausted");
    }
    return timestamp;
  }
}

async function managedStore(
  context: TestContext,
  createStore: () =>
    | RunApplicationConformanceStore
    | Promise<RunApplicationConformanceStore>,
): Promise<RunApplicationConformanceStore> {
  const store = await createStore();
  context.after(() => store.close());
  await seedThread(store);
  return store;
}

type RunApplicationConformanceStore = RunStore & ThreadStore;

function actor(): ActorContext {
  return {
    principalId: "principal-1",
    actorId: "actor-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
  };
}

function createCommand(): CreateRunCommand {
  return {
    kind: "run.create",
    idempotencyKey: "create-1",
    threadId: "thread-1",
    route: {
      authorityId: "standalone-1",
      runtimeGeneration: "ts-v0",
      agentVersionId: "agent-version-1",
      policySnapshotId: "policy-1",
      workspaceBindingId: "workspace-1",
    },
  };
}

function hasApplicationError(
  category: ApplicationError["category"],
  code: string,
): (error: unknown) => boolean {
  return (error) =>
    error instanceof ApplicationError &&
    error.category === category &&
    error.code === code;
}
