import assert from "node:assert/strict";
import test from "node:test";
import { creationRecipe } from "./creative-project-store.test-support.ts";
import {
  structuredOutlineFixture,
  candidate,
  selection,
  actor,
  digester,
} from "./project-structured-outline.test-support.ts";
import {
  protectStructuredFixture,
  structuredLegacySnapshot,
} from "./project-structured-outline-legacy-access.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: v2 details, pagination and receipt digest comparisons hide protected projects`,
    options,
    async (t) => {
      const f = await structuredOutlineFixture(t, backend);
      const command = candidate(f, "protected-outline");
      const saved =
        await f.first.text.commitStructuredOutlineCandidate(command);
      await f.first.text.commitStructuredOutlineCandidate(
        candidate(f, "protected-outline-next", saved.artifact),
      );
      await protectStructuredFixture(t, f);
      for (const contentRevision of [1, 2])
        assert.equal(
          await f.first.text.loadStructuredRevision({
            ...f.scope,
            artifactId: saved.artifact.artifactId,
            contentRevision,
          }),
          null,
        );
      for (const afterContentRevision of [0, 1, 2])
        assert.deepEqual(
          await f.first.text.listStructuredRevisions({
            ...f.scope,
            artifactId: saved.artifact.artifactId,
            afterContentRevision,
            limit: 1,
          }),
          { revisions: [], nextContentRevision: null },
        );
      for (const requestDigest of [
        command.receipt.requestDigest,
        digester.sha256("foreign-request"),
      ])
        assert.equal(
          await f.first.text.loadStructuredMutationReceipt({
            actor,
            kind: "save-outline",
            receipt: { ...command.receipt, requestDigest },
          }),
          null,
        );
    },
  );
  test(
    `${backend}: v2 candidate, selection and saved receipt replay reject protected metadata without rewriting history`,
    options,
    async (t) => {
      const f = await structuredOutlineFixture(t, backend);
      const command = candidate(f, "protected-replay");
      const saved =
        await f.first.text.commitStructuredOutlineCandidate(command);
      const adopt = selection(
        f,
        "protected-selection",
        saved.artifact,
        command.contentRevision,
      );
      await protectStructuredFixture(t, f);
      const before = await structuredLegacySnapshot(f);
      for (const run of [
        () => f.first.text.commitStructuredOutlineCandidate(command),
        () =>
          f.first.text.commitStructuredOutlineCandidate(
            candidate(f, "protected-fresh", saved.artifact),
          ),
        () => f.first.text.commitStructuredOutlineSelection(adopt),
      ]) {
        await assert.rejects(run(), /creative_project_not_found/u);
        assert.deepEqual(await structuredLegacySnapshot(f), before);
      }
      const cold = await f.open();
      assert.equal(
        await cold.text.loadStructuredMutationReceipt({
          actor,
          kind: "save-outline",
          receipt: command.receipt,
        }),
        null,
      );
      await assert.rejects(
        cold.text.commitStructuredOutlineCandidate(command),
        /creative_project_not_found/u,
      );
      assert.deepEqual(await structuredLegacySnapshot(f), before);
    },
  );
  test(
    `${backend}: v2 partial owner schema rejects ordinary reads, receipt and mutations`,
    options,
    async (t) => {
      const f = await structuredOutlineFixture(t, backend);
      const command = candidate(f, "partial-owner");
      await f.first.text.commitStructuredOutlineCandidate(command);
      await f.execute(
        `CREATE TABLE ${f.prefix}plugin_project_metadata_owner_schema_version(id INTEGER)`,
      );
      const before = await structuredLegacySnapshot(f);
      for (const run of [
        () =>
          f.first.text.loadStructuredRevision({
            ...f.scope,
            artifactId: command.artifact.artifactId,
            contentRevision: 1,
          }),
        () =>
          f.first.text.listStructuredRevisions({
            ...f.scope,
            artifactId: command.artifact.artifactId,
            afterContentRevision: 0,
            limit: 1,
          }),
        () =>
          f.first.text.loadStructuredMutationReceipt({
            actor,
            kind: "save-outline",
            receipt: command.receipt,
          }),
        () => f.first.text.commitStructuredOutlineCandidate(command),
      ])
        await assert.rejects(run(), /schema_invalid/u);
      await f.first.projects.migrate();
      await f.first.text.migrate();
      assert.deepEqual(await structuredLegacySnapshot(f), before);
    },
  );
  test(
    `${backend}: v2 replay checks actual saved project before corrupt JSON and ordinary replacement target`,
    options,
    async (t) => {
      const f = await structuredOutlineFixture(t, backend);
      const command = candidate(f, "actual-saved-project");
      await f.first.text.commitStructuredOutlineCandidate(command);
      const other = creationRecipe(
        "ordinary-v2-project",
        "ordinary-v2-create",
        actor,
      );
      await f.first.projects.commitProjectCreation(other);
      const ordinary = candidate(
        {
          ...f,
          created: {
            ...f.created,
            project: other.project,
            brief: other.initialBrief,
          },
        },
        "actual-saved-project",
      );
      await protectStructuredFixture(t, f);
      // Deliberately corrupt the immutable row for the decoder-order negative fixture.
      await f.execute(
        backend === "sqlite"
          ? "DROP TRIGGER project_text_mutation_receipts_no_update"
          : `DROP TRIGGER project_text_mutation_receipts_no_update_or_delete ON ${f.prefix}project_text_mutation_receipts`,
      );
      await f.execute(
        `UPDATE ${f.prefix}project_text_mutation_receipts SET result_json='{}'`,
      );
      const before = await structuredLegacySnapshot(f);
      assert.equal(
        await f.first.text.loadStructuredMutationReceipt({
          actor,
          kind: "save-outline",
          receipt: command.receipt,
        }),
        null,
      );
      await assert.rejects(
        f.first.text.commitStructuredOutlineCandidate(ordinary),
        /creative_project_not_found/u,
      );
      assert.deepEqual(await structuredLegacySnapshot(f), before);
    },
  );
  test(
    `${backend}: v2 corrupt ordinary saved receipt retains original decoder failure`,
    options,
    async (t) => {
      const f = await structuredOutlineFixture(t, backend);
      const command = candidate(f, "ordinary-corrupt");
      await f.first.text.commitStructuredOutlineCandidate(command);
      await f.execute(
        backend === "sqlite"
          ? "DROP TRIGGER project_text_mutation_receipts_no_update"
          : `DROP TRIGGER project_text_mutation_receipts_no_update_or_delete ON ${f.prefix}project_text_mutation_receipts`,
      );
      await f.execute(
        `UPDATE ${f.prefix}project_text_mutation_receipts SET result_json='{}'`,
      );
      await assert.rejects(
        f.first.text.loadStructuredMutationReceipt({
          actor,
          kind: "save-outline",
          receipt: command.receipt,
        }),
        /extension_manifest_fields_invalid/u,
      );
      await assert.rejects(
        f.first.text.commitStructuredOutlineCandidate(command),
        /extension_manifest_fields_invalid/u,
      );
    },
  );
}
