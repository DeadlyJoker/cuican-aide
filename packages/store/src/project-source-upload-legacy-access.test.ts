import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type {
  ProjectSourceUploadCommitAuthority,
  ProjectSourceUploadAction,
  ProjectSourceUploadInitial,
} from "@crewon/application";
import {
  sourceAdoptionFixture,
  prepareOwnedUpload,
  adoptedNovel,
} from "../../../apps/control-api/src/project-foundation-source-upload.test-support.ts";
import {
  uploadActor,
  uploadOwner,
  uploadHash,
} from "../../../apps/control-api/src/project-source-upload.test-support.ts";
import { foundationMetadataFixture } from "./project-foundation-legacy-access.test-support.ts";
import {
  capturePostgresProjectFoundationDownstream,
  captureSqliteProjectFoundationDownstream,
} from "./project-foundation-downstream-guard.ts";
import { assertPostgresSavedSourceUploadLegacyAccess } from "./project-source-upload-legacy-access.ts";

const options = (backend: string) => ({
  skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  timeout: 30000,
});
const bytes = Buffer.from("第一章 雨夜\n两人在雨夜重逢。");
function grant(
  action: ProjectSourceUploadAction,
  uploadId: string | null,
  active = () => true,
): ProjectSourceUploadCommitAuthority {
  return {
    version: "crewon.project-source-upload-commit.v1",
    permission: {
      actor: uploadActor,
      action,
      resource: {
        kind: "projectSourceUpload",
        owner: uploadOwner,
        uploadId,
        projectId: null,
      },
    },
    async assertCurrent() {
      assert.ok(active(), "named-upload-withdrawn");
    },
    assertActive() {
      assert.ok(active(), "named-upload-withdrawn");
    },
  };
}
function denied(value: Promise<unknown>) {
  return assert.rejects(value, /project_source_upload_not_found/u);
}
for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: actual associated source denies upload bytes, prepared factory, saved receipts and ordinary copy without rewriting history`,
    options(backend),
    async (t) => {
      const f = await sourceAdoptionFixture(t, backend),
        uploaded = await prepareOwnedUpload(
          f.first.uploadService,
          bytes,
          "legacy-upload",
        ),
        id = uploaded.reference.uploadId;
      const commandA = adoptedNovel(uploaded.reference, "owned-novel-a"),
        a = await f.first.service.createProject(
          uploadActor,
          commandA,
          f.authority(),
        );
      const commandB = adoptedNovel(uploaded.reference, "ordinary-copy-b"),
        b = await f.first.service.createProject(
          uploadActor,
          commandB,
          f.authority(),
        );
      const proposalCommand = {
        projectId: b.project.projectId,
        expectedFoundationRevision: 1,
        expectedProposalRevision: 0,
        kind: "novel-adaptation" as const,
        text: "保留主线",
        idempotencyKey: "copy-b-proposal",
      };
      const proposal = await f.first.service.saveProposal(
        uploadActor,
        proposalCommand,
        f.authority(),
      );
      assert.equal(proposal.source, null);
      assert.equal(proposal.foundation.source!.revision, 1);
      const metadata = await foundationMetadataFixture(t, f);
      await metadata.migrate();
      assert.ok(
        await f.first.uploadService.getStatus(uploadActor, { uploadId: id }),
      );
      const before = await f.counts(),
        receipts = await f.query(
          "SELECT * FROM $schema.project_foundation_mutation_receipts ORDER BY idempotency_key",
        ),
        associations = await f.query(
          "SELECT * FROM $schema.project_source_upload_associations ORDER BY project_id",
        );
      await metadata.mark(a.project.projectId, uploadActor);
      const scope = { owner: uploadOwner, uploadId: id },
        head = uploaded.state;
      await denied(
        f.first.uploads.load(scope, grant("projectSourceUpload:status", id)),
      );
      await denied(
        f.first.uploads.loadPrepared(
          { ...scope, fileDigest: uploaded.reference.fileDigest },
          grant("projectSourceUpload:adopt", id),
        ),
      );
      await denied(
        f.first.uploads.loadRawBytes(
          {
            ...scope,
            uploadDigest: head.sealed!.uploadDigest,
            claimId: head.claim!.claimId,
          },
          grant("projectSourceUpload:prepare", id),
        ),
      );
      const initialRow = (
        await f.query(
          "SELECT record_json FROM $schema.project_source_uploads WHERE upload_id=$1",
          [id],
        )
      )[0]!;
      const initial = (
        typeof initialRow.record_json === "string"
          ? JSON.parse(initialRow.record_json)
          : initialRow.record_json
      ) as ProjectSourceUploadInitial;
      const receipt = {
        idempotencyKey: "legacy-upload",
        requestDigest: initial.requestDigest,
      };
      await denied(
        f.first.uploads.loadBeginReceipt(
          { actor: uploadActor, receipt },
          grant("projectSourceUpload:begin", null),
        ),
      );
      await denied(
        f.first.uploads.begin(
          {
            actor: uploadActor,
            receipt,
            initial: { ...initial, uploadId: "different-new-upload-id" },
          },
          grant("projectSourceUpload:begin", null),
        ),
      );
      const mutation = {
        actor: uploadActor,
        uploadId: id,
        expectedRevision: head.revision,
        at: head.updatedAt,
      };
      await denied(
        f.first.uploads.cancel(
          mutation,
          grant("projectSourceUpload:cancel", id),
        ),
      );
      await denied(
        f.first.uploads.sealRaw(
          mutation,
          grant("projectSourceUpload:prepare", id),
        ),
      );
      await denied(
        f.first.uploads.claimPreparation(
          {
            ...mutation,
            claim: {
              claimId: "new-claim",
              normalizationParserVersion: "parser-new",
              expiresAt: "2026-10-08T00:00:59.000Z",
            },
          },
          grant("projectSourceUpload:prepare", id),
        ),
      );
      await denied(
        f.first.service.createProject(
          uploadActor,
          adoptedNovel(uploaded.reference, "new-copy-c"),
          f.authority(),
        ),
      );
      await denied(
        f.first.service.createProject(uploadActor, commandB, f.authority()),
      );
      await denied(
        f.first.service.saveProposal(
          uploadActor,
          proposalCommand,
          f.authority(),
        ),
      );
      const sourceScope = {
        owner: uploadOwner,
        projectId: b.project.projectId,
        revision: b.source!.revision,
        digest: b.source!.digest,
      };
      await denied(
        f.first.foundations.loadSource({
          owner: sourceScope.owner,
          projectId: sourceScope.projectId,
          revision: sourceScope.revision,
        }),
      );
      await denied(
        f.first.foundations.readSourcePage({
          ...sourceScope,
          startOffset: 0,
          limit: 10,
        }),
      );
      await denied(
        f.first.foundations.listSourceChapters({
          ...sourceScope,
          afterStartOffset: null,
          limit: 1,
        }),
      );
      if (metadata.database) {
        metadata.database.exec("BEGIN");
        try {
          assert.throws(
            () =>
              captureSqliteProjectFoundationDownstream(metadata.database!, {
                actor: uploadActor,
                projectId: b.project.projectId,
              }),
            /project_source_upload_not_found/u,
          );
        } finally {
          metadata.database.exec("ROLLBACK");
        }
      } else {
        await metadata.execute("BEGIN READ ONLY");
        try {
          await denied(
            capturePostgresProjectFoundationDownstream(
              metadata.client!,
              f.schema,
              { actor: uploadActor, projectId: b.project.projectId },
            ),
          );
        } finally {
          await metadata.execute("ROLLBACK");
        }
      }
      await f.close();
      const cold = await f.open();
      await denied(cold.uploadService.getStatus(uploadActor, { uploadId: id }));
      await denied(
        cold.service.createProject(uploadActor, commandB, f.authority()),
      );
      assert.deepEqual(await f.counts(), before);
      assert.deepEqual(
        await f.query(
          "SELECT * FROM $schema.project_foundation_mutation_receipts ORDER BY idempotency_key",
        ),
        receipts,
      );
      assert.deepEqual(
        await f.query(
          "SELECT * FROM $schema.project_source_upload_associations ORDER BY project_id",
        ),
        associations,
      );
      const independent = await prepareOwnedUpload(
        cold.uploadService,
        bytes,
        "independent-upload",
      );
      assert.notEqual(independent.reference.uploadId, id);
      assert.ok(
        await cold.service.createProject(
          uploadActor,
          adoptedNovel(independent.reference, "independent-novel"),
          f.authority(),
        ),
      );
    },
  );
  test(
    `${backend}: source snapshot captured before owner publication cannot be copied through original borrowed adoption transaction`,
    options(backend),
    async (t) => {
      const f = await sourceAdoptionFixture(t, backend),
        upload = await prepareOwnedUpload(
          f.first.uploadService,
          bytes,
          "captured-upload",
        );
      const a = await f.first.service.createProject(
        uploadActor,
        adoptedNovel(upload.reference, "captured-owner-a"),
        f.authority(),
      );
      const metadata = await foundationMetadataFixture(t, f);
      await metadata.migrate();
      const before = await f.counts();
      f.state.afterPreparedRead = async () => {
        f.state.afterPreparedRead = null;
        await metadata.mark(a.project.projectId, uploadActor);
      };
      await denied(
        f.first.service.createProject(
          uploadActor,
          adoptedNovel(upload.reference, "captured-copy-b"),
          f.authority(),
        ),
      );
      assert.deepEqual(await f.counts(), before);
      assert.equal(f.state.associationWrites, 1);
    },
  );
  test(
    `${backend}: partial metadata owner namespace rejects upload reads, saved begin receipts and fresh writes without schema repair`,
    options(backend),
    async (t) => {
      const f = await sourceAdoptionFixture(t, backend),
        upload = await prepareOwnedUpload(
          f.first.uploadService,
          bytes,
          "partial-upload",
        ),
        metadata = await foundationMetadataFixture(t, f);
      await metadata.execute(
        `CREATE TABLE ${f.prefix}plugin_project_metadata_owners(x TEXT)`,
      );
      await metadata.execute(
        `INSERT INTO ${f.prefix}plugin_project_metadata_owners(x) VALUES('preserve-partial-namespace')`,
      );
      const ownerObjects =
        backend === "sqlite"
          ? "SELECT type,name,tbl_name,sql FROM main.sqlite_schema WHERE name LIKE 'plugin_project_metadata_owner%' ORDER BY name"
          : "SELECT c.relname,c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname LIKE 'plugin_project_metadata_owner%' ORDER BY c.relname";
      const savedOwnerObjects = await f.query(
        ownerObjects,
        backend === "sqlite" ? [] : [f.schema],
      );
      const before = await f.counts();
      // Original explicit DDL does not inspect or repair an unrelated optional owner namespace.
      await f.first.uploads.migrate();
      await f.first.foundations.migrate();
      await assert.rejects(
        f.first.uploadService.getStatus(uploadActor, {
          uploadId: upload.reference.uploadId,
        }),
        /plugin_project_metadata_owner_schema/,
      );
      await assert.rejects(
        f.first.uploadService.begin(uploadActor, {
          fileName: "story.txt",
          format: "txt",
          byteLength: bytes.length,
          fileDigest: upload.reference.fileDigest,
          idempotencyKey: "partial-upload",
        }),
        /plugin_project_metadata_owner_schema/,
      );
      await assert.rejects(
        f.first.uploadService.begin(uploadActor, {
          fileName: "story.txt",
          format: "txt",
          byteLength: bytes.length,
          fileDigest: upload.reference.fileDigest,
          idempotencyKey: "partial-new",
        }),
        /plugin_project_metadata_owner_schema/,
      );
      assert.deepEqual(await f.counts(), before);
      const preservedRows = await f.query(
        "SELECT * FROM $schema.plugin_project_metadata_owners",
      );
      assert.equal(preservedRows.length, 1);
      assert.equal(preservedRows[0]!.x, "preserve-partial-namespace");
      assert.deepEqual(
        await f.query(ownerObjects, backend === "sqlite" ? [] : [f.schema]),
        savedOwnerObjects,
      );
    },
  );
}

test(
  "postgres: saved source takes the real shared upload lock until caller COMMIT and rejects the protected association after publication",
  options("postgres"),
  async (t) => {
    const f = await sourceAdoptionFixture(t, "postgres"),
      upload = await prepareOwnedUpload(
        f.first.uploadService,
        bytes,
        "locking-upload",
      );
    const b = await f.first.service.createProject(
      uploadActor,
      adoptedNovel(upload.reference, "locking-copy-b"),
      f.authority(),
    );
    const otherUpload = await prepareOwnedUpload(
        f.first.uploadService,
        bytes,
        "locking-other-upload",
      ),
      a = await f.first.service.createProject(
        uploadActor,
        adoptedNovel(otherUpload.reference, "locking-owner-a"),
        f.authority(),
      );
    const metadata = await foundationMetadataFixture(t, f);
    await metadata.migrate();
    await metadata.mark(a.project.projectId, uploadActor);
    const client = await f.pool!.connect();
    let writer: Promise<void> | undefined;
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
      const saved = {
        owner: uploadOwner,
        projectId: b.project.projectId,
        sourceRevision: b.source!.revision,
      };
      await assertPostgresSavedSourceUploadLegacyAccess(
        client,
        f.schema,
        saved,
      );
      await metadata.execute("BEGIN");
      let acquired = false;
      writer = metadata
        .client!.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          JSON.stringify([
            "project-source-upload",
            f.schema,
            uploadOwner.tenantId,
            uploadOwner.spaceId,
            uploadOwner.principalId,
            upload.reference.uploadId,
          ]),
        ])
        .then(() => {
          acquired = true;
        });
      for (let i = 0; i < 100; i++) {
        if (
          (
            await client.query(
              "SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory' AND NOT granted",
            )
          ).rowCount
        )
          break;
        await delay(10);
      }
      assert.equal(acquired, false);
      assert.ok(
        (
          await client.query(
            "SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory' AND NOT granted",
          )
        ).rowCount,
      );
      await client.query("COMMIT");
      await writer;
      assert.equal(acquired, true);
      // Raw association is a negative concurrency fixture, never an approved Host metadata write.
      const row = (
        await f.query(
          "SELECT * FROM $schema.project_source_upload_associations WHERE project_id=$1",
          [a.project.projectId],
        )
      )[0]!;
      const association =
        typeof row.record_json === "string"
          ? JSON.parse(row.record_json)
          : row.record_json;
      await metadata.execute(
        `INSERT INTO ${f.prefix}project_source_upload_associations(tenant_id,space_id,owner_principal_id,upload_id,project_id,source_revision,source_digest,record_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          uploadOwner.tenantId,
          uploadOwner.spaceId,
          uploadOwner.principalId,
          upload.reference.uploadId,
          a.project.projectId,
          1,
          a.source!.digest,
          JSON.stringify({
            ...association,
            pointer: upload.state.prepared!.pointer,
          }),
        ],
      );
      await metadata.execute("COMMIT");
      await client.query("BEGIN READ ONLY");
      await denied(
        assertPostgresSavedSourceUploadLegacyAccess(client, f.schema, saved),
      );
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK");
      await writer;
      await metadata.execute("ROLLBACK");
      client.release();
    }
  },
);

