import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createExtensionConfiguration,
  parsePluginSelection,
} from "@crewon/domain";
import { installLocalPluginPackage } from "../../../packages/plugin-host/src/local-plugin-package-installer.ts";
import { loadInstalledPluginBusinessRegistration } from "../../../packages/plugin-host/src/installed-plugin-business-registration.ts";
import {
  executionSetupFixture,
  fixtureHash,
} from "./desktopLocalPluginExecutionSetup.test-support.ts";
import { DESKTOP_RUNTIME_OWNER as actor } from "./desktopExtensionRuntime.ts";
import {
  captureSetupSnapshot,
  SHORT_NETWORK_PATHS,
} from "./desktopLocalPluginExecutionSetupSnapshot.ts";
import { composeDesktopLocalComfyProjectExecutionApproval } from "./desktopLocalComfyProjectExecutionApproval.ts";
import { parseDesktopPluginApproval } from "./desktopPluginBootstrap.ts";
import { runDesktopLocalPluginExecutionSetup } from "./desktopLocalPluginExecutionSetup.ts";
import { runRuntimeStoppedMutation } from "./runtimeStoppedMutation.ts";
import type { DesktopInstalledPluginRuntime } from "./desktopInstalledPluginRuntime.ts";
import {
  captureDesktopLocalHistoricalProjectQueryTarget,
  assertDesktopLocalHistoricalProjectQueryTargetCurrent,
  composeDesktopLocalHistoricalProjectQueryApproval,
} from "./desktopLocalHistoricalProjectQueryApproval.ts";

const fixtures: Awaited<ReturnType<typeof executionSetupFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup();
});

