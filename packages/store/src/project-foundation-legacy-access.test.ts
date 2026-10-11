import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { setProjectFoundationCreativeStartMode } from "@crewon/domain";
import { creationRecipe } from "./creative-project-store.test-support.ts";
import {
  actor,
  owner,
  fixture,
  foundationCreationRecipe,
  proposalRecipe,
  confirmationRecipe,
  parameterChangeRecipe,
  sourceChangeRecipe,
  ordinaryAuthority,
  receipt,
  time,
} from "./project-foundation-store.test-support.ts";
import { foundationMetadataFixture } from "./project-foundation-legacy-access.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 30_000,
  };
  test(
    `${backend}: original Foundation reads remain compatible and reject protected parent/source/proposal pages and cold reads`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const original = foundationCreationRecipe(
        "foundation-owned",
        undefined,
        "novel",
      );
      const created = await f.first.foundation.commitCreation(original);
      const proposed = await f.first.foundation.commitProposal(
        proposalRecipe(created.project, created.foundation, "proposal-owned"),
      );
      const confirmed = await f.first.foundation.commitFoundationChange(
        confirmationRecipe(
          created.project,
          created.foundation,
          proposed.proposal!,
          "confirm-owned",
        ),
      );
      const scope = { owner: owner(), projectId: created.project.projectId };
      const sourceScope = {
        ...scope,
        revision: 1,
        digest: created.source!.digest,
      };
      const reads = [
        () => f.first.foundation.loadFoundation(scope),
        () => f.first.foundation.loadSource({ ...scope, revision: 1 }),
        () =>
          f.first.foundation.readSourcePage({
            ...sourceScope,
            startOffset: 0,
            limit: 5,
          }),
        () =>
          f.first.foundation.listSourceChapters({
            ...sourceScope,
            afterStartOffset: null,
            limit: 1,
          }),
        () => f.first.foundation.loadProposal({ ...scope, revision: 1 }),
        () =>
          f.first.foundation.listProposals({
            ...scope,
            afterRevision: 0,
            limit: 1,
          }),
      ];
      for (const read of reads) assert.ok(await read());
      const metadata = await foundationMetadataFixture(t, f);
      await metadata.migrate();
      for (const read of reads) assert.ok(await read());
      const before = await f.counts();
      await metadata.mark(scope.projectId);
      for (const read of reads)
        await assert.rejects(read(), /creative_project_not_found/u);
      const reopened = await f.open();
      await assert.rejects(
        reopened.foundation.loadFoundation(scope),
        /creative_project_not_found/u,
      );
      assert.deepEqual(await f.counts(), before);
      // A separate ordinary project stays available in the same original database/schema.
      const ordinary = await reopened.foundation.commitCreation(
        foundationCreationRecipe("foundation-ordinary"),
      );
      assert.deepEqual(
        await reopened.foundation.loadFoundation({
          owner: owner(),
          projectId: ordinary.project.projectId,
        }),
        ordinary.foundation,
      );
      assert.equal(confirmed.foundation.confirmedProposal?.revision, 1);
    },
  );

  test(
    `${backend}: protected Foundation writes and actual receipt replays are denied without mutation`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const input = foundationCreationRecipe(
        "receipt-owned",
        "receipt-create",
        "novel",
      );
      const created = await f.first.foundation.commitCreation(input);
      const proposalInput = proposalRecipe(
        created.project,
        created.foundation,
        "receipt-proposal",
      );
      const proposed = await f.first.foundation.commitProposal(proposalInput);
      const metadata = await foundationMetadataFixture(t, f);
      await metadata.migrate();
      await metadata.mark(input.project.projectId);
      const before = await f.counts();
      const cold = await f.open();
      const reject = (operation: Promise<unknown>) =>
        assert.rejects(operation, /creative_project_not_found/u);
      await reject(
        cold.foundation.loadMutationReceipt({
          actor,
          kind: "create-project",
          receipt: input.receipt,
        }),
      );
      await reject(
        cold.foundation.loadMutationReceipt({
          actor,
          kind: "save-proposal",
          receipt: proposalInput.receipt,
        }),
      );
      await reject(cold.foundation.commitCreation(input));
      // The new proposed ID must not hide the protected ID stored under the original command.
      await reject(
        cold.foundation.commitCreation({
          ...foundationCreationRecipe(
            "different-generated-id",
            "receipt-create",
            "novel",
          ),
          receipt: input.receipt,
        }),
      );
      await reject(cold.foundation.commitProposal(proposalInput));
      await reject(
        cold.foundation.commitProposal(
          proposalRecipe(
            created.project,
            created.foundation,
            "fresh-owned-proposal",
            proposed.proposal!,
          ),
        ),
      );
      await reject(
        cold.foundation.commitFoundationChange(
          parameterChangeRecipe(
            created.project,
            created.foundation,
            "owned-parameters",
          ),
        ),
      );
      await reject(
        cold.foundation.commitFoundationChange(
          sourceChangeRecipe(
            created.project,
            created.foundation,
            "owned-source",
          ),
        ),
      );
      await reject(
        cold.foundation.commitFoundationChange(
          confirmationRecipe(
            created.project,
            created.foundation,
            proposed.proposal!,
            "owned-confirmation",
          ),
        ),
      );
      assert.deepEqual(await f.counts(), before);
      const creative = await f.first.foundation.commitCreation(
        foundationCreationRecipe("owned-direct"),
      );
      await metadata.mark(creative.project.projectId);
      const foundation = setProjectFoundationCreativeStartMode({
        project: creative.project,
        foundation: creative.foundation,
        actor,
        expectedFoundationRevision: 1,
        creativeStartMode: "direct-script",
        at: time(1),
      });
      await reject(
        cold.foundation.commitFoundationChange({
          actor,
          receipt: receipt("owned-direct-script"),
          kind: "choose-direct-script",
          expectedFoundationRevision: 1,
          foundation,
          source: null,
          chunks: [],
          chapters: [],
          proposal: null,
        }),
      );
      assert.equal(
        Number(
          (
            await f.query(
              `SELECT revision FROM ${f.prefix}project_foundations WHERE project_id='owned-direct'`,
            )
          )[0]!.revision,
        ),
        1,
      );
    },
  );

  test(
    `${backend}: partial metadata owner schema fails closed before legacy Foundation absence`,
    options,
    async (t) => {
      const f = await fixture(t, backend, { migrate: false });
      await f.first.projects.commitProjectCreation(
        creationRecipe("no-foundation"),
      );
      await f.execute(
        `CREATE TABLE ${f.prefix}plugin_project_metadata_owners (tenant_id TEXT)`,
      );
      const scope = { owner: owner(), projectId: "no-foundation" };
      for (const operation of [
        () => f.first.foundation.loadFoundation(scope),
        () => f.first.foundation.loadSource({ ...scope, revision: 1 }),
        () =>
          f.first.foundation.listProposals({
            ...scope,
            afterRevision: 0,
            limit: 1,
          }),
        () =>
          f.first.foundation.loadMutationReceipt({
            actor,
            kind: "create-project",
            receipt: receipt("missing-receipt"),
          }),
        () =>
          f.first.foundation.commitCreation(
            foundationCreationRecipe("blocked-fresh"),
          ),
      ])
        await assert.rejects(
          operation(),
          /plugin_project_metadata_owner_schema/u,
        );
      assert.equal(await f.count("creative_projects"), 1);
    },
  );

  test(
    `${backend}: the final legacy SQL guard does not weaken original authority withdrawal`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const metadata = await foundationMetadataFixture(t, f);
      await metadata.migrate();
      const existing = await f.first.foundation.commitCreation(
        foundationCreationRecipe("final-fence"),
      );
      const policy = ordinaryAuthority();
      let wrote = false;
      let finalGuardObserved = false;
      f.first.hooks.afterStatement = (sql) => {
        if (
          sql.startsWith("INSERT INTO") &&
          sql.includes("project_foundation_mutation_receipts")
        )
          wrote = true;
        if (
          wrote &&
          sql.includes("SELECT 1 FROM") &&
          sql.includes("plugin_project_metadata_owners")
        ) {
          finalGuardObserved = true;
          policy.state.active = false;
        }
      };
      const before = await f.counts();
      await assert.rejects(
        f.first.foundation.commitFoundationChange(
          parameterChangeRecipe(
            existing.project,
            existing.foundation,
            "final-fence-change",
          ),
          { authority: policy.authority },
        ),
        /foundation authority withdrawn/u,
      );
      f.first.hooks.afterStatement = null;
      assert.equal(finalGuardObserved, true);
      assert.deepEqual(await f.counts(), before);
    },
  );
}

test(
  "postgres: first sidecar migration wait observes the new owner before original Foundation read",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, "postgres");
    const created = await f.first.foundation.commitCreation(
      foundationCreationRecipe("migration-owned"),
    );
    const metadata = await foundationMetadataFixture(t, f);
    await metadata.begin();
    await metadata.migrateDirect();
    await metadata.mark(created.project.projectId);
    const read = f.first.foundation.loadFoundation({
      owner: owner(),
      projectId: created.project.projectId,
    });
    const rejected = assert.rejects(read, /creative_project_not_found/u);
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await metadata.hasBlockedReader()) {
        blocked = true;
        break;
      }
      await delay(5);
    }
    assert.equal(
      blocked,
      true,
      "real reader must wait on the uncommitted original schema migration",
    );
    await metadata.execute("COMMIT");
    await rejected;
    assert.equal(await f.count("project_foundations"), 1);
  },
);
