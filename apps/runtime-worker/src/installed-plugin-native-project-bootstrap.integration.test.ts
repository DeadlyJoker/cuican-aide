import assert from "node:assert/strict";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parsePluginPackageDescriptor } from "@crewon/contracts/plugins";
import {
  parseInstalledPluginPackage,
  parsePluginSelection,
} from "@crewon/domain";
import {
  assertDesktopPluginBootstrapIssued,
  parseDesktopPluginApproval,
  prepareDesktopPluginBootstrap,
  type DesktopPluginBootstrap,
} from "../../crewon-ui/electron/desktopPluginBootstrap.ts";
import {
  captureDesktopNativePluginPolicy,
  createDesktopNativePluginAuthority,
} from "../../crewon-ui/electron/desktopNativePluginAuthority.ts";
import { composeDesktopLocalPluginProjectApproval } from "../../crewon-ui/electron/desktopLocalPluginProjectApproval.ts";
import { executionSetupFixture } from "../../crewon-ui/electron/desktopLocalPluginExecutionSetup.test-support.ts";
import { loadInstalledPluginAuthorityConfig } from "./plugins/installed-plugin-authority-config.ts";
import { createInstalledPluginWorkerAuthority } from "./plugins/installed-plugin-worker-authority.ts";
import {
  nativeActor,
  nativeAuthorityFixture,
  nativeDigest,
} from "./installed-plugin-native-authority.test-support.ts";

/** Real Main policy/bootstrap/authority producers and Worker reader; no Node entry is imported. */
function openFromMain(
  dataDirectory: string,
  bootstrap: DesktopPluginBootstrap,
) {
  const policy = captureDesktopNativePluginPolicy(dataDirectory, bootstrap);
  assert.ok(policy);
  const main = createDesktopNativePluginAuthority({
    dataDirectory,
    bootstrap,
    policy,
  });
  const path = join(dataDirectory, "worker-native-project-test.json");
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: "crewon.installed-plugin-native-worker.v1",
      installRoot: main.authority.installRoot,
      releaseDocumentPath: join(dataDirectory, "not-yet-prepared-release.json"),
      nativeAuthorityPath: main.path,
      historicalScope: null,
      timeoutMs: 1000,
    }),
    { mode: 0o600 },
  );
  try {
    const config = loadInstalledPluginAuthorityConfig(path, {});
    const worker = createInstalledPluginWorkerAuthority(config);
    return {
      main,
      worker,
      config,
      async close() {
        await worker.close();
        main.close();
      },
    };
  } catch (error) {
    main.close();
    throw error;
  }
}

test("original Settings metadata approval → first policy commit → real Main v2 bootstrap starts Native Worker without execution mappings or enabling", async (t) => {
  const f = await executionSetupFixture({
    version: "16.0.0",
    projectContext: true,
  });
  t.after(() => f.cleanup());
  const approval = composeDesktopLocalPluginProjectApproval({
    approval: parseDesktopPluginApproval(f.approval),
    descriptor: f.installed.descriptor,
    packageDigest: f.identity.packageDigest,
  });
  assert.equal(approval.schemaVersion, "crewon.desktop-plugin-approval.v2");
  await f.stop();
  writeFileSync(f.approvalPath, JSON.stringify(approval), { mode: 0o600 });
  await f.start();
  const setup = f.create();
  const preview = await setup.preview({
    bootstrap: f.bootstrap,
    pluginId: f.identity.pluginId,
  });
  const claim = setup.claimPreview({
    previewId: preview.previewId,
    approveExecution: true,
  });
  await f.stop();
  await setup.commitPolicyWhileStopped(claim);
  await f.start();
  assert.equal(setup.policyCommitted(claim), true);
  const manifest = assertDesktopPluginBootstrapIssued(f.bootstrap);
  assert.equal(manifest.schemaVersion, "crewon.desktop-plugin-bootstrap.v2");
  assert.ok("projects" in manifest);
  assert.equal(manifest.projects.version, "crewon.desktop-project-history.v1");
  assert.equal(Object.hasOwn(manifest.projects, "pluginGenerations"), false);
  assert.equal(Object.hasOwn(manifest.projects, "pluginQueries"), false);
  const native = openFromMain(f.dataDirectory, f.bootstrap);
  try {
    assert.deepEqual(
      await native.worker.resolveProfile(
        nativeActor,
        new AbortController().signal,
      ),
      f.scope,
    );
    assert.ok(native.worker.installedPluginExecution.projectTools);
    assert.equal(
      await native.worker.authorizeRead(
        { identity: f.identity, scope: f.scope, purpose: "read" },
        new AbortController().signal,
      ),
      "allow",
    );
    assert.equal(
      await native.worker.installedPluginExecution.authorizePackage(
        {
          candidate: {
            descriptor: f.installed.descriptor,
            packageDigest: f.identity.packageDigest,
          },
          scope: f.scope,
          purpose: "submit",
        },
        new AbortController().signal,
      ),
      "deny",
    );
    assert.deepEqual(
      await f.store
        .pluginInstallationStore()
        .loadSelection({ scope: f.scope, pluginId: f.identity.pluginId }),
      f.installedSelection,
    );
  } finally {
    await native.close();
  }
});

