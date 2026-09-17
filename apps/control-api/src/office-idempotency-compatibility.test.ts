import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import { canonicalJson, type DomainStore } from "@crewon/application";
import { PostgresDomainStore, SqliteRunStore } from "@crewon/store";
import {
  definition,
  officeActor,
  officeRouteFixture,
} from "./office-thread-route.test-support.ts";
import { NodeSha256ContentDigester } from "./standalone-adapters.ts";

const command = {
  idempotencyKey: "office-create-legacy",
  officeId: definition.officeId,
  expectedRevision: 0,
  title: definition.title,
  members: definition.members,
  executionTargets: definition.executionTargets,
};
const legacyHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };

  test(
    `${backend}: old Office receipts replay after reopen with exactly the original digest`,
    options,
    async (t) => {
      const db = await fixture(t, backend);
      const first = await db.open();
      await first.commitOfficeDefinition({
        definition,
        expectedRevision: 0,
        receipt: {
          actorId: officeActor.actorId,
          idempotencyKey: command.idempotencyKey,
          requestDigest: legacyHash(canonicalJson(command)),
        },
      });
      await first.close();
      const f = await officeRouteFixture(t, await db.open());
      await seedAgent(f.store);
      assert.deepEqual(await f.offices.create(officeActor, command), {
        disposition: "replayed",
        definition,
      });
      await assert.rejects(
        f.offices.create(officeActor, {
          ...command,
          title: "Different request",
        }),
        /office_idempotency_conflict/u,
      );
      assert.deepEqual(
        await f.store.listOfficeDefinitions({
          ...officeActor,
          before: null,
          limit: 10,
        }),
        [definition],
      );
      await f.close();
    },
  );

  test(
    `${backend}: HTTP Office creation preserves the legacy thread receipt scope across reopen`,
    options,
    async (t) => {
      const db = await fixture(t, backend);
      const f = await officeRouteFixture(t, await db.open());
      const commit = f.store.commitThread.bind(f.store);
      const observed = t.mock.method(f.store, "commitThread", commit);
      const result = await f.client.createOfficeThread(
        definition.officeVersionId,
        "same-request",
      );
      assert.equal(observed.mock.callCount(), 1);
      const input = observed.mock.calls[0]!.arguments[0];
      const oldScope = `office.thread.create:${legacyHash(canonicalJson([officeActor.tenantId, officeActor.spaceId, officeActor.actorId, definition.officeId]))}`;
      assert.equal(input.idempotency?.scope, oldScope);
      await f.close();
      const reopened = await db.open();
      assert.equal(
        (
          await reopened.commitThread({
            ...input,
            idempotency: { ...input.idempotency!, scope: oldScope },
          })
        ).disposition,
        "replayed",
      );
      assert.equal(
        (
          await reopened.listThreadEvents(
            {
              tenantId: officeActor.tenantId,
              threadId: result.thread.threadId,
            },
            0,
            100,
          )
        ).length,
        1,
      );
      await reopened.close();
    },
  );

  test(
    `${backend}: invalid digest output cannot commit an Office or its conversation`,
    options,
    async (t) => {
      const db = await fixture(t, backend);
      const f = await officeRouteFixture(t, await db.open());
      await seedAgent(f.store);
      t.mock.method(
        NodeSha256ContentDigester.prototype,
        "sha256",
        () => "untrusted-digest",
      );
      const offices = t.mock.method(
        f.store,
        "commitOfficeDefinition",
        f.store.commitOfficeDefinition.bind(f.store),
      );
      const threads = t.mock.method(
        f.store,
        "commitThread",
        f.store.commitThread.bind(f.store),
      );
      await assert.rejects(
        f.offices.create(officeActor, { ...command, officeId: "new-office" }),
        /office_idempotency_digest_invalid/u,
      );
      await assert.rejects(
        f.client.createOfficeThread(definition.officeVersionId, "bad-digest"),
      );
      assert.equal(offices.mock.callCount(), 0);
      assert.equal(threads.mock.callCount(), 0);
      assert.equal(
        (await f.client.getOfficeThread(definition.officeVersionId)).thread,
        null,
      );
      await f.close();
    },
  );
}

async function seedAgent(store: DomainStore) {
  await store.registerAgentVersion({
    schemaVersion: "crewon.agent-version-asset.v0",
    tenantId: officeActor.tenantId,
    agentVersionId: "agent-1",
    contentDigest: `sha256:${"a".repeat(64)}`,
    definitionJson: '{"schemaVersion":"crewon.agent-version.v0"}',
    createdAt: definition.createdAt,
  });
}

async function fixture(t: TestContext, backend: "sqlite" | "postgres") {
  const stores: DomainStore[] = [];
  let open: () => Promise<DomainStore>;
  let cleanup: () => Promise<void>;
  if (backend === "sqlite") {
    const dir = await mkdtemp(join(tmpdir(), "crewon-office87-"));
    open = async () => new SqliteRunStore(join(dir, "test.sqlite"));
    cleanup = () => rm(dir, { recursive: true, force: true });
  } else {
    const connectionString = process.env.CREWON_TEST_POSTGRES_URL!;
    const schema = `office87_${randomUUID().replaceAll("-", "")}`;
    open = () =>
      PostgresDomainStore.open({ connectionString, schema, maxPoolSize: 2 });
    cleanup = async () => {
      const pool = new Pool({ connectionString, max: 1 });
      try {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await pool.end();
      }
    };
  }
  t.after(async () => {
    for (const store of stores) await store.close();
    await cleanup();
  });
  return {
    open: async () => {
      const store = await open();
      stores.push(store);
      return store;
    },
  };
}
