import assert from "node:assert/strict";
import { test } from "node:test";
import { extensionCanonicalJson } from "@crewon/domain";
import { creativeStoreDigester as digester } from "./creative-project-store-records.ts";
import {
  foundationRunIssuedFixture,
  foundationRunTestOptions,
  sqlText,
} from "./project-foundation-run.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  for (const origin of ["creative", "novel"] as const) {
    test(
      `${backend}: genuine ${origin} discussion Turn persists a frozen Foundation sidecar and cold replay reads the original fact`,
      foundationRunTestOptions(backend),
      async (t) => {
        const f = await foundationRunIssuedFixture(t, backend, origin);
        const stage = await f.store.loadStageAdmission(f.locator);
        assert.ok(stage);
        assert.equal(f.admission.runId, f.result.run.state.runId);
        assert.equal(f.admission.threadId, f.prepared.binding.threadId);
        assert.equal(
          f.admission.projectStageAdmissionDigest,
          stage.contentDigest,
        );
        assert.equal(
          f.admission.foundationRevision,
          f.foundation.foundation.revision,
        );
        assert.equal(
          f.admission.parametersRevision,
          f.foundation.foundation.parametersRevision,
        );
        assert.equal(
          f.admission.parametersDigest,
          digester.sha256(
            extensionCanonicalJson(f.foundation.foundation.parameters),
          ),
        );
        assert.deepEqual(f.admission.source, f.foundation.foundation.source);
        assert.equal(f.admission.source === null, origin === "creative");
        assert.deepEqual(
          f.admission.confirmedProposal,
          f.foundation.foundation.confirmedProposal,
        );
        assert.ok(f.admission.confirmedProposal);
        assert.equal(
          await f.reader.readRequiredFoundationDigest(f.locator),
          f.admission.contentDigest,
        );
        for (const table of [
          "run_snapshots",
          "project_foundation_run_admissions",
          "project_foundation_run_requirements",
        ])
          assert.equal(await f.count(table), 1);
        const bodyBefore = (
          await f.rows(
            `SELECT record_json FROM ${f.prefix}project_foundation_run_admissions`,
          )
        )[0]?.record_json;
        await f.foundation.invalidate();
        assert.equal(f.foundation.foundation.confirmedProposal, null);
        assert.deepEqual(
          await f.reader.loadFoundationRunAdmission(f.locator),
          f.admission,
        );
        const replay = await f.tasks.createProjectConversationTurnFromHost(
          f.actor,
          f.command,
          f.task,
        );
        assert.equal(replay.result.run.disposition, "replayed");
        assert.equal(replay.result.run.state.runId, f.locator.runId);
        assert.deepEqual(
          (
            await f.rows(
              `SELECT record_json FROM ${f.prefix}project_foundation_run_admissions`,
            )
          )[0]?.record_json,
          bodyBefore,
        );
        for (const table of [
          "run_snapshots",
          "project_foundation_run_admissions",
          "project_foundation_run_requirements",
        ])
          assert.equal(await f.count(table), 1);
        const cold = await f.open();
        assert.deepEqual(
          await cold.parent
            .projectFoundationRunStore()
            .loadFoundationRunAdmission(f.locator),
          f.admission,
        );
        for (const patch of [
          { tenantId: "foreign-tenant" },
          { spaceId: "foreign-space" },
          { runId: "foreign-run" },
        ]) {
          assert.equal(
            await f.reader.loadFoundationRunAdmission({
              ...f.locator,
              ...patch,
            }),
            null,
          );
          assert.equal(
            await f.reader.readRequiredFoundationDigest({
              ...f.locator,
              ...patch,
            }),
            null,
          );
        }
        await assert.rejects(
          f.rows(
            `UPDATE ${f.prefix}project_foundation_run_requirements SET content_digest=content_digest`,
          ),
          /project_foundation_run_history_immutable/u,
        );
        await assert.rejects(
          f.rows(`DELETE FROM ${f.prefix}project_foundation_run_admissions`),
          /project_foundation_run_history_immutable/u,
        );
      },
    );
  }

  for (const corruption of [
    "missing-requirement",
    "missing-admission",
    "digest-mismatch",
    "tampered-body",
    "foreign-canonical-scope",
  ] as const) {
    test(
      `${backend}: ${corruption} paired Run fact rejects both admission and required-digest reads`,
      foundationRunTestOptions(backend),
      async (t) => {
        const f = await foundationRunIssuedFixture(t, backend);
        if (corruption === "missing-requirement")
          await f.corruptSidecar(
            `DELETE FROM ${f.prefix}project_foundation_run_requirements`,
          );
        else if (corruption === "missing-admission")
          await f.corruptSidecar(
            `DELETE FROM ${f.prefix}project_foundation_run_admissions`,
          );
        else if (corruption === "digest-mismatch")
          await f.corruptSidecar(
            `UPDATE ${f.prefix}project_foundation_run_requirements SET content_digest=${sqlText(digester.sha256("different-record"))}`,
          );
        else if (corruption === "tampered-body")
          await f.rewriteRecord({
            ...f.admission,
            foundationRevision: f.admission.foundationRevision + 1,
          });
        else {
          const { contentDigest: _oldDigest, ...body } = f.admission;
          const foreign = {
            ...body,
            actor: {
              ...body.actor,
              tenantId: "foreign-tenant",
              spaceId: "foreign-space",
            },
            installation: {
              ...body.installation,
              tenantId: "foreign-tenant",
              spaceId: "foreign-space",
            },
          };
          await f.rewriteRecord({
            ...foreign,
            contentDigest: digester.sha256(extensionCanonicalJson(foreign)),
          });
        }
        await assert.rejects(
          f.reader.loadFoundationRunAdmission(f.locator),
          /project_foundation_run_admission_invalid/u,
        );
        await assert.rejects(
          f.reader.readRequiredFoundationDigest(f.locator),
          /project_foundation_run_admission_invalid/u,
        );
        const cold = await f.open();
        await assert.rejects(
          cold.parent
            .projectFoundationRunStore()
            .loadFoundationRunAdmission(f.locator),
          /project_foundation_run_admission_invalid/u,
        );
      },
    );
  }
}