/** Real immutable packages, Main private bootstrap and SQLite mutations; runtime entries are named metadata ports, never Node/supplier execution. */
async function fixture() {
  const f = await executionSetupFixture({
    version: "18.0.0",
    projectContext: true,
    historicalQueries: true,
  });
  fixtures.push(f);
  const source = join(f.directory, "original-krea-source");
  mkdirSync(source, { mode: 0o700 });
  const files = new Map([
    [
      "node.mjs",
      Buffer.from(
        "throw new Error('historical_metadata_must_not_import_node')",
      ),
    ],
    [
      "ui.mjs",
      Buffer.from("throw new Error('historical_metadata_must_not_import_ui')"),
    ],
    [
      "business.json",
      readFileSync(
        new URL(
          "../../../examples/plugins/comfyui-krea2/business.json",
          import.meta.url,
        ),
      ),
    ],
  ]);
  for (const [path, bytes] of files) writeFileSync(join(source, path), bytes);
  writeFileSync(
    join(source, "crewon.plugin.json"),
    JSON.stringify({
      schemaVersion: "crewon.plugin-package.v1",
      hostApi: "crewon.plugin-host.v1",
      pluginId: "crewon.comfyui-krea2",
      publisherId: "example.publisher",
      version: "1.0.0",
      title: "Actual historical package metadata",
      description: "Never imports Node or UI",
      entrypoints: {
        node: "node.mjs",
        ui: { path: "ui.mjs", mode: "trustedModule" },
      },
      businessManifestPath: "business.json",
      requires: [
        { service: "crewon.execution", apiVersion: "1", optional: false },
      ],
      provides: [],
      contributions: [
        { id: "studio", kind: "module", title: "Krea", slot: "main.content" },
      ],
      files: [...files].map(([path, bytes]) => ({
        path,
        byteLength: bytes.length,
        sha256: fixtureHash(bytes).slice(7),
      })),
    }),
  );
  const installed = await installLocalPluginPackage({
    directory: source,
    installRoot: join(f.dataDirectory, "plugins"),
    authorization: async () => ({ outcome: "allow" }),
  });
  const identity = {
    pluginId: installed.descriptor.pluginId,
    publisherId: installed.descriptor.publisherId,
    version: installed.descriptor.version,
    packageDigest: installed.packageDigest,
  };
  const result = await f.store
    .pluginInstallationStore()
    .recordInstalledPackage({
      scope: f.scope,
      actor,
      package: {
        schemaVersion: "crewon.installed-plugin-package.v1",
        ...f.scope,
        ...identity,
        installedAt: "2026-10-06T00:00:00.000Z",
        installedByActorId: actor.actorId,
        installedByPrincipalId: actor.principalId,
      },
      expectedSelectionRevision: null,
      receipt: {
        idempotencyKey: "install-original-krea",
        requestDigest: fixtureHash("install-original-krea"),
      },
    });
  const selection = parsePluginSelection({
    ...result.selection,
    revision: 2,
    state: "enabled",
  });
  await f.store.pluginInstallationStore().commitSelection({
    scope: f.scope,
    actor,
    selection,
    expectedSelectionRevision: 1,
    receipt: {
      idempotencyKey: "enable-original-krea",
      requestDigest: fixtureHash("enable-original-krea"),
    },
  });
  const registration = await loadInstalledPluginBusinessRegistration({
    installRoot: join(f.dataDirectory, "plugins"),
    expectedPluginId: identity.pluginId,
    expectedPublisherId: identity.publisherId,
    expectedVersion: identity.version,
    expectedPackageDigest: identity.packageDigest,
    signal: new AbortController().signal,
    authorizeRead: async () => "allow",
  });
  const configuration = createExtensionConfiguration(
    {
      schemaVersion: "crewon.extension-configuration.v0",
      tenantId: f.scope.tenantId,
      spaceId: f.scope.spaceId,
      pluginId: identity.pluginId,
      pluginVersion: identity.version,
      revision: 1,
      manifestDigest: registration.manifestDigest,
      implementationDigest: registration.implementationDigest,
      parameters: { baseUrl: "https://comfy.example:8443/" },
      credentialBindings: [],
      createdByActorId: actor.actorId,
      createdAt: "2026-10-06T00:00:00.000Z",
    },
    { sha256: fixtureHash },
  );
  await f.store.extensionStore().saveExtensionConfiguration({
    configuration,
    expectedRevision: 0,
    receipt: {
      actorId: actor.actorId,
      idempotencyKey: "save-original-krea",
      requestDigest: fixtureHash("save-original-krea"),
    },
  });
  const entry = {
    identity: {
      ...identity,
      manifestDigest: registration.manifestDigest,
      implementationDigest: registration.implementationDigest,
    },
    configuration,
    configuredTarget: {
      ...f.entry.configuredTarget,
      agentVersionId: "original-krea-release",
    },
  } as unknown as DesktopInstalledPluginRuntime["expectedCatalogEntries"][number];
  const approval = {
    ...f.approval,
    sources: [
      ...f.approval.sources,
      { ...identity, sourceId: "original-krea", directory: source },
    ],
    publications: [
      ...f.approval.publications,
      {
        pluginId: identity.pluginId,
        publisherId: identity.publisherId,
        packageDigest: identity.packageDigest,
        publicAssets: ["ui.mjs"],
      },
    ],
  };
  const policy = {
    schemaVersion: "crewon.desktop-native-plugin-policy.v1",
    packages: [{ ...identity, approvalRequirement: "none" }],
    networkGrants: [
      {
        ...identity,
        baseUrl: "https://comfy.example:8443/",
        baseUrlParameter: "baseUrl",
        paths: SHORT_NETWORK_PATHS,
      },
    ],
  };
  await f.stop();
  writeFileSync(f.approvalPath, JSON.stringify(approval), { mode: 0o600 });
  writeFileSync(f.policyPath, JSON.stringify(policy), { mode: 0o600 });
  await f.start();
  const runtime = () => {
    const original = f.fakePreparedRuntime();
    return Object.freeze({
      ...original,
      expectedCatalogEntries: [f.entry, entry],
      assertCurrent: original.assertCurrent.bind(original),
    }) as DesktopInstalledPluginRuntime;
  };
  const disable = () =>
    f.store.pluginInstallationStore().commitSelection({
      scope: f.scope,
      actor,
      expectedSelectionRevision: 2,
      selection: parsePluginSelection({
        ...selection,
        revision: 3,
        state: "disabled",
      }),
      receipt: {
        idempotencyKey: "disable-original-krea",
        requestDigest: fixtureHash("disable-original-krea"),
      },
    });
  return { f, identity, entry, selection, configuration, runtime, disable };
}