test("genuine Main v3 preserves old UI-only Short11 → Krea1 mapping without granting the source any Node package permission", async (t) => {
  const f = await nativeAuthorityFixture(t, {
    identity: {
      pluginId: "crewon.comfyui-krea2",
      publisherId: "crewon",
      version: "1.0.0",
      packageDigest: nativeDigest("named-old-krea1-installed-package"),
    },
  });
  await f.authority.close();
  await f.bootstrap.cleanup();
  const sourceIdentity = {
    pluginId: "crewon.short-drama",
    publisherId: "crewon",
    version: "11.0.0",
    packageDigest: nativeDigest("named-old-ui-only-short11-package"),
  };
  const source = {
    pluginId: sourceIdentity.pluginId,
    packageDigest: sourceIdentity.packageDigest,
    contributionId: "workbench",
  };
  const target = {
    pluginId: f.identity.pluginId,
    packageDigest: f.identity.packageDigest,
    contributionId: "studio",
  };
  const mappings = {
    publications: [{ source, target: { ...target, action: "image.generate" } }],
  };
  const previous = JSON.parse(readFileSync(f.approvalPath, "utf8"));
  const approval = parseDesktopPluginApproval({
    ...previous,
    schemaVersion: "crewon.desktop-plugin-approval.v3",
    sources: [
      ...previous.sources,
      {
        ...sourceIdentity,
        sourceId: "old-short-ui",
        directory: join(f.directory, "old-short-ui"),
      },
    ],
    publications: [
      {
        pluginId: sourceIdentity.pluginId,
        publisherId: sourceIdentity.publisherId,
        packageDigest: sourceIdentity.packageDigest,
        publicAssets: ["ui.mjs"],
      },
    ],
    projects: {
      version: "crewon.desktop-project-execution.v1",
      pluginUi: { publications: [source] },
      generationReads: { version: "crewon.project-generation-read.v1" },
      pluginGenerations: mappings,
      pluginQueries: {
        publications: [
          { source, target: { ...target, action: "image.query" } },
        ],
      },
    },
  });
  writeFileSync(f.approvalPath, JSON.stringify(approval), { mode: 0o600 });
  const bootstrap = await prepareDesktopPluginBootstrap({
    dataDirectory: f.directory,
    actor: nativeActor,
    sessionEntropy: nativeDigest("old-v3-bootstrap-cold-session"),
  });
  assert.ok(bootstrap);
  try {
    const manifest = assertDesktopPluginBootstrapIssued(bootstrap);
    assert.equal(manifest.schemaVersion, "crewon.desktop-plugin-bootstrap.v3");
    assert.ok(
      "projects" in manifest && "pluginGenerations" in manifest.projects,
    );
    assert.deepEqual(manifest.projects.pluginGenerations, mappings);
    const installed = await f.store
      .pluginInstallationStore()
      .recordInstalledPackage({
        scope: f.scope,
        actor: nativeActor,
        package: parseInstalledPluginPackage({
          schemaVersion: "crewon.installed-plugin-package.v1",
          ...f.scope,
          ...sourceIdentity,
          installedAt: "2026-10-06T00:00:00.000Z",
          installedByPrincipalId: nativeActor.principalId,
          installedByActorId: nativeActor.actorId,
        }),
        expectedSelectionRevision: null,
        receipt: {
          idempotencyKey: "old-ui-install",
          requestDigest: nativeDigest("old-ui-install"),
        },
      });
    const selected = parsePluginSelection({
      ...installed.selection,
      state: "enabled",
      revision: installed.selection.revision + 1,
    });
    await f.store.pluginInstallationStore().commitSelection({
      scope: f.scope,
      actor: nativeActor,
      selection: selected,
      expectedSelectionRevision: installed.selection.revision,
      receipt: {
        idempotencyKey: "old-ui-enable",
        requestDigest: nativeDigest("old-ui-enable"),
      },
    });
    await f.select("enabled");
    const native = openFromMain(f.directory, bootstrap);
    try {
      assert.deepEqual(native.main.authority.packages, [f.identity]);
      assert.equal(
        native.worker.installedPluginExecution.projectTools,
        undefined,
      );
      assert.equal(
        await native.worker.authorizeRead(
          { identity: f.identity, scope: f.scope, purpose: "read" },
          f.signal,
        ),
        "allow",
      );
      assert.equal(
        await native.worker.authorizeRead(
          { identity: sourceIdentity, scope: f.scope, purpose: "read" },
          f.signal,
        ),
        "deny",
      );
      const descriptor = parsePluginPackageDescriptor({
        schemaVersion: "crewon.plugin-package.v1",
        hostApi: "crewon.plugin-host.v1",
        pluginId: sourceIdentity.pluginId,
        publisherId: sourceIdentity.publisherId,
        version: sourceIdentity.version,
        title: "Named historical UI-only package",
        description: "No Node entry or business execution.",
        entrypoints: {
          node: null,
          ui: { path: "ui.mjs", mode: "trustedModule" },
        },
        businessManifestPath: null,
        requires: [],
        provides: [],
        contributions: [
          {
            id: "workbench",
            kind: "module",
            title: "Named historical workbench",
            slot: "main.content",
          },
        ],
        files: [
          { path: "ui.mjs", byteLength: 1, sha256: nativeDigest("x").slice(7) },
        ],
      });
      assert.equal(
        await native.worker.installedPluginExecution.authorizePackage(
          {
            candidate: {
              descriptor,
              packageDigest: sourceIdentity.packageDigest,
            },
            scope: f.scope,
            purpose: "submit",
          },
          f.signal,
        ),
        "deny",
      );
    } finally {
      await native.close();
    }
  } finally {
    await bootstrap.cleanup();
  }
});

