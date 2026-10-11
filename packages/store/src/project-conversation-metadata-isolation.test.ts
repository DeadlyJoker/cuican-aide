import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { workspaceNamespaceFixture } from "./plugin-project-workspace.test-support.ts";
import {
  migrateSqlitePluginProjectMetadataOwners,
  migratePostgresPluginProjectMetadataOwners,
} from "./plugin-project-metadata-owner-schema.ts";
import { pluginProjectMetadataOwnerColumns as columns } from "./plugin-project-metadata-owner-records.ts";

/** Actual original SQL project/Thread/installation stores; persisted ownership is a named fixture, not a new adoption API. */
async function fixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  mismatch:
    | "matching"
    | "actorId"
    | "profileId"
    | "pluginId"
    | "publisherId" = "matching",
) {
  const f = await workspaceNamespaceFixture(t, backend);
  const owner = { ...f.namespaceOwner() };
  if (mismatch !== "matching") owner[mismatch] = `foreign-${mismatch}`;
  const createdAt = f.namespaceRecipe().createdAt;
  const record = {
    schemaVersion: "crewon.plugin-project-metadata-owner.v1",
    owner,
    createdAt,
  };
  const values = [
    owner.tenantId,
    owner.spaceId,
    owner.principalId,
    owner.actorId,
    owner.profileId,
    owner.pluginId,
    owner.publisherId,
    owner.projectId,
    createdAt,
    JSON.stringify(record),
  ];
  if (backend === "sqlite") {
    const db = new DatabaseSync(f.databasePath);
    try {
      db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
      migrateSqlitePluginProjectMetadataOwners(db);
      db.prepare(
        `INSERT INTO plugin_project_metadata_owners(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
      ).run(...values);
      db.exec("COMMIT");
    } finally {
      db.close();
    }
  } else {
    const pool = new Pool({
      connectionString: process.env.CREWON_TEST_POSTGRES_URL,
    });
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await migratePostgresPluginProjectMetadataOwners(
        c,
        f.prefix.slice(1, -2),
      );
      await c.query(
        `INSERT INTO ${f.prefix}plugin_project_metadata_owners(${columns.join(",")}) VALUES(${columns.map((_, i) => `$${i + 1}`).join(",")})`,
        values,
      );
      await c.query("COMMIT");
    } finally {
      c.release();
      await pool.end();
    }
  }
  return f;
}

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: protected project uses the original Thread/binding/receipt transaction and keeps its owned workspace across replay and cold reads`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      await f.parent.migratePluginProjectWorkspaceNamespaces();
      const mount = await f.mounted();
      await mount.write();
      const input = await f.prepare(randomUUID(), "workspace-isolated");
      const result = await f.store.commitBinding(input, {
        authority: f.authority,
      });
      assert.equal(result.disposition, "committed");
      assert.equal(result.binding.workspaceId, "workspace-isolated");
      assert.equal(
        (await f.store.commitBinding(input, { authority: f.authority }))
          .disposition,
        "replayed",
      );
      const thread = await f.second.parent.loadThread({
        tenantId: f.actor.tenantId,
        threadId: input.binding.threadId,
      });
      assert.equal(thread?.workspaceId, "workspace-isolated");
      assert.deepEqual(
        await f.second.parent
          .projectConversationStore()
          .loadBinding({ ...f.owner, threadId: input.binding.threadId }),
        input.binding,
      );
      assert.equal(
        (
          await f.store.loadMutationReceipt({
            ...f.owner,
            receipt: input.receipt,
          })
        )?.binding.threadId,
        input.binding.threadId,
      );
    },
  );

  test(
    `${backend}: another metadata actor, profile, plugin or publisher cannot use the original Conversation writer even without a namespace`,
    options,
    async (t) => {
      for (const field of [
        "actorId",
        "profileId",
        "pluginId",
        "publisherId",
      ] as const) {
        const f = await fixture(t, backend, field);
        const input = await f.prepare();
        await assert.rejects(
          f.store.commitBinding(input, { authority: f.authority }),
          /plugin_project_workspace_metadata_owner_conflict/u,
        );
        assert.equal(
          await f.parent.loadThread({
            tenantId: f.actor.tenantId,
            threadId: input.binding.threadId,
          }),
          null,
        );
        assert.equal(
          await f.store.loadMutationReceipt({
            ...f.owner,
            receipt: input.receipt,
          }),
          null,
        );
      }
    },
  );

  test(
    `${backend}: protected project cannot create a Thread before namespace registration or borrow a null workspace`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      for (const schema of ["absent", "present"] as const) {
        if (schema === "present")
          await f.parent.migratePluginProjectWorkspaceNamespaces();
        for (const workspace of [null, "workspace-ordinary"]) {
          const input = await f.prepare(randomUUID(), workspace);
          await assert.rejects(
            f.store.commitBinding(input, { authority: f.authority }),
            /plugin_project_workspace_scope_conflict/u,
          );
          assert.equal(
            await f.parent.loadThread({
              tenantId: f.actor.tenantId,
              threadId: input.binding.threadId,
            }),
            null,
          );
          assert.equal(
            await f.store.loadMutationReceipt({
              ...f.owner,
              receipt: input.receipt,
            }),
            null,
          );
        }
      }
    },
  );

  test(
    `${backend}: protected project namespace rejects a different workspace without persisting a Thread or receipt`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      await f.parent.migratePluginProjectWorkspaceNamespaces();
      await (await f.mounted()).write();
      const input = await f.prepare(randomUUID(), "workspace-other");
      await assert.rejects(
        f.store.commitBinding(input, { authority: f.authority }),
        /plugin_project_workspace_scope_conflict/u,
      );
      assert.equal(
        await f.parent.loadThread({
          tenantId: f.actor.tenantId,
          threadId: input.binding.threadId,
        }),
        null,
      );
      assert.equal(
        await f.store.loadMutationReceipt({
          ...f.owner,
          receipt: input.receipt,
        }),
        null,
      );
    },
  );
}
