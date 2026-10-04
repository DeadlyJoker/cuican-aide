import assert from "node:assert/strict";
import test from "node:test";
import {
  ExtensionTaskApplicationService,
  PluginUiCommittedTaskAuthority,
  type PluginUiActionContext,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  parseProjectGenerationLink,
} from "@crewon/domain";
import { assertPluginUiHostServiceAvailability } from "@crewon/plugin-host";
import { extensionStoreDigester } from "../../../packages/store/src/extension-store-records.ts";
import { InstalledPluginProjectGenerationOwner } from "./installed-plugin-project-generation-owner.ts";
import { InstalledPluginTaskActionOwner } from "./installed-plugin-task-action-owner.ts";
import { deferred } from "./installed-plugin-task-action-owner.test-support.ts";
import {
  actor,
  creditScope,
  generationAction,
  installedGenerationFixture,
  savedPrompt,
  scope,
} from "./installed-plugin-project-generation-owner.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 20_000,
  };
  test(
    `${backend} installed UI-only business package generates through its actual independently installed execution owner, then replays one paid Run`,
    options,
    async (t) => {
      const f = await installedGenerationFixture(t, backend);
      assert.equal(f.source.descriptor.entrypoints.node, null);
      assert.deepEqual(f.source.descriptor.requires, [
        {
          service: "crewon.project-generations",
          apiVersion: "1",
          optional: false,
        },
      ]);
      assert.equal(f.nodeState.setups, 0);
      const before = await f.counts();
      const output = await f.invoke();
      assert.ok(
        f.state.packagePurposes.some((item) => item.pluginId === f.sourceId),
      );
      assert.ok(
        f.state.packagePurposes.every(
          (item) =>
            item.purpose === (item.pluginId === f.sourceId ? "read" : "submit"),
        ),
      );
      const accepted = f.nodeState.accepted[0]!;
      const submission = f.state.submissions[0]!;
      const context = f.state.lastContext!;
      assert.ok(context);
      assert.deepEqual(output, {
        disposition: "committed",
        threadId: accepted.binding.threadId,
        threadRevision: accepted.turn.threadState.revision,
        runId: accepted.binding.runId,
        messageId: accepted.turn.messages[0]!.messageId,
        configurationRevision: accepted.binding.configurationRevision,
      });
      assert.equal(context.package.pluginId, f.sourceId);
      assert.equal(context.package.packageDigest, f.source.packageDigest);
      assert.equal(context.lease, f.lease);
      assert.equal(context.action, generationAction);
      assert.deepEqual(context.input, f.request);
      assert.deepEqual(submission.actor, context.actor);
      assert.equal(submission.sourcePin.pluginId, context.package.pluginId);
      assert.equal(
        submission.sourcePin.packageDigest,
        context.package.packageDigest,
      );
      assert.equal(
        submission.sourcePin.selectionRevision,
        context.selection.revision,
      );
      assert.equal(submission.sourcePin.authorityEpoch, context.authorityEpoch);
      assert.equal(submission.sourcePin.authorityEpoch, f.state.sourceEpoch);
      assert.equal(submission.executionPin.pluginId, scope.pluginId);
      assert.equal(
        submission.executionPin.packageDigest,
        f.installed.packageDigest,
      );
      assert.equal(
        submission.executionPin.selectionRevision,
        f.installed.selection.revision,
      );
      assert.equal(submission.executionPin.authorityEpoch, f.state.targetEpoch);
      assert.notEqual(
        submission.sourcePin.pluginId,
        submission.executionPin.pluginId,
      );
      assert.deepEqual(submission.command.intent, {
        kind: "generate",
        input: { prompt: savedPrompt },
      });
      assert.notEqual(
        submission.command.idempotencyKey,
        f.request.idempotencyKey,
      );
      assert.deepEqual(submission.reference, f.reference);
      const admission = await f.first.store.loadPluginTaskAdmission(
        accepted.binding,
      );
      assert.ok(admission);
      assert.equal(admission.pluginId, scope.pluginId);
      assert.equal(admission.packageDigest, f.installed.packageDigest);
      assert.equal(admission.authorityEpoch, f.state.targetEpoch);
      assert.equal(admission.principalId, actor.principalId);
      const loaded = await f.first.store.loadProjectGenerationLink(
        accepted.binding,
      );
      assert.ok(loaded);
      const link = parseProjectGenerationLink(loaded, extensionStoreDigester);
      assert.deepEqual(link.reference, f.reference);
      assert.deepEqual(link.binding, accepted.binding);
      assert.equal(link.ownerPrincipalId, actor.principalId);
      assert.equal(
        link.assetContentDigest,
        f.concept.assetRevision.contentDigest,
      );
      assert.equal(
        link.briefContentDigest,
        f.concept.assetRevision.briefContentDigest,
      );
      assert.equal(link.receipt.idempotencyKey, admission.idempotencyKey);
      assert.equal(link.receipt.requestDigest, admission.requestDigest);
      const receipt = await f.first.store.loadExtensionTurnReceipt({
        ...scope,
        receipt: link.receipt,
      });
      assert.deepEqual(receipt, {
        ...accepted,
        run: { ...accepted.run, disposition: "replayed" },
        turn: { ...accepted.turn, disposition: "replayed" },
      });
      const after = await f.counts();
      for (const table of Object.keys(before))
        assert.equal(after[table], before[table]! + 1, table);
      for (const [pluginId, digest, revision] of [
        [
          f.sourceId,
          f.source.packageDigest,
          f.sourceEnabled.selection.revision,
        ],
        [
          scope.pluginId,
          f.installed.packageDigest,
          f.installed.selection.revision,
        ],
      ] as const) {
        const checks = f.state.permissions.filter(
          (entry) =>
            entry.action === "invoke" && entry.resource.pluginId === pluginId,
        );
        assert.ok(checks.length >= 3);
        for (const entry of checks) {
          assert.deepEqual(entry.actor, actor);
          assert.equal(entry.resource.packageDigest, digest);
          assert.equal(entry.resource.selectionRevision, revision);
          assert.equal(entry.resource.contributionId, "workbench");
          assert.equal(entry.resource.profileId, f.profile.profileId);
        }
      }
      const account = await f.credits.getAccount(creditScope);
      assert.equal(account?.availableCredits, "70");
      assert.equal(account?.reservedCredits, "30");
      assert.equal(f.nodeState.quoteCalls, 1);
      assert.equal(f.nodeState.setups, 1);
      assert.equal(f.nodeState.calls, 1);
      assert.equal(f.nodeState.disposals, 1);
      assert.equal(f.nodeState.execution, undefined);
      const replayed = await f.invoke();
      assert.deepEqual(replayed, {
        ...(output as object),
        disposition: "replayed",
      });
      assert.deepEqual(await f.counts(), after);
      assert.deepEqual(await f.credits.getAccount(creditScope), account);
      assert.equal(f.nodeState.quoteCalls, 1);
      assert.equal(f.nodeState.setups, 2);
      assert.equal(f.nodeState.calls, 2);
      assert.equal(f.nodeState.disposals, 2);
      assert.equal(f.state.requestSignalCalls, 2);
      assert.equal(await f.count("run_snapshots"), 1);
    },
  );

  test(
    `${backend} same-package generation does not substitute source read for target execution permission`,
    options,
    async (t) => {
      const f = await installedGenerationFixture(t, backend, {
        samePackage: true,
      });
      assert.equal(f.sourceId, f.installed.descriptor.pluginId);
      assert.equal(f.source.packageDigest, f.installed.packageDigest);
      f.state.targetPackageAllowed = false;
      const before = await f.counts(),
        account = await f.credits.getAccount(creditScope);
      await assert.rejects(
        f.invoke(),
        /project_generation_execution_package_denied/,
      );
      assert.deepEqual(f.state.packagePurposes.slice(0, 2), [
        { pluginId: f.sourceId, purpose: "read" },
        { pluginId: f.sourceId, purpose: "submit" },
      ]);
      assert.deepEqual(await f.counts(), before);
      assert.deepEqual(await f.credits.getAccount(creditScope), account);
      assert.equal(f.nodeState.setups, 0);
      assert.equal(f.nodeState.calls, 0);
      assert.equal(f.nodeState.quoteCalls, 0);
    },
  );

  for (const denied of ["source-read", "target-submit"] as const)
    test(
      `${backend} generation rejects missing ${denied} permission before opening execution Node`,
      options,
      async (t) => {
        const f = await installedGenerationFixture(t, backend);
        if (denied === "source-read") f.state.sourcePackageAllowed = false;
        else f.state.targetPackageAllowed = false;
        const before = await f.counts(),
          account = await f.credits.getAccount(creditScope);
        await assert.rejects(
          f.invoke(),
          /project_generation_execution_package_denied/,
        );
        assert.deepEqual(await f.counts(), before);
        assert.deepEqual(await f.credits.getAccount(creditScope), account);
        assert.equal(f.nodeState.calls, 0);
        assert.equal(f.nodeState.setups, 0);
        assert.equal(f.nodeState.quoteCalls, 0);
        assert.equal(f.state.submissions.length, 0);
      },
    );

  for (const change of [
    "source-policy",
    "target-policy",
    "source-package",
    "target-package",
    "source-selection",
    "target-selection",
    "mount-close",
    "owner-close",
    "request-abort",
  ] as const) {
    test(
      `${backend} real project generation rolls back when ${change} happens during actual pricing`,
      options,
      async (t) => {
        const f = await installedGenerationFixture(t, backend);
        const entered = deferred(),
          release = deferred();
        f.nodeState.quoteEntered = entered.resolve;
        f.nodeState.quoteGate = release.promise;
        const before = await f.counts();
        const account = await f.credits.getAccount(creditScope);
        const invoking = f.invoke();
        void invoking.catch(() => {});
        await entered.promise;
        let closing: Promise<void> | undefined;
        switch (change) {
          case "source-policy":
            f.state.sourceEpoch = "source-policy-revoked";
            break;
          case "target-policy":
            f.state.targetDenied = true;
            break;
          case "source-package":
            f.state.sourcePackageAllowed = false;
            break;
          case "target-package":
            f.state.targetPackageAllowed = false;
            break;
          case "source-selection":
            await f.selection("source");
            break;
          case "target-selection":
            await f.selection("target");
            break;
          case "mount-close":
            await f.service.closeMount(actor, { mountRef: f.lease.mountRef });
            break;
          case "owner-close":
            closing = f.owner.close();
            break;
          case "request-abort":
            f.state.request.abort(new Error("actual-request-aborted"));
            break;
        }
        release.resolve();
        await assert.rejects(invoking);
        await closing;
        assert.deepEqual(await f.counts(), before);
        assert.deepEqual(await f.credits.getAccount(creditScope), account);
        assert.equal(f.nodeState.accepted.length, 0);
        assert.equal(f.nodeState.quoteCalls, 1);
        assert.equal(f.nodeState.setups, 1);
        assert.equal(f.nodeState.disposals, 1);
      },
    );
  }

  test(
    `${backend} original opaque generation acknowledgement survives actual post-COMMIT mount/owner/request withdrawal and saved metadata changes`,
    options,
    async (t) => {
      const f = await installedGenerationFixture(t, backend);
      let closing: Promise<void> | undefined;
      f.nodeState.afterCommit = async () => {
        assert.equal(await f.count("creative_project_generation_links"), 1);
        const brief = await f.projectService.appendBrief(actor, {
          projectId: f.reference.projectId,
          expectedProjectRevision: f.concept.project.revision,
          text: "A different brief saved after the original generation committed.",
          idempotencyKey: "after-commit-brief",
        });
        await f.projectService.setProjectState(actor, {
          projectId: f.reference.projectId,
          expectedProjectRevision: brief.project.revision,
          state: "archived",
          idempotencyKey: "after-commit-archive",
        });
        await f.selection("source", "uninstalled");
        await f.selection("target", "uninstalled");
        await f.service.closeMount(actor, { mountRef: f.lease.mountRef });
        f.state.sourceDenied = true;
        f.state.targetDenied = true;
        f.state.request.abort(new Error("request-ended-after-commit"));
        // Do not await the owner joining its own current dispatch until that acknowledgement returns.
        closing = f.owner.close();
      };
      const output = await f.invoke();
      await closing;
      assert.equal(
        (output as { disposition: string }).disposition,
        "committed",
      );
      assert.equal(f.nodeState.accepted.length, 1);
      assert.equal(await f.count("run_snapshots"), 1);
      assert.equal(await f.count("creative_project_generation_links"), 1);
      assert.equal(f.nodeState.disposals, 1);
      assert.equal(
        (await f.credits.getAccount(creditScope))?.reservedCredits,
        "30",
      );
      assert.throws(
        () =>
          assertPluginUiHostServiceAvailability({
            scope: f.profile,
            candidate: {
              descriptor: f.source.descriptor,
              packageDigest: f.source.packageDigest,
            },
            hostUiServices: f.owner.hostUiServices,
          }),
        /plugin_dependency_unavailable/u,
      );
      await assert.rejects(f.invoke(), /plugin_ui_mount_unavailable/u);
    },
  );
}

