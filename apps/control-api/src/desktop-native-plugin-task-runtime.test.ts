import assert from "node:assert/strict";
import { writeFile, stat } from "node:fs/promises";
import test from "node:test";
import { verifyLocalPluginPackage } from "@crewon/plugin-host";
import { SqliteRunStore } from "@crewon/store";
import { activationTarget as target } from "./desktop-installed-plugin-activation.test-support.ts";
import { assertDesktopNativePluginTaskComposition } from "./desktop-native-plugin-task-runtime.ts";
import { installedProjectConversationTaskAuthority } from "./installed-plugin-task-runtime-core.ts";
import {
  actor,
  request,
  sha,
  nativeTaskRuntimeFixture as fixture,
} from "./desktop-native-plugin-task-runtime.test-support.ts";

test(
  "Native multi-model publication activates its prepared default and retains sibling targets without duplicate plugin authority",
  { skip: process.platform === "win32", timeout: 20000 },
  async (t) => {
    const f = await fixture(t, undefined, { modelSiblings: true });
    assert.equal(f.nativeControl.publication.entries.length, 2);
    assert.equal(
      f.nativeControl.publication.entries[0]!.target.agentVersionId,
      target.agentVersionId,
    );
    assert.equal(
      f.nativeControl.publication.entries[1]!.target.agentVersionId,
      "named-second-published-model",
    );
    await assert.rejects(
      () =>
        f.actual.configuration.requests.run(
          { request: request(), actor, preparation: "configuration" },
          () =>
            f.actual.configuration.extensions.setActivation(actor, {
              pluginId: f.source.pluginId,
              configurationRevision:
                f.nativeControl.publication.entries[0]!.configuration.revision,
              expectedRevision: 1,
              idempotencyKey: "cannot-replace-prepared-default-with-sibling",
              state: "enabled",
              agentVersionId: "named-second-published-model",
            }),
        ),
      { code: "extension_execution_target_mismatch" },
    );
    // The same genuine request owner must allow the selected sibling for task
    // readiness, while the activation path above remains pinned to the default.
    await f.actual.configuration.requests.run(
      { request: request(), actor },
      async () => {
        const registration = f.actual.configuration.requests.catalog.resolve({
          pluginId: f.source.pluginId,
          pluginVersion: f.source.version,
        });
        assert.ok(registration);
        for (const entry of f.nativeControl.publication.entries) {
          const result = await f.actual.configuration.requests.host.evaluate({
            actor,
            registration,
            configuration: entry.configuration,
            agentVersionId: entry.target.agentVersionId,
          });
          assert.deepEqual(result, { outcome: "ready", target: entry.target });
        }
        await assert.rejects(
          () =>
            f.actual.configuration.requests.host.evaluate({
              actor,
              registration,
              configuration:
                f.nativeControl.publication.entries[0]!.configuration,
              agentVersionId: "unpublished-model",
            }),
          { code: "extension_execution_target_mismatch" },
        );
      },
    );
    const originalDeployment = f.originalStore.currentAgentVersionDeployment;
    const withdrawn = t.mock.method(
      f.originalStore,
      "currentAgentVersionDeployment",
      function (
        this: SqliteRunStore,
        locator: Parameters<SqliteRunStore["currentAgentVersionDeployment"]>[0],
      ) {
        return locator.agentVersionId === "named-second-published-model"
          ? null
          : originalDeployment.call(this, locator);
      },
    );
    await assert.rejects(
      () =>
        f.actual.configuration.requests.run(
          { request: request(), actor },
          async () => {
            const entry = f.nativeControl.publication.entries[1]!;
            const registration =
              f.actual.configuration.requests.catalog.resolve({
                pluginId: f.source.pluginId,
                pluginVersion: f.source.version,
              });
            assert.ok(registration);
            return f.actual.configuration.requests.host.evaluate({
              actor,
              registration,
              configuration: entry.configuration,
              agentVersionId: entry.target.agentVersionId,
            });
          },
        ),
      { code: "extension_execution_target_mismatch" },
    );
    withdrawn.mock.restore();
    const first = (await f.invoke()) as Record<string, unknown>;
    assert.equal(first.disposition, "committed");
    assert.deepEqual(await f.invoke(), { ...first, disposition: "replayed" });
    assert.equal(f.facts().runs, 1);
    await writeFile(f.policyPath, "{}");
    await assert.rejects(async () => f.invoke());
    assert.equal(f.facts().runs, 1);
  },
);

