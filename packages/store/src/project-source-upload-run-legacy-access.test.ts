import assert from "node:assert/strict";
import test from "node:test";
import {
  foundationRunIssuedFixture,
  foundationRunTestOptions,
} from "./project-foundation-run.test-support.ts";
import { foundationMetadataFixture } from "./project-foundation-legacy-access.test-support.ts";
import { creationRecipe } from "./creative-project-store.test-support.ts";
import {
  captureSqliteFoundationRunFacts,
  capturePostgresFoundationRunFacts,
} from "./project-foundation-run-facts.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: genuine original Run facts and required digest reject a protected associated source rather than permitting an absent-source fallback`,
    foundationRunTestOptions(backend),
    async (t) => {
      const f = await foundationRunIssuedFixture(t, backend),
        stage = await f.store.loadStageAdmission(f.locator);
      assert.ok(stage);
      const other = await f.parent
        .creativeProjectStore()
        .commitProjectCreation(
          creationRecipe(
            "other-upload-protected-project",
            "other-upload-protected-project",
            f.actor,
          ),
        );
      const uploads = f.parent.projectSourceUploadStore();
      await uploads.migrate();
      const schema = backend === "postgres" ? f.prefix.slice(1, -2) : "main";
      const metadata = await foundationMetadataFixture(t, {
        backend,
        path: f.databasePath,
        schema,
        prefix: f.prefix,
      });
      await metadata.migrate();
      // These immutable SQL rows are only negative association fixtures. The Run/Tool admission above
      // came from the genuine original Turn and is not issued, upgraded or replayed by this fixture.
      const owner = {
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        principalId: f.actor.principalId,
      };
      const source = await f.parent.projectFoundationStore().loadSource({
        owner,
        projectId: f.reference.projectId,
        revision: f.foundation.foundation.source!.revision,
      });
      assert.ok(source);
      const uploadId = "negative-associated-source",
        digest = f.admission.contentDigest;
      const initial = {
        schemaVersion: "crewon.project-source-upload.v1",
        storageRealmId: uploads.storageRealmId,
        uploadId,
        owner,
        fileName: source.fileName,
        format: source.format,
        byteLength: source.byteLength,
        fileDigest: source.fileDigest,
        partBytes: 65536,
        partCount: Math.ceil(source.byteLength / 65536),
        requestDigest: digest,
        createdByActorId: f.actor.actorId,
        createdAt: source.createdAt,
      };
      await metadata.execute(
        `INSERT INTO ${f.prefix}project_source_uploads(tenant_id,space_id,owner_principal_id,upload_id,idempotency_key,request_digest,file_digest,byte_length,record_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          owner.tenantId,
          owner.spaceId,
          owner.principalId,
          uploadId,
          uploadId,
          digest,
          source.fileDigest,
          source.byteLength,
          JSON.stringify(initial),
        ],
      );
      for (const projectId of [source.projectId, other.project.projectId]) {
        await metadata.execute(
          `INSERT INTO ${f.prefix}project_source_upload_associations(tenant_id,space_id,owner_principal_id,upload_id,project_id,source_revision,source_digest,record_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            owner.tenantId,
            owner.spaceId,
            owner.principalId,
            uploadId,
            projectId,
            source.revision,
            source.digest,
            JSON.stringify({
              fixture: "negative-associated-source",
              projectId,
            }),
          ],
        );
      }
      assert.deepEqual(
        await f.reader.loadFoundationRunAdmission(f.locator),
        f.admission,
      );
      await metadata.mark(other.project.projectId, f.actor);
      await assert.rejects(
        f.reader.loadFoundationRunAdmission(f.locator),
        /project_source_upload_not_found/u,
      );
      await assert.rejects(
        f.reader.readRequiredFoundationDigest(f.locator),
        /project_source_upload_not_found/u,
      );
      const cold = await f.open();
      await assert.rejects(
        cold.parent
          .projectFoundationRunStore()
          .loadFoundationRunAdmission(f.locator),
        /project_source_upload_not_found/u,
      );
      if (metadata.database) {
        metadata.database.exec("BEGIN");
        try {
          assert.throws(
            () =>
              captureSqliteFoundationRunFacts(metadata.database!, stage, true),
            /project_source_upload_not_found/u,
          );
        } finally {
          metadata.database.exec("ROLLBACK");
        }
      } else {
        await metadata.execute("BEGIN READ ONLY");
        try {
          await assert.rejects(
            capturePostgresFoundationRunFacts(
              metadata.client!,
              schema,
              stage,
              true,
            ),
            /project_source_upload_not_found/u,
          );
        } finally {
          await metadata.execute("ROLLBACK");
        }
      }
      assert.equal(await f.count("project_foundation_run_admissions"), 1);
      assert.equal(await f.count("project_foundation_run_requirements"), 1);
    },
  );
}
