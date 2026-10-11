import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  PLUGIN_PROJECT_WORKSPACE_OWNER_FIELDS,
  parsePluginProjectWorkspaceOwner,
} from "@crewon/domain";
import {
  decodePluginProjectMetadataOwnerRecord,
  parsePluginProjectMetadataOwnerRecord,
} from "./plugin-project-metadata-owner-records.ts";
import {
  metadataOwnerFixtureRecord,
  metadataOwnerFixtureScope,
  metadataOwnerSchemaFixture,
} from "./plugin-project-metadata-owner-schema.test-support.ts";
import { owner, projectTables } from "./creative-project-store.test-support.ts";

const marker = "plugin_project_metadata_owner_schema_version";
const table = "plugin_project_metadata_owners";

for (const reserved of [table, marker]) {
  test(`sqlite: a reserved ${reserved} index on an unrelated table is invalid partial state`, async (t) => {
    const f = await metadataOwnerSchemaFixture(t, "sqlite");
    await f.execute(
      `CREATE TABLE unrelated(x INTEGER); CREATE INDEX ${reserved} ON unrelated(x)`,
    );
    const before = await f.catalog();
    await assert.rejects(f.hasSchema(), /schema_invalid/u);
    await assert.rejects(f.migrate(), /schema_invalid/u);
    assert.deepEqual(await f.catalog(), before);
  });
}

for (const statement of ["REPLACE", "INSERT OR REPLACE"] as const) {
  for (const target of [table, marker]) {
    test(`sqlite: ${statement} cannot replace immutable ${target} with recursive triggers disabled`, async (t) => {
      const f = await metadataOwnerSchemaFixture(t, "sqlite");
      assert.equal(
        (await f.query("PRAGMA recursive_triggers"))[0]?.recursive_triggers,
        0,
      );
      await f.migrate();
      await f.createOriginalProject("replace-project");
      await f.rawFixtureInsert("replace-project");
      const before = await f.query(`SELECT * FROM $schema.${target}`);
      const schema = await f.catalog();
      const replacement =
        target === table
          ? `SELECT tenant_id,space_id,principal_id,actor_id,'replacement-profile',plugin_id,publisher_id,project_id,created_at,json_set(record_json,'$.owner.profileId','replacement-profile') FROM $schema.${table}`
          : `SELECT id,version+1,migration_digest,schema_digest FROM $schema.${marker}`;
      await assert.rejects(
        f.execute(`${statement} INTO $schema.${target} ${replacement}`),
        /owner_immutable/u,
      );
      assert.deepEqual(
        await f.query(`SELECT * FROM $schema.${target}`),
        before,
      );
      assert.deepEqual(await f.catalog(), schema);
      assert.equal(await f.hasSchema(), true);
    });
  }
}

