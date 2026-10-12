import assert from "node:assert/strict";
import test from "node:test";
import {
  ApplicationError,
  captureProjectFoundationRunReadAuthority,
} from "@crewon/application";
import { issuePluginProjectFoundationRunReadScope } from "@crewon/application/host-project-workspaces";
import type { ProjectFoundationToolsInputMap } from "@crewon/contracts/project-foundation-tools";
import { foundationToolsOwnerFixture } from "./project-foundation-tools-service-owner.test-support.ts";
import { foundationMetadataFixture } from "../../../../packages/store/src/project-foundation-legacy-access.test-support.ts";
import { projectFoundationBoundReadService } from "./project-foundation-bound-read-service.ts";
for (const backend of ["sqlite", "postgres"] as const)
  test(
    `${backend}: original scoped Foundation service reads immutable proposals and bounded history while refusing actor changes and writes`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    async (t) => {
      const f = await foundationToolsOwnerFixture(t, "novel", backend);
      const projectId = f.admission.projectId;
      // Original manual commands before the ownership constraint; no protected write proof.
      const first = await f.foundations.saveProposal(f.actor, {
        projectId,
        expectedFoundationRevision: 1,
        expectedProposalRevision: 0,
        kind: "novel-adaptation",
        text: "雨😀夜计划第一版",
        idempotencyKey: "original-proposal-one",
      });
      await f.foundations.saveProposal(f.actor, {
        projectId,
        expectedFoundationRevision: 1,
        expectedProposalRevision: 1,
        kind: "novel-adaptation",
        text: "雨😀夜计划第二版",
        idempotencyKey: "original-proposal-two",
      });
      assert.ok(first.proposal);
      const metadata = await foundationMetadataFixture(t, {
        backend,
        schema: f.schema ?? "main",
        prefix: f.prefix,
        path: f.databasePath,
      });
      await metadata.migrate();
      const ownerScope = {
        ...f.actor,
        profileId: f.taskAdmission.profileId,
        pluginId: f.taskAdmission.pluginId,
        publisherId: f.taskAdmission.publisherId,
      };
      await metadata.mark(projectId, ownerScope);
      await assert.rejects(
        f.foundations.getProposal(f.actor, { projectId, proposalRevision: 1 }),
      );
      const originalScope = {
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        profileId: f.taskAdmission.profileId,
      };
      const selection = await f.dependencies.installations.loadSelection({
        scope: originalScope,
        pluginId: f.taskAdmission.pluginId,
      });
      const pkg = await f.dependencies.installations.loadPackage({
        scope: originalScope,
        packageDigest: f.taskAdmission.packageDigest,
      });
      let live = true;
      async function service<M extends "getProposal" | "listProposals">(
        method: M,
        request: ProjectFoundationToolsInputMap[M],
      ) {
        const op = await f.prepare(method, request);
        const q = captureProjectFoundationRunReadAuthority({
          version: "crewon.project-foundation-run-read.v1",
          actor: f.actor,
          run: op.run,
          receipt: op.receipt,
          claim: op.claim,
          commandInput: op.command.input,
          operationId:
            method === "getProposal"
              ? "foundation_proposal"
              : "foundation_proposals",
          installation: f.admission.installation,
          admission: f.taskAdmission,
          projectStageAdmission: f.stage,
          foundationAdmission: f.admission,
          selection,
          package: pkg,
          async assertCurrent() {
            assert.ok(live);
          },
        });
        const scope = await issuePluginProjectFoundationRunReadScope({
          authority: q,
          assertActive() {
            assert.ok(live);
          },
        });
        return projectFoundationBoundReadService(
          { store: f.parent, authorization: f.dependencies.authorization },
          scope,
        );
      }
      const one = await service("getProposal", {
        projectId,
        proposalRevision: 1,
        proposalDigest: first.proposal.contentDigest,
        startOffset: 0,
        limit: 5,
      });
      const before = await f.counts();
      const value = await one.getProposal(f.actor, {
        projectId,
        proposalRevision: 1,
      });
      assert.equal(value.text, first.proposal.text);
      assert.equal(value.contentDigest, first.proposal.contentDigest);
      await assert.rejects(
        one.getProposal(f.actor, { projectId, proposalRevision: 2 }),
        (error) =>
          error instanceof ApplicationError &&
          error.cause instanceof Error &&
          error.cause.message === "plugin_project_read_target_mismatch",
      );
      await assert.rejects(
        one.getProposal(
          { ...f.actor, actorId: "foreign-actor" },
          { projectId, proposalRevision: 1 },
        ),
        (error) =>
          error instanceof ApplicationError &&
          error.category === "authorization",
      );
      await assert.rejects(
        one.saveProposal(f.actor, {
          projectId,
          expectedFoundationRevision: 1,
          expectedProposalRevision: 2,
          kind: "novel-adaptation",
          text: "只读范围不能保存",
          idempotencyKey: "read-cannot-write",
        }),
        (error) =>
          error instanceof ApplicationError &&
          error.category === "authorization",
      );
      assert.deepEqual(await f.counts(), before);
      const history = await service("listProposals", {
        projectId,
        afterProposalRevision: 0,
        limit: 1,
      });
      const page = await history.listProposals(f.actor, {
        projectId,
        afterProposalRevision: 0,
        limit: 1,
      });
      assert.equal(page.proposals.length, 1);
      assert.equal(page.proposals[0]!.revision, 1);
      assert.equal(page.nextRevision, 1);
      const next = await history.listProposals(f.actor, {
        projectId,
        afterProposalRevision: 1,
        limit: 1,
      });
      assert.equal(next.proposals[0]!.revision, 2);
      assert.equal(next.nextRevision, null);
      await assert.rejects(
        history.getProposal(f.actor, { projectId, proposalRevision: 1 }),
        (error) =>
          error instanceof ApplicationError &&
          error.cause instanceof Error &&
          error.cause.message === "plugin_project_read_method_mismatch",
      );
      live = false;
      await assert.rejects(
        one.getProposal(f.actor, { projectId, proposalRevision: 1 }),
      );
    },
  );
