import assert from "node:assert/strict";
import test from "node:test";
import {
  foundationRunIssuedFixture,
  foundationRunTestOptions,
} from "./project-foundation-run.test-support.ts";
import { foundationMetadataFixture } from "./project-foundation-legacy-access.test-support.ts";
import {
  capturePostgresFoundationRunFacts,
  captureSqliteFoundationRunFacts,
} from "./project-foundation-run-facts.ts";
import {
  capturePostgresProjectFoundationDownstream,
  captureSqliteProjectFoundationDownstream,
} from "./project-foundation-downstream-guard.ts";
import {
  loadPostgresFoundationRun,
  loadSqliteFoundationRun,
} from "./project-foundation-run-store.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: protected genuine Foundation admission and digest facts reject rather than disappearing on original and cold readers`,
    foundationRunTestOptions(backend),
    async (t) => {
      const f = await foundationRunIssuedFixture(t, backend);
      const stage = await f.store.loadStageAdmission(f.locator);
      assert.ok(stage);
      const schema = backend === "postgres" ? f.prefix.slice(1, -2) : "main";
      const metadata = await foundationMetadataFixture(t, {
        schema,
        prefix: f.prefix,
        backend,
        path: f.databasePath,
      });
      await metadata.migrate();
      assert.deepEqual(
        await f.reader.loadFoundationRunAdmission(f.locator),
        f.admission,
      );
      assert.equal(
        await f.reader.readRequiredFoundationDigest(f.locator),
        f.admission.contentDigest,
      );
      // This fixture stores the immutable owner row only to prove ordinary denial, not a new Host grant.
      await metadata.mark(f.reference.projectId, f.actor);
      await assert.rejects(
        f.reader.loadFoundationRunAdmission(f.locator),
        /creative_project_not_found/u,
      );
      await assert.rejects(
        f.reader.readRequiredFoundationDigest(f.locator),
        /creative_project_not_found/u,
      );
      const cold = await f.open();
      await assert.rejects(
        cold.parent
          .projectFoundationRunStore()
          .loadFoundationRunAdmission(f.locator),
        /creative_project_not_found/u,
      );
      if (metadata.database) {
        assert.throws(
          () => loadSqliteFoundationRun(metadata.database!, f.locator),
          /creative_project_not_found/u,
        );
        assert.throws(
          () =>
            captureSqliteFoundationRunFacts(metadata.database!, stage, true),
          /creative_project_not_found/u,
        );
        assert.throws(
          () =>
            captureSqliteProjectFoundationDownstream(metadata.database!, {
              actor: f.actor,
              projectId: f.reference.projectId,
            }),
          /creative_project_not_found/u,
        );
      } else {
        await metadata.execute("BEGIN READ ONLY");
        try {
          await assert.rejects(
            loadPostgresFoundationRun(metadata.client!, schema, f.locator),
            /creative_project_not_found/u,
          );
          await assert.rejects(
            capturePostgresFoundationRunFacts(
              metadata.client!,
              schema,
              stage,
              true,
            ),
            /creative_project_not_found/u,
          );
          await assert.rejects(
            capturePostgresProjectFoundationDownstream(
              metadata.client!,
              schema,
              { actor: f.actor, projectId: f.reference.projectId },
            ),
            /creative_project_not_found/u,
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
