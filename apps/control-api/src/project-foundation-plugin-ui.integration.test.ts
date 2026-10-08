import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectFoundationMutationResponse } from "@crewon/contracts/project-foundation";
import { foundationUiHttpFixture } from "./project-foundation-plugin-ui.integration.test-support.ts";
import { importParameters } from "./project-foundation-import.test-support.ts";
import {
  actor,
  optionsFor,
  selectionRecipe,
} from "../../../packages/store/src/creative-project-plugin-commit.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: installed Foundation HTTP actions create, confirm and replay actual project metadata`,
    optionsFor(backend),
    async (t) => {
      const f = await foundationUiHttpFixture(t, backend);
      const command = {
        title: "来信",
        briefText: "修复师收到未来的信。",
        origin: "creative" as const,
        parameters: importParameters("creative"),
        creativeStartMode: "confirm-plan" as const,
        sourceUpload: null,
        idempotencyKey: "foundation-http-create",
      };
      const created = (await f.invoke(
        "createProject",
        command,
      )) as ProjectFoundationMutationResponse;
      assert.equal(created.kind, "create-project");
      assert.equal(created.disposition, "committed");
      assert.equal(created.foundation.origin, "creative");
      const projectId = created.project.projectId;
      const draft = (await f.invoke("saveProposal", {
        projectId,
        expectedFoundationRevision: 1,
        expectedProposalRevision: 0,
        kind: "creative-plan",
        text: "三集悬疑：来信、追索、重逢。角色与美术保留。",
        idempotencyKey: "foundation-http-plan",
      })) as ProjectFoundationMutationResponse;
      assert.ok(draft.proposal);
      const confirmed = (await f.invoke("confirmProposal", {
        projectId,
        expectedFoundationRevision: 1,
        proposalRevision: draft.proposal.revision,
        proposalDigest: draft.proposal.contentDigest,
        idempotencyKey: "foundation-http-confirm",
      })) as ProjectFoundationMutationResponse;
      assert.deepEqual(confirmed.foundation.confirmedProposal, {
        revision: 1,
        digest: draft.proposal.contentDigest,
      });
      const read = await f.invoke("getFoundation", { projectId });
      assert.deepEqual(read, { foundation: confirmed.foundation });
      const replay = (await f.invoke(
        "createProject",
        command,
      )) as ProjectFoundationMutationResponse;
      assert.deepEqual(replay, { ...created, disposition: "replayed" });
      const actual = await f.f.parent
        .projectFoundationStore()
        .loadFoundation({
          owner: {
            tenantId: actor.tenantId,
            spaceId: actor.spaceId,
            principalId: actor.principalId,
          },
          projectId,
        });
      assert.equal(actual?.revision, confirmed.foundation.revision);
      assert.deepEqual(
        actual?.confirmedProposal,
        confirmed.foundation.confirmedProposal,
      );
      assert.equal(f.state.fallbackCalls, 0);
      assert.ok(f.authority.state.verifiedTlsConnections > 0);
      const names = await f.f.tableNames();
      assert.equal(names.includes("runs"), false);
      assert.equal(names.includes("extension_tasks"), false);
    },
  );

  test(
    `${backend}: Foundation namespace, business policy and actual installation withdrawal never fall through to task actions`,
    optionsFor(backend),
    async (t) => {
      const f = await foundationUiHttpFixture(t, backend);
      for (const action of [
        "crewon.project-foundation",
        "crewon.project-foundation.v2.createProject",
        "crewon.project-foundation.v1.unknown",
      ]) {
        const result = await f.invokeRaw(action, {});
        assert.notEqual(result.statusCode, 200);
      }
      const command = {
        title: "拒绝前创建",
        briefText: "只有明确确认才开始制作。",
        origin: "creative" as const,
        parameters: importParameters("creative"),
        creativeStartMode: "confirm-plan" as const,
        sourceUpload: null,
        idempotencyKey: "foundation-http-denied",
      };
      f.state.businessAllowed = false;
      assert.notEqual(
        (
          await f.invokeRaw(
            "crewon.project-foundation.v1.createProject",
            command,
          )
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await f.f.query(
            `SELECT count(*) AS n FROM ${f.f.prefix}project_foundations`,
          )
        )[0]!.n,
        backend === "postgres" ? "0" : 0,
      );
      f.state.businessAllowed = true;
      const created = (await f.invoke(
        "createProject",
        command,
      )) as ProjectFoundationMutationResponse;
      await f.f.installations.commitSelection(
        selectionRecipe(f.enabled.selection, "foundation-http-disable", {
          actor,
          state: "disabled",
        }),
      );
      assert.notEqual(
        (
          await f.invokeRaw("crewon.project-foundation.v1.getFoundation", {
            projectId: created.project.projectId,
          })
        ).statusCode,
        200,
      );
      assert.notEqual(
        (
          await f.invokeRaw(
            "crewon.project-foundation.v1.createProject",
            command,
          )
        ).statusCode,
        200,
      );
      assert.equal(f.state.fallbackCalls, 0);
      assert.equal(
        Number(
          (
            await f.f.query(
              `SELECT count(*) AS n FROM ${f.f.prefix}project_foundations`,
            )
          )[0]!.n,
        ),
        1,
      );
    },
  );
}