for (const target of [table, marker]) {
  test(`sqlite: missing ${target} duplicate-insert fence is invalid and never repaired`, async (t) => {
    const f = await metadataOwnerSchemaFixture(t, "sqlite");
    await f.migrate();
    await f.execute(`DROP TRIGGER ${target}_no_replace`);
    const before = await f.catalog();
    await assert.rejects(f.hasSchema(), /schema_invalid/u);
    await assert.rejects(f.migrate(), /schema_invalid/u);
    assert.deepEqual(await f.catalog(), before);
  });
}

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  const fixture = (context: Parameters<typeof metadataOwnerSchemaFixture>[0]) =>
    metadataOwnerSchemaFixture(context, backend);

  test(
    `${backend}: absent inspection is read-only and missing original parent rejects migration`,
    options,
    async (t) => {
      const f = await metadataOwnerSchemaFixture(t, backend, {
        migrateParent: false,
      });
      const before = await f.catalog();
      assert.equal(await f.hasSchema(), false);
      assert.deepEqual(await f.catalog(), before);
      await assert.rejects(
        f.migrate(),
        /plugin_project_metadata_owner_schema_invalid/u,
      );
      assert.deepEqual(await f.catalog(), before);
    },
  );

  test(
    `${backend}: independent migration requires the caller's actual transaction`,
    options,
    async (t) => {
      const f = await fixture(t);
      const before = await f.catalog();
      await assert.rejects(f.migrateDirect(), /transaction_required/u);
      assert.deepEqual(await f.catalog(), before);
      assert.equal(await f.hasSchema(), false);
    },
  );

  test(
    `${backend}: caller rollback discards the complete sidecar migration`,
    options,
    async (t) => {
      const f = await fixture(t);
      const before = await f.catalog();
      await assert.rejects(
        f.transaction(async () => {
          await f.migrateDirect();
          assert.equal(await f.hasSchema(), true);
          throw new Error("fixture_rollback");
        }),
        /fixture_rollback/u,
      );
      assert.deepEqual(await f.catalog(), before);
      assert.equal(await f.hasSchema(), false);
    },
  );

  test(
    `${backend}: original v0 metadata, brief, receipt and reader stay byte-identical; migration never adopts legacy`,
    options,
    async (t) => {
      const f = await fixture(t);
      const created = await f.createOriginalProject("legacy-project");
      const snapshot = async () => {
        const rows = [];
        // One original PoolClient owns these reads; do not queue concurrent SQL on it.
        for (const name of projectTables)
          rows.push(await f.query(`SELECT * FROM $schema.${name}`));
        return rows;
      };
      const before = await snapshot();
      const version = await f.query(
        "SELECT * FROM $schema.creative_project_schema_version",
      );
      await f.migrate();
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual(
        await f.query("SELECT * FROM $schema.creative_project_schema_version"),
        version,
      );
      assert.equal(
        Number(
          (await f.query(`SELECT COUNT(*) AS n FROM $schema.${table}`))[0]?.n,
        ),
        0,
      );
      assert.deepEqual(
        await f.projects.loadProject({
          owner: owner(),
          projectId: created.project.projectId,
        }),
        created.project,
      );
      await f.createOriginalProject("still-ordinary-v0");
      assert.equal(
        Number(
          (await f.query(`SELECT COUNT(*) AS n FROM $schema.${table}`))[0]?.n,
        ),
        0,
      );
    },
  );

  test(
    `${backend}: repeat migration preserves the immutable fixture ownership and all schema objects`,
    options,
    async (t) => {
      const f = await fixture(t);
      await f.migrate();
      await f.createOriginalProject("constraint-project");
      await f.rawFixtureInsert("constraint-project");
      const rows = await f.query(`SELECT * FROM $schema.${table}`);
      const before = await f.catalog();
      await f.migrate();
      assert.equal(await f.hasSchema(), true);
      assert.deepEqual(await f.query(`SELECT * FROM $schema.${table}`), rows);
      assert.deepEqual(await f.catalog(), before);
    },
  );

  for (const shape of ["marker-only", "table-only", "view-only"] as const) {
    test(
      `${backend}: ${shape} is invalid partial state, never absence or automatic repair`,
      options,
      async (t) => {
        const f = await fixture(t);
        await f.execute(
          shape === "marker-only"
            ? `CREATE TABLE $schema.${marker}(id INTEGER)`
            : shape === "table-only"
              ? `CREATE TABLE $schema.${table}(id INTEGER)`
              : `CREATE VIEW $schema.${table} AS SELECT 1 AS id`,
        );
        const before = await f.catalog();
        await assert.rejects(f.hasSchema(), /schema_invalid/u);
        await assert.rejects(f.migrate(), /schema_invalid/u);
        assert.deepEqual(await f.catalog(), before);
      },
    );
  }

  test(
    `${backend}: removal of an immutable fence fails inspection and is never repaired`,
    options,
    async (t) => {
      const f = await fixture(t);
      await f.migrate();
      await f.execute(
        `DROP TRIGGER ${table}_immutable${backend === "postgres" ? ` ON $schema.${table}` : ""}`,
      );
      const before = await f.catalog();
      await assert.rejects(f.hasSchema(), /schema_invalid/u);
      await assert.rejects(f.migrate(), /schema_invalid/u);
      assert.deepEqual(await f.catalog(), before);
    },
  );

  test(
    `${backend}: unknown version remains intact and is never rewritten`,
    options,
    async (t) => {
      const f = await fixture(t);
      await f.migrate();
      await f.execute(
        `DROP TRIGGER ${marker}_immutable${backend === "postgres" ? ` ON $schema.${marker}` : ""}`,
      );
      await f.execute(`UPDATE $schema.${marker} SET version=2`);
      const before = await f.catalog();
      await assert.rejects(f.hasSchema(), /schema_invalid/u);
      await assert.rejects(f.migrate(), /schema_invalid/u);
      assert.deepEqual(await f.catalog(), before);
      assert.equal(
        (await f.query(`SELECT version FROM $schema.${marker}`))[0]?.version,
        2,
      );
    },
  );

  test(
    `${backend}: stored principal is enforced by the original project's composite FK`,
    options,
    async (t) => {
      const f = await fixture(t);
      await f.migrate();
      await f.createOriginalProject("principal-project");
      await assert.rejects(
        f.rawFixtureInsert("principal-project", {
          owner: { principalId: "foreign-principal" },
        }),
        /foreign key/iu,
      );
      await assert.rejects(
        f.rawFixtureInsert("parent-missing"),
        /foreign key/iu,
      );
      assert.equal(
        Number(
          (await f.query(`SELECT COUNT(*) AS n FROM $schema.${table}`))[0]?.n,
        ),
        0,
      );
    },
  );

  test(
    `${backend}: one original project key cannot be occupied by another actor, profile, plugin or publisher`,
    options,
    async (t) => {
      const f = await fixture(t);
      await f.migrate();
      await f.createOriginalProject("occupied-project");
      await f.rawFixtureInsert("occupied-project");
      for (const field of [
        "actorId",
        "profileId",
        "pluginId",
        "publisherId",
      ] as const)
        await assert.rejects(
          f.rawFixtureInsert("occupied-project", {
            owner: { [field]: `foreign-${field}` },
          }),
          backend === "sqlite" ? /owner_immutable/u : /unique/iu,
        );
      assert.equal(
        Number(
          (await f.query(`SELECT COUNT(*) AS n FROM $schema.${table}`))[0]?.n,
        ),
        1,
      );
    },
  );

  test(
    `${backend}: all eight JSON owner fields must exactly match the SQL columns`,
    options,
    async (t) => {
      const f = await fixture(t);
      await f.migrate();
      await f.createOriginalProject("json-project");
      const original = metadataOwnerFixtureRecord("json-project");
      for (const field of PLUGIN_PROJECT_WORKSPACE_OWNER_FIELDS)
        await assert.rejects(
          f.rawFixtureInsert("json-project", {
            record: {
              ...original,
              owner: { ...original.owner, [field]: `foreign-${field}` },
            },
          }),
          /check/iu,
        );
      for (const record of [
        { owner: original.owner, createdAt: original.createdAt },
        { ...original, schemaVersion: "unknown" },
        { ...original, owner: { ...original.owner, principalId: null } },
        { ...original, owner: { ...original.owner, untrusted: "extra" } },
        { ...original, untrusted: "extra" },
        { ...original, createdAt: null },
      ])
        await assert.rejects(
          f.rawFixtureInsert("json-project", { record }),
          /check/iu,
        );
      await f.rawFixtureInsert("json-project");
    },
  );

  test(
    `${backend}: metadata owner and its schema history cannot be updated or deleted`,
    options,
    async (t) => {
      const f = await fixture(t);
      await f.migrate();
      await f.createOriginalProject("immutable-project");
      await f.rawFixtureInsert("immutable-project");
      const before = await f.query(`SELECT * FROM $schema.${table}`);
      for (const statement of [
        `UPDATE $schema.${table} SET plugin_id=plugin_id`,
        `UPDATE $schema.${table} SET created_at=created_at`,
        `DELETE FROM $schema.${table}`,
        `UPDATE $schema.${marker} SET version=version`,
        `DELETE FROM $schema.${marker}`,
      ])
        await assert.rejects(f.execute(statement), /owner_immutable/u);
      assert.deepEqual(await f.query(`SELECT * FROM $schema.${table}`), before);
      assert.equal(await f.hasSchema(), true);
    },
  );

  test(
    `${backend}: caller rollback removes sidecar writes without changing original metadata`,
    options,
    async (t) => {
      const f = await fixture(t);
      await f.migrate();
      await f.createOriginalProject("rollback-project");
      const before = await f.query("SELECT * FROM $schema.creative_projects");
      await assert.rejects(
        f.transaction(async () => {
          await f.rawFixtureInsert("rollback-project");
          throw new Error("fixture_rollback");
        }),
        /fixture_rollback/u,
      );
      assert.equal(
        Number(
          (await f.query(`SELECT COUNT(*) AS n FROM $schema.${table}`))[0]?.n,
        ),
        0,
      );
      assert.deepEqual(
        await f.query("SELECT * FROM $schema.creative_projects"),
        before,
      );
    },
  );

  test(
    `${backend}: decoder verifies full owner and the independently joined project principal`,
    options,
    async (t) => {
      const f = await fixture(t);
      await f.migrate();
      await f.createOriginalProject("decode-project");
      await f.rawFixtureInsert("decode-project");
      const row = (await f.query(`SELECT * FROM $schema.${table}`))[0]!;
      const expectedOwner = metadataOwnerFixtureScope("decode-project");
      const input = {
        expectedOwner,
        storedProjectPrincipalId: expectedOwner.principalId,
      };
      assert.deepEqual(
        decodePluginProjectMetadataOwnerRecord(row, input),
        metadataOwnerFixtureRecord("decode-project"),
      );
      for (const field of PLUGIN_PROJECT_WORKSPACE_OWNER_FIELDS)
        assert.throws(
          () =>
            decodePluginProjectMetadataOwnerRecord(row, {
              ...input,
              expectedOwner: parsePluginProjectWorkspaceOwner({
                ...expectedOwner,
                [field]: `foreign-${field.toLowerCase()}`,
              }),
            }),
          /record_invalid/u,
        );
      assert.throws(
        () =>
          decodePluginProjectMetadataOwnerRecord(row, {
            ...input,
            storedProjectPrincipalId: "foreign-principal",
          }),
        /record_invalid/u,
      );
      assert.throws(
        () =>
          decodePluginProjectMetadataOwnerRecord(
            { ...row, profile_id: "corrupt-profile" },
            input,
          ),
        /record_invalid/u,
      );
    },
  );
}

