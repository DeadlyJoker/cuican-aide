import assert from "node:assert/strict";
import { test } from "node:test";
import {
  actor,
  creationRecipe,
  owner,
} from "./creative-project-store.test-support.ts";
import {
  uploadSchemaFixture,
  uploadSchemaGrant,
  uploadSchemaHash,
  uploadSchemaJournal,
} from "./project-source-upload-schema.test-support.ts";

const incomplete = /project_source_upload_schema_incomplete/u;
const unavailable = /project_source_upload_schema_unavailable/u;
const unsupported = /project_source_upload_schema_version_unsupported/u;
const immutable =
  /project_source_upload_(?:history|identity|payload)_immutable/u;

for (const backend of ["sqlite", "postgres"] as const) {
  const skip =
    backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL
      ? "isolated real PostgreSQL required"
      : false;
  test(
    backend +
      ": upload construction and absent reads perform no DDL or implicit realm initialization",
    { skip, timeout: 30_000 },
    async (t) => {
      const f = await uploadSchemaFixture(t, backend);
      const before = await f.catalog();
      assert.equal(await f.assertSchema(), false);
      assert.throws(() => f.first.uploads.storageRealmId, unavailable);
      await assert.rejects(
        f.first.uploads.load(
          { owner: owner(), uploadId: "unconfigured-upload" },
          uploadSchemaGrant(
            "projectSourceUpload:status",
            "unconfigured-upload",
          ),
        ),
        unavailable,
      );
      await assert.rejects(
        f.first.uploads.loadBeginReceipt(
          {
            actor,
            receipt: {
              idempotencyKey: "unconfigured",
              requestDigest: uploadSchemaHash("unconfigured"),
            },
          },
          uploadSchemaGrant("projectSourceUpload:begin", null),
        ),
        unavailable,
      );
      assert.equal(await f.assertSchema(), false);
      assert.deepEqual(await f.catalog(), before);
      await f.close();
      const reopened = await f.open();
      assert.throws(() => reopened.uploads.storageRealmId, unavailable);
      assert.deepEqual(await f.catalog(), before);
    },
  );
  test(
    backend +
      ": explicit upload migration requires the actual original parent and rolls back all new DDL when absent",
    { skip, timeout: 30_000 },
    async (t) => {
      const f = await uploadSchemaFixture(t, backend, { migrateParent: false });
      const before = await f.catalog();
      assert.equal(await f.assertSchema(), false);
      await assert.rejects(f.first.uploads.migrate(), /creative_projects/u);
      assert.equal(await f.assertSchema(), false);
      assert.deepEqual(await f.catalog(), before);
      assert.throws(() => f.first.uploads.storageRealmId, unavailable);
      await f.first.projects.migrate();
      await f.first.uploads.migrate();
      assert.equal(await f.assertSchema(), f.first.uploads.storageRealmId);
    },
  );
  test(
    backend +
      ": upload migration preserves real v0 project records and schema; persisted realm survives repeat migration and physical reopen",
    { skip, timeout: 30_000 },
    async (t) => {
      const f = await uploadSchemaFixture(t, backend);
      const created = await f.first.projects.commitProjectCreation(
        creationRecipe("legacy-before-upload"),
      );
      const oldCatalog = await f.catalog(true);
      const oldRecords = await f.legacyRecords();
      await f.first.uploads.migrate();
      const realm = f.first.uploads.storageRealmId;
      assert.match(realm, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
      assert.equal(
        await f.first.uploads.load(
          { owner: owner(), uploadId: "owned-record-absent" },
          uploadSchemaGrant(
            "projectSourceUpload:status",
            "owned-record-absent",
          ),
        ),
        null,
        "only an observed configured namespace can return absent record",
      );
      const written = await uploadSchemaJournal(f.first.uploads);
      const installed = await f.catalog();
      const ledger = await f.ledgerRecords();
      await f.first.uploads.migrate();
      await f.first.uploads.migrate();
      assert.equal(f.first.uploads.storageRealmId, realm);
      assert.deepEqual(await f.catalog(), installed);
      assert.deepEqual(await f.ledgerRecords(), ledger);
      assert.deepEqual(await f.catalog(true), oldCatalog);
      assert.deepEqual(await f.legacyRecords(), oldRecords);
      await f.close();
      const reopened = await f.open();
      assert.throws(() => reopened.uploads.storageRealmId, unavailable);
      assert.deepEqual(
        await reopened.uploads.load(
          { owner: owner(), uploadId: written.state.initial.uploadId },
          uploadSchemaGrant(
            "projectSourceUpload:status",
            written.state.initial.uploadId,
          ),
        ),
        written.state,
      );
      assert.equal(reopened.uploads.storageRealmId, realm);
      await reopened.uploads.migrate();
      assert.equal(await f.assertSchema(), realm);
      assert.deepEqual(await f.catalog(), installed);
      assert.deepEqual(await f.catalog(true), oldCatalog);
      assert.deepEqual(await f.legacyRecords(), oldRecords);
      assert.deepEqual(
        await reopened.projects.loadProject({
          owner: owner(),
          projectId: created.project.projectId,
        }),
        created.project,
      );
    },
  );
  test(
    backend +
      ": partial, view and missing-column upload namespaces fail closed without silent schema repair",
    { skip, timeout: 30_000 },
    async (t) => {
      const mutations = [
        "DROP TABLE $schema.project_source_upload_prepared_chapters",
        "ALTER TABLE $schema.project_source_upload_parts DROP COLUMN raw_digest",
        "ALTER TABLE $schema.project_source_upload_events RENAME TO actual_upload_events;" +
          "CREATE VIEW $schema.project_source_upload_events AS SELECT * FROM $schema.actual_upload_events",
      ];
      for (const mutation of mutations) {
        const f = await uploadSchemaFixture(t, backend);
        await f.first.uploads.migrate();
        await f.execute(mutation);
        const damaged = await f.catalog();
        await assert.rejects(f.assertSchema(), incomplete);
        await assert.rejects(f.first.uploads.migrate(), incomplete);
        assert.deepEqual(await f.catalog(), damaged);
      }
    },
  );
  test(
    backend +
      ": unknown schema versions and invalid realm markers are rejected without rewriting the registry or old project namespace",
    { skip, timeout: 30_000 },
    async (t) => {
      for (const change of [
        { field: "version" as const, value: 2 },
        { field: "storage_realm_id" as const, value: "" },
      ]) {
        const f = await uploadSchemaFixture(t, backend);
        const oldCatalog = await f.catalog(true);
        const oldRecords = await f.legacyRecords();
        await f.first.uploads.migrate();
        await f.replaceMarker(change.field, change.value);
        const damaged = await f.catalog();
        const marker = await f.query(
          "SELECT * FROM $schema.project_source_upload_schema_version",
        );
        await assert.rejects(f.assertSchema(), unsupported);
        await assert.rejects(f.first.uploads.migrate(), unsupported);
        assert.deepEqual(
          await f.query(
            "SELECT * FROM $schema.project_source_upload_schema_version",
          ),
          marker,
        );
        assert.deepEqual(await f.catalog(), damaged);
        assert.deepEqual(await f.catalog(true), oldCatalog);
        assert.deepEqual(await f.legacyRecords(), oldRecords);
      }
    },
  );
  test(
    backend +
      ": missing, misbound or disabled immutable SQL fences are rejected instead of recreated",
    { skip, timeout: 30_000 },
    async (t) => {
      const partTrigger = "project_source_upload_parts_no_update";
      const mutations =
        backend === "sqlite"
          ? [
              "DROP TRIGGER " + partTrigger,
              "DROP TRIGGER " +
                partTrigger +
                ";" +
                "CREATE TRIGGER " +
                partTrigger +
                " BEFORE UPDATE ON project_source_upload_heads BEGIN SELECT RAISE(ABORT,'wrong_table'); END",
              "DROP TRIGGER project_source_upload_part_payloads_no_update",
            ]
          : [
              "DROP TRIGGER " +
                partTrigger +
                " ON $schema.project_source_upload_parts",
              "ALTER TABLE $schema.project_source_upload_parts DISABLE TRIGGER " +
                partTrigger,
              "ALTER TABLE $schema.project_source_upload_part_payloads ENABLE REPLICA TRIGGER project_source_upload_part_payloads_no_update",
            ];
      for (const mutation of mutations) {
        const f = await uploadSchemaFixture(t, backend);
        await f.first.uploads.migrate();
        await f.execute(mutation);
        const damaged = await f.catalog();
        await assert.rejects(f.assertSchema(), incomplete);
        await assert.rejects(f.first.uploads.migrate(), incomplete);
        assert.deepEqual(await f.catalog(), damaged);
      }
    },
  );
  test(
    backend +
      ": actual immutable payloads, descriptors, upload identity, realm and head owner remain protected by SQL",
    { skip, timeout: 30_000 },
    async (t) => {
      const f = await uploadSchemaFixture(t, backend);
      await f.first.uploads.migrate();
      const written = await uploadSchemaJournal(f.first.uploads);
      const before = await f.ledgerRecords();
      const digest = uploadSchemaHash("changed");
      for (const statement of [
        {
          sql: "UPDATE $schema.project_source_uploads SET request_digest=$1",
          parameters: [digest],
        },
        { sql: "DELETE FROM $schema.project_source_uploads", parameters: [] },
        {
          sql: "UPDATE $schema.project_source_upload_parts SET raw_digest=$1",
          parameters: [digest],
        },
        {
          sql: "DELETE FROM $schema.project_source_upload_parts",
          parameters: [],
        },
        {
          sql: "UPDATE $schema.project_source_upload_part_payloads SET payload=$1",
          parameters: [new Uint8Array([1, 2, 3])],
        },
        {
          sql: "UPDATE $schema.project_source_upload_schema_version SET storage_realm_id=$1",
          parameters: ["different-realm"],
        },
        {
          sql: "DELETE FROM $schema.project_source_upload_schema_version",
          parameters: [],
        },
        {
          sql: "DELETE FROM $schema.project_source_upload_heads",
          parameters: [],
        },
        ...["tenant_id", "space_id", "owner_principal_id", "upload_id"].map(
          (column) => ({
            sql:
              "UPDATE $schema.project_source_upload_heads SET " +
              column +
              "=$1",
            parameters: ["foreign"],
          }),
        ),
      ]) {
        await assert.rejects(
          f.execute(statement.sql, statement.parameters),
          immutable,
        );
      }
      await assert.rejects(
        f.execute(
          "INSERT INTO $schema.project_source_upload_parts" +
            "(tenant_id,space_id,owner_principal_id,upload_id,part_index,byte_offset,byte_length,raw_digest,record_json)" +
            " SELECT tenant_id,space_id,$1,upload_id,1,65536,1,raw_digest,record_json FROM $schema.project_source_upload_parts",
          ["foreign"],
        ),
        /FOREIGN KEY|foreign key/iu,
      );
      await f.execute(
        "UPDATE $schema.project_source_upload_heads SET revision=revision,phase=phase",
      );
      assert.deepEqual(await f.ledgerRecords(), before);
      assert.deepEqual(
        await f.first.uploads.load(
          { owner: owner(), uploadId: written.state.initial.uploadId },
          uploadSchemaGrant(
            "projectSourceUpload:status",
            written.state.initial.uploadId,
          ),
        ),
        written.state,
      );
      assert.equal(await f.assertSchema(), f.first.uploads.storageRealmId);
    },
  );
}