test("Native v2 requires its matching history version and real bootstrap publications; it never falls back to Node packages", async (t) => {
  for (const kind of [
    "missing-publications",
    "wrong-project-version",
    "execution-mapping",
  ] as const) {
    await t.test(kind, async (t) => {
      const f = await nativeAuthorityFixture(t);
      await f.authority.close();
      const original = JSON.parse(
        readFileSync(f.bootstrap.bootstrapPath, "utf8"),
      );
      const publication = {
        pluginId: f.identity.pluginId,
        packageDigest: f.identity.packageDigest,
        contributionId: "workbench",
      };
      const corrupted = {
        ...original,
        schemaVersion: "crewon.desktop-plugin-bootstrap.v2",
        projects: {
          version:
            kind === "wrong-project-version"
              ? "crewon.desktop-project-execution.v1"
              : "crewon.desktop-project-history.v1",
          pluginUi: { publications: [publication] },
          ...(kind === "execution-mapping"
            ? {
                pluginGenerations: {
                  publications: [
                    {
                      source: publication,
                      target: { ...publication, action: "image.generate" },
                    },
                  ],
                },
              }
            : {}),
        },
      };
      if (kind !== "missing-publications")
        corrupted.publications = [
          {
            pluginId: f.identity.pluginId,
            packageDigest: f.identity.packageDigest,
          },
        ];
      // Invalid private DTO negative test only; no Main producer can issue these settings.
      writeFileSync(f.bootstrap.bootstrapPath, JSON.stringify(corrupted));
      writeFileSync(
        f.authorityPath,
        JSON.stringify({
          ...f.document,
          bootstrapDigest: nativeDigest(
            readFileSync(f.bootstrap.bootstrapPath),
          ),
        }),
      );
      try {
        assert.throws(
          () =>
            createInstalledPluginWorkerAuthority(
              loadInstalledPluginAuthorityConfig(f.configurationPath, {}),
            ),
          /desktop_project_history_configuration_invalid/u,
        );
      } finally {
        unlinkSync(f.bootstrap.bootstrapPath);
      }
    });
  }
});

test("changed or missing Main bootstrap bytes reject Native capture before project configuration can be used", async (t) => {
  for (const kind of ["changed", "missing"] as const)
    await t.test(kind, async (t) => {
      const f = await nativeAuthorityFixture(t);
      await f.authority.close();
      if (kind === "changed")
        writeFileSync(
          f.bootstrap.bootstrapPath,
          Buffer.concat([
            readFileSync(f.bootstrap.bootstrapPath),
            Buffer.from(" "),
          ]),
        );
      else unlinkSync(f.bootstrap.bootstrapPath);
      try {
        assert.throws(
          () =>
            createInstalledPluginWorkerAuthority(
              loadInstalledPluginAuthorityConfig(f.configurationPath, {}),
            ),
          kind === "changed"
            ? /publication_digest_mismatch/u
            : { code: "ENOENT" },
        );
      } finally {
        if (kind === "changed") unlinkSync(f.bootstrap.bootstrapPath);
      }
    });
});