test("sqlite: disabling FK enforcement or shadowing the sidecar never passes inspection", async (t) => {
  const f = await metadataOwnerSchemaFixture(t, "sqlite");
  await f.migrate();
  await f.execute("PRAGMA foreign_keys=OFF");
  await assert.rejects(f.hasSchema(), /schema_invalid/u);
  await f.execute("PRAGMA foreign_keys=ON");
  await f.execute(`CREATE TEMP VIEW ${table} AS SELECT 1 AS id`);
  await assert.rejects(f.hasSchema(), /schema_invalid/u);
});

test("internal metadata owner modules provide no project creation, adoption, upsert or package API", async () => {
  const schemaModule = await import(
    "./plugin-project-metadata-owner-schema.ts"
  );
  const recordModule = await import(
    "./plugin-project-metadata-owner-records.ts"
  );
  assert.deepEqual(
    Object.keys(schemaModule).sort(),
    [
      "PLUGIN_PROJECT_METADATA_OWNER_TABLE",
      "hasPostgresPluginProjectMetadataOwnerSchema",
      "hasSqlitePluginProjectMetadataOwnerSchema",
      "migratePostgresPluginProjectMetadataOwners",
      "migrateSqlitePluginProjectMetadataOwners",
    ].sort(),
  );
  assert.deepEqual(
    Object.keys(recordModule).sort(),
    [
      "decodePluginProjectMetadataOwnerRecord",
      "parsePluginProjectMetadataOwnerRecord",
      "pluginProjectMetadataOwnerColumns",
    ].sort(),
  );
  const entry = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  assert.equal(entry.includes("plugin-project-metadata-owner"), false);
});

test("data parsing does not accept a getter, extra field or malformed stable ownership", () => {
  const record = metadataOwnerFixtureRecord("record-project");
  let invoked = false;
  assert.throws(() =>
    parsePluginProjectMetadataOwnerRecord({
      ...record,
      get owner() {
        invoked = true;
        return record.owner;
      },
    }),
  );
  assert.equal(invoked, false);
  assert.throws(() =>
    parsePluginProjectMetadataOwnerRecord({
      ...record,
      pluginId: "outside-owner",
    }),
  );
  assert.throws(() =>
    parsePluginProjectMetadataOwnerRecord({
      ...record,
      owner: { ...record.owner, selectionRevision: 2 },
    }),
  );
});