test(
  "actual local Native task owner commits and replays one original installed task with explicit unmetered provenance and no financial schema",
  { skip: process.platform === "win32", timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    assert.deepEqual(f.facts(), {
      runs: 0,
      admissions: 0,
      unmetered: 0,
      financialTables: [],
    });
    const first = await f.invoke();
    const output = first as Record<string, unknown>;
    assert.equal(output.disposition, "committed");
    assert.deepEqual(f.facts(), {
      runs: 1,
      admissions: 1,
      unmetered: 1,
      financialTables: [],
    });
    const admission = await f.originalStore
      .extensionStore()
      .loadPluginTaskUnmeteredAdmission({
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        runId: String(output.runId),
      });
    assert.ok(admission);
    assert.equal(
      admission.authorization.authorityId,
      "native-actual-file-unmetered-authority",
    );
    const replay = await f.invoke();
    assert.deepEqual(replay, { ...output, disposition: "replayed" });
    assert.deepEqual(f.facts(), {
      runs: 1,
      admissions: 1,
      unmetered: 1,
      financialTables: [],
    });
    assert.ok(f.peerOperations.includes("prepareCandidate"));
    await writeFile(f.policyPath, "{}");
    await assert.rejects(async () => f.invoke());
    assert.deepEqual(f.facts(), {
      runs: 1,
      admissions: 1,
      unmetered: 1,
      financialTables: [],
    });
  },
);

test(
  "retained approved generation/query mappings survive startup, but an unprepared old version cannot import Node or commit a Run",
  { skip: process.platform === "win32", timeout: 20000 },
  async (t) => {
    const f = await fixture(t, "approved");
    assert.ok(f.retained);
    assert.equal(f.nativeControl.authority.packages.length, 2);
    assert.equal(f.nativeControl.publication.entries.length, 1);
    assert.equal(
      f.startup?.creativeProjects?.pluginGenerations?.publications.length,
      2,
    );
    assert.equal(
      f.startup?.creativeProjects?.pluginQueries?.publications.length,
      2,
    );
    assert.ok(f.actual.tasks?.projectGenerations);
    assert.ok(f.actual.tasks?.projectQueries);
    const first = (await f.invoke()) as Record<string, unknown>;
    assert.equal(first.disposition, "committed");
    const before = f.facts();
    assert.equal(before.runs, 1);

    // Exercise the real execution callbacks used by project generation/query
    // owners: retained bytes remain readable, but cannot obtain submit authority.
    const authority = installedProjectConversationTaskAuthority(
      f.actual.tasks!,
    );
    const candidate = await verifyLocalPluginPackage({
      directory: f.retained.directory,
    });
    for (const purpose of ["read", "submit"] as const) {
      const decision = await authority.requests.run(
        { request: request(), actor, preparation: "configuration" },
        () =>
          authority.authorizePackage(
            {
              actor,
              scope: f.scope,
              candidate: {
                descriptor: candidate.descriptor,
                packageDigest: candidate.packageDigest,
              },
              purpose,
            },
            new AbortController().signal,
          ),
      );
      assert.equal(decision, purpose === "read" ? "allow" : "deny");
    }
    // Older clients also cannot enable it against a different prepared package.
    const installed = await f.actual.installation.install(actor, {
      sourceId: f.retained.sourceId,
      expectedPluginId: f.retained.pluginId,
      expectedPackageDigest: f.retained.packageDigest,
      expectedSelectionRevision: 2,
      idempotencyKey: "native-retained-install",
    });
    const peerBefore = [...f.peerOperations];
    await assert.rejects(
      () =>
        f.actual.installation.select(actor, {
          pluginId: f.retained!.pluginId,
          selectedPackageDigest: f.retained!.packageDigest,
          state: "enabled",
          expectedSelectionRevision: installed.selection!.revision,
          idempotencyKey: "native-retained-select",
        }),
      /desktop_plugin_candidate_selection_changed/,
    );
    await assert.rejects(() => stat(f.oldImportMarker), { code: "ENOENT" });
    assert.deepEqual(f.peerOperations, peerBefore);
    assert.deepEqual(f.facts(), before);
    assert.ok(
      await f.originalStore.loadRunInSpace({
        ...actor,
        runId: String(first.runId),
      }),
    );
  },
);

test(
  "retained mappings still require exact native target approval at startup",
  { skip: process.platform === "win32", timeout: 20000 },
  async (t) => {
    await assert.rejects(
      () => fixture(t, "unapproved"),
      /desktop_native_plugin_project_mapping_unapproved/,
    );
  },
);

test(
  "retained mappings cannot introduce an unapproved source or substitute another target digest",
  { skip: process.platform === "win32", timeout: 20000 },
  async (t) => {
    const f = await fixture(t, "approved");
    for (const lane of ["pluginGenerations", "pluginQueries"] as const) {
      for (const side of ["source", "target"] as const) {
        const mapping = f.startup!.creativeProjects![lane]!.publications[0]!;
        assert.throws(
          () =>
            assertDesktopNativePluginTaskComposition({
              configuration: f.bootstrap,
              nativeControl: f.nativeControl,
              creativeProjects: {
                [lane]: {
                  publications: [
                    {
                      ...mapping,
                      [side]: {
                        ...mapping[side],
                        packageDigest: sha.sha256("unapproved-package"),
                      },
                    },
                  ],
                },
              },
            }),
          /desktop_native_plugin_project_mapping_unapproved/,
        );
      }
    }
  },
);