describe("explicit query-only historical Main approval", () => {
  it("a fresh optional declaration without Krea can prepare self capabilities but issues no historical grant", async () => {
    const f = await executionSetupFixture({
      version: "18.0.0",
      projectContext: true,
      historicalQueries: true,
    });
    fixtures.push(f);
    const owner = f.create(),
      preview = await owner.preview({
        bootstrap: f.bootstrap,
        pluginId: f.identity.pluginId,
      });
    expect(preview.historyQueryAvailability).toBe("unavailable");
    expect(Object.hasOwn(preview, "historyQuery")).toBe(false);
    expect(() =>
      owner.claimPreview({
        previewId: preview.previewId,
        approveExecution: true,
        approveHistoricalQueries: true,
      }),
    ).toThrow();
    const claim = owner.claimPreview({
      previewId: preview.previewId,
      approveExecution: true,
    });
    const result = await runDesktopLocalPluginExecutionSetup(
      { owner, claim, onStopInvalidation: (stop) => stop() },
      {
        mutateWhileStopped: (options) =>
          runRuntimeStoppedMutation(options, {
            stop: () => f.stop(),
            start: () => f.start(),
            assertReady() {},
          }),
        preparedRuntime: () => f.fakePreparedRuntime(),
      },
    );
    expect(result.state).toBe("prepared");
    const approval = parseDesktopPluginApproval(
      JSON.parse(readFileSync(f.approvalPath, "utf8")),
    );
    expect(
      approval.schemaVersion === "crewon.desktop-plugin-approval.v3" &&
        Object.hasOwn(approval.projects, "historicalQueries"),
    ).toBe(false);
  });
  it("optional availability never hides a corrupted prepared identity or duplicate target", async () => {
    const { f, runtime, entry } = await fixture();
    for (const entries of [
      [
        f.entry,
        {
          ...entry,
          identity: { ...entry.identity, manifestDigest: fixtureHash("wrong") },
        },
      ],
      [f.entry, entry, entry],
    ]) {
      const actual = runtime();
      const mismatched = {
        ...actual,
        expectedCatalogEntries: entries,
      } as DesktopInstalledPluginRuntime;
      await expect(
        f.create().preview({
          bootstrap: f.bootstrap,
          pluginId: f.identity.pluginId,
          runtime: mismatched,
        }),
      ).rejects.toThrow(/target_(identity_mismatch|ambiguous)/);
    }
  });
  it("adds a separate exact historical target after stop while preserving the primary self mapping, selection and original policy", async () => {
    const { f, identity, entry, selection, runtime } = await fixture();
    const owner = f.create(),
      preview = await owner.preview({
        bootstrap: f.bootstrap,
        runtime: runtime(),
        pluginId: f.identity.pluginId,
      });
    expect(preview.historyQuery).toMatchObject({
      target: {
        ...entry.identity,
        contributionId: "studio",
        action: "image.query",
      },
      selectionRevision: 2,
      configurationRevision: 1,
      scope: "query-existing-generations",
      methods: ["GET"],
    });
    expect(() =>
      owner.claimPreview({
        previewId: preview.previewId,
        approveExecution: true,
      }),
    ).toThrow();
    const claim = owner.claimPreview({
      previewId: preview.previewId,
      approveExecution: true,
      approveHistoricalQueries: true,
    });
    const events: string[] = [];
    const result = await runDesktopLocalPluginExecutionSetup(
      { owner, claim, onStopInvalidation: (stop) => stop() },
      {
        mutateWhileStopped: (options) =>
          runRuntimeStoppedMutation(options, {
            stop: async () => {
              events.push("stop");
              await f.stop();
            },
            start: async () => {
              events.push("start");
              await f.start();
            },
            assertReady() {},
          }),
        preparedRuntime() {
          events.push("capture");
          return runtime();
        },
      },
    );
    expect(result.state).toBe("prepared");
    expect(events).toEqual([
      "stop",
      "start",
      "capture",
      "stop",
      "start",
      "capture",
    ]);
    const approval = parseDesktopPluginApproval(
      JSON.parse(readFileSync(f.approvalPath, "utf8")),
    );
    expect(approval.schemaVersion).toBe("crewon.desktop-plugin-approval.v3");
    if (approval.schemaVersion !== "crewon.desktop-plugin-approval.v3")
      throw new Error("not-v3");
    expect(approval.projects.historicalQueries?.publications).toEqual([
      {
        source: {
          pluginId: f.identity.pluginId,
          packageDigest: f.identity.packageDigest,
          contributionId: "workbench",
        },
        target: {
          ...entry.identity,
          contributionId: "studio",
          action: "image.query",
        },
      },
    ]);
    expect(
      approval.projects.pluginQueries?.publications[0]?.target.pluginId,
    ).toBe(f.identity.pluginId);
    expect(
      approval.projects.pluginGenerations?.publications[0]?.target.pluginId,
    ).toBe(f.identity.pluginId);
    expect(
      await f.store
        .pluginInstallationStore()
        .loadSelection({ scope: f.scope, pluginId: identity.pluginId }),
    ).toEqual(selection);
    expect(
      await f.store
        .pluginInstallationStore()
        .loadSelection({ scope: f.scope, pluginId: f.identity.pluginId }),
    ).toEqual(f.installedSelection);
    const policy = JSON.parse(readFileSync(f.policyPath, "utf8"));
    expect(
      policy.packages.find(
        (p: { pluginId: string }) => p.pluginId === identity.pluginId,
      ),
    ).toEqual({ ...identity, approvalRequirement: "none" });
    expect(
      policy.networkGrants.filter(
        (p: { pluginId: string }) => p.pluginId === identity.pluginId,
      ),
    ).toHaveLength(1);
  });
  it("requires a real live prepared target, refuses copied claims and never asserts its old withdrawn runtime after stop", async () => {
    const { f, runtime } = await fixture();
    const controller = new AbortController();
    const snapshot = await captureSetupSnapshot({
      dataDirectory: f.dataDirectory,
      bootstrap: f.bootstrap,
      signal: controller.signal,
      assertCurrent() {},
    });
    const input = {
      dataDirectory: f.dataDirectory,
      bootstrap: f.bootstrap,
      snapshot,
      signal: controller.signal,
      assertCurrent() {},
    };
    await expect(
      captureDesktopLocalHistoricalProjectQueryTarget({
        ...input,
        runtime: null,
      }),
    ).rejects.toThrow("target_unavailable");
    await expect(
      captureDesktopLocalHistoricalProjectQueryTarget({
        ...input,
        runtime: f.fakePreparedRuntime(),
      }),
    ).rejects.toThrow("target_unprepared");
    const { claim } = await captureDesktopLocalHistoricalProjectQueryTarget({
      ...input,
      runtime: runtime(),
    });
    await expect(
      assertDesktopLocalHistoricalProjectQueryTargetCurrent(
        { ...claim },
        { approval: snapshot.approval, policy: snapshot.policy },
      ),
    ).rejects.toThrow("claim_invalid");
    const self = composeDesktopLocalComfyProjectExecutionApproval({
      approval: snapshot.approval,
      source: {
        descriptor: snapshot.descriptor,
        packageDigest: f.identity.packageDigest,
        contributionId: "workbench",
      },
      target: {
        descriptor: snapshot.descriptor,
        contributionId: "workbench",
        entry: f.entry,
      },
    });
    const oldRuntime = runtime();
    await f.stop();
    expect(() => oldRuntime.assertCurrent()).toThrow("runtime_withdrawn");
    const next = composeDesktopLocalHistoricalProjectQueryApproval({
      claim,
      approval: self,
      policy: snapshot.policy,
    });
    expect(
      composeDesktopLocalHistoricalProjectQueryApproval({
        claim,
        approval: next,
        policy: snapshot.policy,
      }),
    ).toEqual(next);
    controller.abort();
    expect(() =>
      composeDesktopLocalHistoricalProjectQueryApproval({
        claim,
        approval: self,
        policy: snapshot.policy,
      }),
    ).toThrow();
  });
  it("rejects target drift before policy writes and reports a preserved first-stage commit if drift occurs before mapping", async () => {
    for (const afterPolicy of [false, true]) {
      const { f, runtime, disable } = await fixture();
      const owner = f.create(),
        preview = await owner.preview({
          bootstrap: f.bootstrap,
          runtime: runtime(),
          pluginId: f.identity.pluginId,
        });
      const claim = owner.claimPreview({
        previewId: preview.previewId,
        approveExecution: true,
        approveHistoricalQueries: true,
      });
      if (afterPolicy) {
        await f.stop();
        await owner.commitPolicyWhileStopped(claim);
        await f.start();
      }
      await disable();
      if (afterPolicy)
        await expect(
          owner.captureProjectMappingWhileRunning(claim, runtime()),
        ).rejects.toThrow("target_unavailable");
      else
        await expect(owner.commitPolicyWhileStopped(claim)).rejects.toThrow(
          "target_unavailable",
        );
      expect(owner.policyCommitted(claim)).toBe(afterPolicy);
      expect(
        parseDesktopPluginApproval(
          JSON.parse(readFileSync(f.approvalPath, "utf8")),
        ).schemaVersion,
      ).toBe("crewon.desktop-plugin-approval.v1");
    }
  });
  it("a newly saved target configuration cannot be silently substituted after explicit consent", async () => {
    const { f, runtime, configuration } = await fixture();
    const owner = f.create(),
      preview = await owner.preview({
        bootstrap: f.bootstrap,
        pluginId: f.identity.pluginId,
        runtime: runtime(),
      });
    const claim = owner.claimPreview({
      previewId: preview.previewId,
      approveExecution: true,
      approveHistoricalQueries: true,
    });
    const { contentDigest: _oldDigest, ...old } = configuration;
    const next = createExtensionConfiguration(
      { ...old, revision: 2 },
      { sha256: fixtureHash },
    );
    await f.store
      .extensionStore()
      .saveExtensionConfiguration({
        configuration: next,
        expectedRevision: 1,
        receipt: {
          actorId: actor.actorId,
          idempotencyKey: "new-historical-config",
          requestDigest: fixtureHash("new-historical-config"),
        },
      });
    await expect(owner.commitPolicyWhileStopped(claim)).rejects.toThrow(
      "records_changed",
    );
    expect(owner.policyCommitted(claim)).toBe(false);
  });
});