test("actual source context cannot be copied, replayed after invocation, or used for an unknown reserved generation action", async (t) => {
  const f = await installedGenerationFixture(t);
  const before = await f.counts();
  await assert.rejects(
    f.invoke(f.request, "crewon.project-generations.v1.unknown"),
    /plugin_project_generation_action_invalid/u,
  );
  assert.equal(f.nodeState.setups, 0);
  assert.equal(f.nodeState.quoteCalls, 0);
  assert.deepEqual(await f.counts(), before);
  await f.invoke();
  const context = f.state.lastContext!;
  await assert.rejects(
    f.owner.actions.invoke({ ...context } as PluginUiActionContext),
    /plugin_ui_invocation_unavailable/u,
  );
  await assert.rejects(
    f.owner.actions.invoke(context),
    /plugin_ui_invocation_unavailable/u,
  );
  assert.equal(f.nodeState.setups, 1);
  assert.equal(f.nodeState.quoteCalls, 1);
});

test("generation owner rejects mismatched real task/issuer ownership and unapproved issuer mappings before execution or paid effects", async (t) => {
  const f = await installedGenerationFixture(t);
  const another = await installedGenerationFixture(t);
  const before = await f.counts();
  const unconfigured = new PluginUiCommittedTaskAuthority({
    extensions: f.first.store,
    runs: f.first.parent,
    digester: extensionStoreDigester,
  });
  const alternateIssuer = new PluginUiCommittedTaskAuthority({
    extensions: f.first.store,
    runs: f.first.parent,
    digester: extensionStoreDigester,
    projectGenerations: { publications: [f.publication], projects: f.projects },
  });
  const cases = [
    {
      ...f.dependencies,
      tasks: new ExtensionTaskApplicationService(f.taskInputs),
    },
    { ...f.dependencies, committedTasks: alternateIssuer },
    { ...f.dependencies, taskOwner: another.taskOwner },
  ];
  for (const dependencies of cases)
    assert.throws(
      () => new InstalledPluginProjectGenerationOwner(dependencies),
      /installed_plugin_project_generation_configuration_invalid/u,
    );
  const mismatchedPublications = [
    {
      ...f.publication,
      source: { ...f.publication.source, contributionId: "other-workbench" },
    },
    {
      ...f.publication,
      target: { ...f.publication.target, action: "image.other" },
    },
  ];
  const issuers = [
    unconfigured,
    ...mismatchedPublications.map(
      (publication) =>
        new PluginUiCommittedTaskAuthority({
          extensions: f.first.store,
          runs: f.first.parent,
          digester: extensionStoreDigester,
          projectGenerations: {
            publications: [publication],
            projects: f.projects,
          },
        }),
    ),
  ];
  for (const committedTasks of issuers) {
    const taskOwner = new InstalledPluginTaskActionOwner({
      ...f.dependencies,
      tasks: f.tasks,
      committedTasks,
    });
    t.after(() => taskOwner.close());
    assert.throws(
      () =>
        new InstalledPluginProjectGenerationOwner({
          ...f.dependencies,
          taskOwner,
          committedTasks,
        }),
      /installed_plugin_project_generation_configuration_invalid/u,
    );
  }
  assert.equal(f.nodeState.setups, 0);
  assert.equal(f.nodeState.quoteCalls, 0);
  assert.equal(f.nodeState.accepted.length, 0);
  assert.deepEqual(await f.counts(), before);
  assert.equal(extensionCanonicalJson(f.state.submissions), "[]");
});
