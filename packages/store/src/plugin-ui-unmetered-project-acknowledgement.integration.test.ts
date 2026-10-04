import assert from "node:assert/strict";
import test from "node:test";
import {
  PluginUiCommittedTaskAuthority,
  ApplicationError,
} from "@crewon/application";
import {
  parseInstalledPluginPackage,
  parsePluginSelection,
  parseProjectGenerationPublication,
} from "@crewon/domain";
import {
  parsePluginUiLease,
  parseProjectGenerationUiActionRequest,
  parseProjectGenerationUiActionResponse,
} from "@crewon/contracts/plugins";
import { committedTaskContext } from "../../application/src/plugin-ui-committed-task-support.ts";
import { committedProjectGenerationFixture } from "../../application/src/plugin-ui-committed-project-generation.test-support.ts";
import { projectGenerationUiTaskCommand } from "../../application/src/project-generation-task-receipt.ts";
import { unmeteredFixture } from "./plugin-task-unmetered.test-support.ts";
import { extensionStoreDigester as digester } from "./extension-store-records.ts";

/** Real original SQL receipts and Application acknowledgement, with a named UI context.
 * No Main identity, live Worker, model or supplier execution is claimed. */
test("original SQLite unmetered project receipt acknowledges a distinct source UI and same-key cold recovery preserves one Run", async (t) => {
  const f = await unmeteredFixture(t, "sqlite");
  const original = committedProjectGenerationFixture().detachedContext();
  const scope = {
    tenantId: f.actor.tenantId,
    spaceId: f.actor.spaceId,
    profileId: f.pin.profileId,
  };
  const pkg = parseInstalledPluginPackage({ ...original.package, ...scope });
  const selection = parsePluginSelection({ ...original.selection, ...scope });
  const request = {
    reference: f.reference,
    threadId: f.command().threadId,
    expectedThreadRevision: f.command().expectedThreadRevision,
    idempotencyKey: "named-unmetered-project-ui-intent",
  };
  const context = {
    ...original,
    actor: f.actor,
    scope,
    package: pkg,
    selection,
    lease: parsePluginUiLease({
      ...original.lease,
      selectionRevision: selection.revision,
      packageDigest: pkg.packageDigest,
    }),
    input: request,
  };
  const publication = parseProjectGenerationPublication({
    source: {
      pluginId: pkg.pluginId,
      packageDigest: pkg.packageDigest,
      contributionId: context.lease.contributionId,
    },
    target: {
      pluginId: f.pin.pluginId,
      packageDigest: f.pin.packageDigest,
      contributionId: f.pin.contributionId,
      action: f.pin.action,
    },
  });
  const command = projectGenerationUiTaskCommand(
    {
      sourcePin: committedTaskContext(context).pin,
      executionPin: f.pin,
      request,
      prompt: f.command().intent.input.prompt,
    },
    digester,
  );
  const accepted = await f
    .create()
    .createProjectTaskFromPlugin(
      f.actor,
      command,
      f.pin,
      f.reference,
      f.projectAuthority,
    );
  assert.equal(accepted.creditAdmission, undefined);
  assert.ok(accepted.unmeteredAdmission);
  assert.notEqual(pkg.pluginId, accepted.binding.pluginId);
  const authorityFor = (parent = f.first.parent, extensions = f.first.store) =>
    new PluginUiCommittedTaskAuthority({
      extensions,
      runs: parent,
      digester,
      projectGenerations: {
        publications: [publication],
        projects: parent.creativeProjectStore(),
      },
    });
  const authority = authorityFor();
  const envelope = {
    context,
    command,
    executionPin: f.pin,
    result: accepted,
  };
  const outcome = await authority.issueProjectGeneration(envelope);
  const acknowledgement = parseProjectGenerationUiActionResponse(
    parseProjectGenerationUiActionRequest({
      action: context.action,
      input: request,
    }),
    authority.verify(context, outcome),
  );
  assert.equal(acknowledgement.runId, accepted.binding.runId);
  assert.equal(acknowledgement.disposition, "committed");
  assert.throws(() => authority.verify(context, outcome));

  // New adapter owners cold-read the original persisted receipt and replay the exact key.
  const cold = await f.open();
  await cold.store.migratePluginAdmissions();
  await cold.store.migrateUnmeteredPluginAdmissions();
  await cold.store.migrateProjectGenerations();
  const replay = await f
    .create(cold.store, cold.parent)
    .createProjectTaskFromPlugin(
      f.actor,
      command,
      f.pin,
      f.reference,
      f.projectAuthority,
    );
  assert.equal(replay.run.disposition, "replayed");
  assert.equal(replay.binding.runId, accepted.binding.runId);
  assert.deepEqual(replay.unmeteredAdmission, accepted.unmeteredAdmission);
  const coldAuthority = authorityFor(cold.parent, cold.store);
  const recovered = await coldAuthority.issueProjectGeneration({
    ...envelope,
    result: replay,
  });
  assert.deepEqual(coldAuthority.verify(context, recovered), {
    ...acknowledgement,
    disposition: "replayed",
  });
  for (const table of [
    "run_snapshots",
    "extension_run_bindings",
    "creative_project_generation_links",
    "plugin_task_admissions",
    "plugin_task_unmetered_admissions",
  ])
    assert.equal(await f.count(table), 1, table);
  assert.equal(f.authorityState.prepared, 1);
  assert.deepEqual(await f.creditObjects(), []);

  // Funding is still exactly one complete proof with the original task owner.
  for (const result of [
    (({ unmeteredAdmission: _proof, ...missing }) => missing)(accepted),
    { ...accepted, creditAdmission: {} },
    {
      ...accepted,
      unmeteredAdmission: {
        ...accepted.unmeteredAdmission!,
        task: { ...accepted.unmeteredAdmission!.task, principalId: "other" },
      },
    },
  ])
    await assert.rejects(
      authority.issueProjectGeneration({
        ...envelope,
        result,
      } as typeof envelope),
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.code === "plugin_ui_committed_project_generation_invalid",
    );
  assert.equal(await f.count("run_snapshots"), 1);
});
