import assert from "node:assert/strict";
import test from "node:test";
import {
  captureProjectOutlineRunReadAuthority,
  issuePluginProjectOutlineRunReadScope,
} from "@crewon/application/host-project-workspaces";
import { projectRunOwnedFixture } from "../../../../packages/store/src/project-run-owned.test-support.ts";
import { outlineToolsOwnerFixture } from "./project-outline-tools-service-owner.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 30000,
  };
  test(
    `${backend}: true outline_context reads owned Foundation, cold restores, and gives no mutation authority`,
    options,
    async (t) => {
      const f = await outlineToolsOwnerFixture(t, backend),
        read = await f.contextInvocation();
      await projectRunOwnedFixture(t, {
        backend,
        path: f.databasePath,
        prefix: f.prefix,
        stage: f.dependencies.stageAdmission,
      });
      const owner = f.owner();
      const result = await read.invoke(owner, () =>
        f
          .service(owner)
          .getContext({ command: read.command, request: read.request }),
      );
      assert.deepEqual(
        JSON.parse(result.page.text),
        f.foundation.foundation.parameters,
      );
      assert.equal(result.context.briefRevision, f.brief.briefRevision);
      assert.equal(
        result.context.foundationRevision,
        f.foundation.foundation.revision,
      );
      await assert.rejects(
        f.dependencies.foundations.loadFoundation({
          owner: {
            tenantId: f.actor.tenantId,
            spaceId: f.actor.spaceId,
            principalId: f.actor.principalId,
          },
          projectId: f.reference.projectId,
        }),
      );
      await owner.close();
      const cold = await f.open();
      const resumed = f.owner({
        outlines: f.application(cold.parent),
        foundations: cold.parent.projectFoundationStore(),
        conversations: cold.parent.projectConversationStore(),
        runs: cold.parent,
        installations: cold.parent.pluginInstallationStore(),
      });
      const replay = await read.invoke(resumed, () =>
        f
          .service(resumed)
          .getContext({ command: read.command, request: read.request }),
      );
      assert.deepEqual(replay, result);
      const run = await f.parent.loadRun(f.locator);
      assert.ok(run);
      const original = f.prepared.transaction;
      const authority = captureProjectOutlineRunReadAuthority({
        version: "crewon.project-outline-run-read.v1",
        actor: f.actor,
        run,
        receipt: read.receipt,
        claim: f.claim,
        commandInput: read.command.input,
        operationId: "outline_context",
        installation: original.installation,
        admission: original.admission,
        projectStageAdmission: original.projectStageAdmission,
        selection: original.selection,
        package: original.package,
        assertCurrent: async () => {
          f.active();
        },
      });
      const scope = await issuePluginProjectOutlineRunReadScope({
        authority,
        assertActive: f.active,
      });
      await assert.rejects(
        f.application().withPluginProjectRunReads({ ...scope }),
      );
      const scoped = await f.application().withPluginProjectRunReads(scope);
      assert.equal(
        await scoped.getOutline(f.actor, { projectId: f.reference.projectId }),
        null,
      );
      await assert.rejects(
        scoped.saveCandidate(f.actor, {
          ...f.prepared.command,
          idempotencyKey: "read-cannot-write",
        }),
      );
      assert.throws(() =>
        captureProjectOutlineRunReadAuthority({
          ...authority,
          operationId: "outline_read",
        }),
      );
      assert.throws(() =>
        captureProjectOutlineRunReadAuthority({
          ...authority,
          receipt: original.receipt,
        }),
      );
      await assert.rejects(
        read.invoke(resumed, () =>
          f.service(resumed).getContext({
            command: structuredClone(read.command),
            request: read.request,
          }),
        ),
      );
      f.controls.policy = false;
      await assert.rejects(
        read.invoke(resumed, () =>
          f
            .service(resumed)
            .getContext({ command: read.command, request: read.request }),
        ),
      );
      f.controls.policy = true;
      const expired = f.owner({
        now: () => new Date(Date.parse(f.claim.lease.expiresAt) + 1),
      });
      await assert.rejects(
        read.invoke(expired, () =>
          f
            .service(expired)
            .getContext({ command: read.command, request: read.request }),
        ),
      );
      assert.equal(await f.count("project_text_revisions"), 0);
      assert.equal(await f.count("project_text_mutation_receipts"), 0);
    },
  );
  for (const mismatch of [
    "foreign-plugin",
    "missing-namespace",
    "workspace",
  ] as const) {
    test(
      `${backend}: outline_context refuses ${mismatch} without exposing owned parameters`,
      options,
      async (t) => {
        const f = await outlineToolsOwnerFixture(t, backend),
          read = await f.contextInvocation();
        await projectRunOwnedFixture(t, {
          backend,
          path: f.databasePath,
          prefix: f.prefix,
          stage: f.dependencies.stageAdmission,
          ...(mismatch === "foreign-plugin"
            ? { owner: { pluginId: "foreign.protected" } }
            : mismatch === "missing-namespace"
              ? { namespace: "missing" }
              : { workspace: "wrong-owned-workspace" }),
        });
        const owner = f.owner();
        await assert.rejects(
          read.invoke(owner, () =>
            f
              .service(owner)
              .getContext({ command: read.command, request: read.request }),
          ),
        );
        await assert.rejects(
          f.invoke(owner, () =>
            f.service(owner).saveCandidate({
              command: f.command,
              request: f.portableRequest,
            }),
          ),
        );
        assert.equal(await f.count("project_text_revisions"), 0);
        assert.equal(await f.count("project_text_mutation_receipts"), 0);
      },
    );
  }
}

test(
  "postgres: owned context waits for the original Run before taking a project row lock",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 30000 },
  async (t) => {
    const f = await outlineToolsOwnerFixture(t, "postgres"),
      read = await f.contextInvocation();
    const metadata = await projectRunOwnedFixture(t, {
      backend: "postgres",
      path: f.databasePath,
      prefix: f.prefix,
      stage: f.dependencies.stageAdmission,
    });
    await metadata.begin();
    await metadata.execute(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [`run:${f.actor.tenantId}:${f.locator.runId}`],
    );
    const owner = f.owner();
    let pending: Promise<unknown> | undefined;
    try {
      pending = read.invoke(owner, () =>
        f
          .service(owner)
          .getContext({ command: read.command, request: read.request }),
      );
      void pending.catch(() => {});
      const until = Date.now() + 5000;
      while (!(await metadata.hasBlockedReader())) {
        if (Date.now() > until)
          assert.fail("expected read to wait for actual Run lock");
        await new Promise((done) => setTimeout(done, 10));
      }
      const rows = await metadata.client!.query(
        `SELECT project_id FROM ${f.prefix}creative_projects WHERE tenant_id=$1 AND space_id=$2 AND project_id=$3 FOR UPDATE NOWAIT`,
        [f.actor.tenantId, f.actor.spaceId, f.reference.projectId],
      );
      assert.equal(rows.rows[0].project_id, f.reference.projectId);
    } finally {
      await metadata.execute("ROLLBACK");
    }
    const result = (await pending) as {
      context: { foundationRevision: number };
    };
    assert.equal(
      result.context.foundationRevision,
      f.foundation.foundation.revision,
    );
    assert.equal(await f.count("project_text_revisions"), 0);
  },
);