test(
  "postgres: original upload reader overrides a real default RR session and sees first owner migration after its shared lock wait",
  options("postgres"),
  async (t) => {
    const f = await sourceAdoptionFixture(t, "postgres"),
      upload = await prepareOwnedUpload(
        f.first.uploadService,
        bytes,
        "migration-upload",
      ),
      a = await f.first.service.createProject(
        uploadActor,
        adoptedNovel(upload.reference, "migration-owner-a"),
        f.authority(),
      );
    const metadata = await foundationMetadataFixture(t, f);
    await f.pool!.query(
      "SET default_transaction_isolation TO 'repeatable read'",
    );
    assert.equal(
      (await f.pool!.query("SHOW default_transaction_isolation")).rows[0]!
        .default_transaction_isolation,
      "repeatable read",
    );
    await metadata.begin();
    await metadata.migrateDirect();
    await metadata.mark(a.project.projectId, uploadActor);
    const pending = f.first.uploads.load(
      { owner: uploadOwner, uploadId: upload.reference.uploadId },
      grant("projectSourceUpload:status", upload.reference.uploadId),
    );
    const rejected = denied(pending);
    try {
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        if (await metadata.hasBlockedReader()) {
          waiting = true;
          break;
        }
        await delay(10);
      }
      assert.equal(
        waiting,
        true,
        "actual migration transaction holds the reader's schema lock",
      );
      await metadata.execute("COMMIT");
      await rejected;
    } finally {
      await metadata.execute("ROLLBACK");
      await rejected;
    }
    assert.equal(
      (await f.pool!.query("SHOW default_transaction_isolation")).rows[0]!
        .default_transaction_isolation,
      "repeatable read",
    );
  },
);

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: withdrawal in the new final association SQL rolls back the original upload payload and head`,
    options(backend),
    async (t) => {
      const f = await sourceAdoptionFixture(t, backend),
        input = {
          fileName: "story.txt",
          format: "txt" as const,
          byteLength: bytes.length,
          fileDigest: uploadHash(bytes),
          idempotencyKey: "final-upload-fence",
        };
      const started = await f.first.uploadService.begin(uploadActor, input),
        id = started.state.initial.uploadId,
        metadata = await foundationMetadataFixture(t, f);
      await metadata.migrate();
      const before = await f.query(
        "SELECT * FROM $schema.project_source_upload_heads",
      );
      let guards = 0,
        withdrawn = false,
        wrote = false;
      f.state.afterSql = (sql) => {
        if (
          sql.startsWith("INSERT INTO") &&
          sql.includes("project_source_upload_part_payloads")
        )
          wrote = true;
        if (
          sql.startsWith("SELECT 1 FROM") &&
          sql.includes("project_source_upload_associations a")
        ) {
          guards++;
          if (wrote && !withdrawn) {
            f.state.activeUpload = false;
            withdrawn = true;
          }
        }
      };
      await assert.rejects(
        f.first.uploadService.writePart(uploadActor, {
          uploadId: id,
          expectedRevision: started.state.revision,
          index: 0,
          byteOffset: 0,
          rawDigest: input.fileDigest,
          bytes,
        }),
        /named-upload-withdrawn/u,
      );
      f.state.afterSql = null;
      assert.equal(wrote, true);
      assert.equal(withdrawn, true);
      assert.ok(guards >= 2);
      assert.deepEqual(
        await f.query("SELECT * FROM $schema.project_source_upload_heads"),
        before,
      );
      assert.deepEqual(
        await f.query("SELECT * FROM $schema.project_source_upload_parts"),
        [],
      );
      assert.deepEqual(
        await f.query(
          "SELECT * FROM $schema.project_source_upload_part_payloads",
        ),
        [],
      );
      f.state.activeUpload = true;
      assert.equal(
        (await f.first.uploadService.getStatus(uploadActor, { uploadId: id }))
          .phase,
        "receiving",
      );
    },
  );
}
