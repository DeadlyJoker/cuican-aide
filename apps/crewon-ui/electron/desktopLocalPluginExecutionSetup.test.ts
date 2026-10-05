import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createExtensionConfiguration,
  parsePluginSelection,
} from "@crewon/domain";
import { prepareDesktopPluginBootstrap } from "./desktopPluginBootstrap.ts";
import { runRuntimeStoppedMutation } from "./runtimeStoppedMutation.ts";
import {
  executionSetupFixture,
  fixtureHash,
} from "./desktopLocalPluginExecutionSetup.test-support.ts";
import {
  parseDesktopLocalPluginExecutionSetupPluginId,
  runDesktopLocalPluginExecutionSetup,
} from "./desktopLocalPluginExecutionSetup.ts";
import { SHORT_NETWORK_PATHS } from "./desktopLocalPluginExecutionSetupSnapshot.ts";
import { DESKTOP_RUNTIME_OWNER as actor } from "./desktopExtensionRuntime.ts";
const fixtures: Awaited<ReturnType<typeof executionSetupFixture>>[] = [];
async function fixture(options?: Parameters<typeof executionSetupFixture>[0]) {
  const value = await executionSetupFixture(options);
  fixtures.push(value);
  return value;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) await f.cleanup();
});
async function previewClaim(
  f: Awaited<ReturnType<typeof executionSetupFixture>>,
) {
  const owner = f.create();
  const preview = await owner.preview({
    bootstrap: f.bootstrap,
    pluginId: f.identity.pluginId,
  });
  const claim = owner.claimPreview({
    previewId: preview.previewId,
    approveExecution: true,
  });
  return { owner, preview, claim };
}
function lifecycle(
  f: Awaited<ReturnType<typeof executionSetupFixture>>,
  startupFailure?: number,
) {
  let starts = 0;
  const events: string[] = [];
  return {
    events,
    port: {
      mutateWhileStopped: <T>(
        options: Parameters<typeof runRuntimeStoppedMutation<T>>[0],
      ) =>
        runRuntimeStoppedMutation(options, {
          async stop() {
            events.push("stop");
            await f.stop();
          },
          async start() {
            events.push("start");
            if (++starts === startupFailure)
              throw new Error("fixture_restart_failed");
            await f.start();
          },
          assertReady() {
            events.push("ready");
          },
        }),
      preparedRuntime() {
        events.push("capture");
        return f.fakePreparedRuntime();
      },
    },
  };
}

describe("explicit Main local execution preparation", () => {
  it.each([
    "12.0.0",
    "13.0.0",
    "14.0.0",
    "15.0.0",
    "16.0.0",
    "17.0.0",
    "18.0.0",
    "19.0.0",
  ])(
    "previews the historical installed contract %s without execution or selection mutation",
    async (version) => {
      const f = await fixture({
        version,
        projectContext: ["16.0.0", "17.0.0", "18.0.0", "19.0.0"].includes(
          version,
        ),
        historicalQueries: version === "18.0.0",
      });
      const before = readFileSync(join(f.dataDirectory, "control.sqlite"));
      const owner = f.create();
      const preview = await owner.preview({
        bootstrap: f.bootstrap,
        pluginId: f.identity.pluginId,
      });
      expect(preview.version).toBe(version);
      expect(preview.packageDigest).toBe(f.identity.packageDigest);
      expect(readFileSync(join(f.dataDirectory, "control.sqlite"))).toEqual(
        before,
      );
      expect(existsSync(f.policyPath)).toBe(false);
    },
  );

  it.each(["19.0.1", "22.4.8"])(
    "accepts independent release %s with the same supported asset protocols and exact publication pins",
    async (version) => {
      const f = await fixture({
        version,
        contract: "assets",
        projectContext: true,
      });
      const before = readFileSync(join(f.dataDirectory, "control.sqlite"));
      const preview = await f.create().preview({
        bootstrap: f.bootstrap,
        pluginId: f.identity.pluginId,
      });
      expect(preview).toMatchObject(f.identity);
      expect(readFileSync(join(f.dataDirectory, "control.sqlite"))).toEqual(
        before,
      );
      expect(existsSync(f.policyPath)).toBe(false);
    },
  );
  it.each([
    {
      requirements: [
        { service: "crewon.project-assets", apiVersion: "2", optional: true },
      ],
    },
    { omitServices: ["crewon.project-asset-context"] },
    { omitServices: ["crewon.project-context"] },
    { omitOperations: ["asset_save"] },
    { omitOperations: ["project_context_read"] },
  ])(
    "rejects incompatible declared execution contracts before granting any authority: %j",
    async (contract) => {
      const f = await fixture({
        version: "19.0.1",
        contract: "assets",
        projectContext: true,
        ...contract,
      });
      const before = readFileSync(join(f.dataDirectory, "control.sqlite"));
      await expect(
        f
          .create()
          .preview({ bootstrap: f.bootstrap, pluginId: f.identity.pluginId }),
      ).rejects.toThrow("package_unsupported");
      expect(readFileSync(join(f.dataDirectory, "control.sqlite"))).toEqual(
        before,
      );
      expect(existsSync(f.policyPath)).toBe(false);
    },
  );
  it("does not treat unknown optional capabilities as an execution approval", async () => {
    const f = await fixture({
      version: "19.0.1",
      contract: "assets",
      projectContext: true,
      requirements: [
        { service: "example.future-ui", apiVersion: "2", optional: true },
      ],
    });
    const approval = readFileSync(f.approvalPath);
    await f
      .create()
      .preview({ bootstrap: f.bootstrap, pluginId: f.identity.pluginId });
    expect(readFileSync(f.approvalPath)).toEqual(approval);
    expect(existsSync(f.policyPath)).toBe(false);
  });
  it("rejects an unknown required Node service while reading installed metadata, before any execution preview", async () => {
    await expect(
      executionSetupFixture({
        version: "19.0.1",
        contract: "assets",
        projectContext: true,
        requirements: [
          {
            service: "example.future-execution",
            apiVersion: "1",
            optional: false,
          },
        ],
      }),
    ).rejects.toThrow("installed_plugin_business_execution_unavailable");
  });
  it("requires complete declared stage context services independently of release number", async () => {
    const f = await fixture({
      version: "16.0.0",
      projectContext: true,
      omitServices: ["crewon.project-tools"],
    });
    await expect(
      f
        .create()
        .preview({ bootstrap: f.bootstrap, pluginId: f.identity.pluginId }),
    ).rejects.toThrow("package_unsupported");
    expect(existsSync(f.policyPath)).toBe(false);
  });
  it("previews exact real installed/configuration pins without importing code, writing policy, mapping or selection", async () => {
    const f = await fixture(),
      owner = f.create();
    const beforeApproval = readFileSync(f.approvalPath),
      beforeDatabase = readFileSync(join(f.dataDirectory, "control.sqlite"));
    const preview = await owner.preview({
      bootstrap: f.bootstrap,
      pluginId: f.identity.pluginId,
    });
    expect(preview).toMatchObject({
      ...f.identity,
      manifestDigest: f.configuration.manifestDigest,
      implementationDigest: f.configuration.implementationDigest,
      selectionRevision: 1,
      configurationRevision: 1,
      configurationDigest: f.configuration.contentDigest,
      baseUrl: "https://comfy.example:8443/",
      preset: "krea2-portrait",
      networkPaths: SHORT_NETWORK_PATHS,
      approvalRequirement: "none",
    });
    expect(preview.previewId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(Object.isFrozen(preview)).toBe(true);
    expect(JSON.stringify(preview)).not.toContain(f.directory);
    expect(readFileSync(f.approvalPath)).toEqual(beforeApproval);
    expect(readFileSync(join(f.dataDirectory, "control.sqlite"))).toEqual(
      beforeDatabase,
    );
    expect(existsSync(f.policyPath)).toBe(false);
    expect(
      await f.store
        .pluginInstallationStore()
        .loadSelection({ scope: f.scope, pluginId: f.identity.pluginId }),
    ).toEqual(f.installedSelection);
  });

  it("requires exact explicit consent, rejects forged/cancelled claims and strict plugin request fields", async () => {
    const f = await fixture(),
      owner = f.create();
    const preview = await owner.preview({
      bootstrap: f.bootstrap,
      pluginId: f.identity.pluginId,
    });
    expect(() =>
      owner.claimPreview({
        previewId: preview.previewId,
        approveExecution: false,
      }),
    ).toThrow("consent_required");
    expect(() =>
      owner.claimPreview({
        previewId: preview.previewId,
        approveExecution: true,
        baseUrl: "https://evil.example/",
      }),
    ).toThrow();
    owner.cancelPreview({ previewId: preview.previewId });
    expect(() =>
      owner.claimPreview({
        previewId: preview.previewId,
        approveExecution: true,
      }),
    ).toThrow("preview_unavailable");
    const getter = vi.fn(() => f.identity.pluginId);
    expect(() =>
      parseDesktopLocalPluginExecutionSetupPluginId(
        Object.defineProperty({}, "pluginId", {
          enumerable: true,
          get: getter,
        }),
      ),
    ).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(() =>
      parseDesktopLocalPluginExecutionSetupPluginId({
        pluginId: "crewon.comfyui-krea2",
      }),
    ).toThrow("plugin_unsupported");
    await expect(owner.commitPolicyWhileStopped({} as never)).rejects.toThrow();
  });

  it.each([
    { version: "12.0.0" },
    { version: "19.0.1", contract: "assets" as const, projectContext: true },
  ])(
    "runs both original stopped mutations and captures exact mapping for %j before withdrawal, keeps original disabled selection",
    async (contract) => {
      const f = await fixture(contract),
        { owner, preview, claim } = await previewClaim(f),
        l = lifecycle(f);
      const result = await runDesktopLocalPluginExecutionSetup(
        { owner, claim, onStopInvalidation: (stop) => stop() },
        l.port,
      );
      expect(result).toEqual({
        pluginId: preview.pluginId,
        publisherId: preview.publisherId,
        version: preview.version,
        packageDigest: preview.packageDigest,
        manifestDigest: preview.manifestDigest,
        implementationDigest: preview.implementationDigest,
        selectionRevision: 1,
        configurationRevision: 1,
        configurationDigest: preview.configurationDigest,
        state: "prepared",
        runtimeStatus: "ready",
        stage: "mappingCommitted",
      });
      expect(l.events).toEqual([
        "stop",
        "start",
        "ready",
        "capture",
        "stop",
        "start",
        "ready",
        "capture",
      ]);
      const policy = JSON.parse(readFileSync(f.policyPath, "utf8")),
        approval = JSON.parse(readFileSync(f.approvalPath, "utf8"));
      expect(policy.packages).toEqual([
        { ...f.identity, approvalRequirement: "none" },
      ]);
      expect(policy.networkGrants).toEqual([
        {
          ...f.identity,
          baseUrl: preview.baseUrl,
          baseUrlParameter: "baseUrl",
          paths: SHORT_NETWORK_PATHS,
        },
      ]);
      expect(approval.projects.pluginGenerations.publications).toEqual([
        {
          source: {
            pluginId: f.identity.pluginId,
            packageDigest: f.identity.packageDigest,
            contributionId: "workbench",
          },
          target: {
            pluginId: f.identity.pluginId,
            packageDigest: f.identity.packageDigest,
            contributionId: "workbench",
            action: "image.generate",
          },
        },
      ]);
      expect(
        approval.projects.pluginQueries.publications[0].target.action,
      ).toBe("image.query");
      expect(lstatSync(f.policyPath).mode & 0o777).toBe(0o600);
      expect(
        await f.store
          .pluginInstallationStore()
          .loadSelection({ scope: f.scope, pluginId: f.identity.pluginId }),
      ).toEqual(f.installedSelection);
      expect(
        await f.store.extensionStore().loadExtensionActivation({
          tenantId: f.scope.tenantId,
          spaceId: f.scope.spaceId,
          pluginId: f.identity.pluginId,
        }),
      ).toBeNull();
    },
  );

  it.each([1, 2])(
    "returns committed restartRequired for original stage %i startup failure",
    async (failure) => {
      const f = await fixture(),
        { owner, claim } = await previewClaim(f),
        l = lifecycle(f, failure);
      const result = await runDesktopLocalPluginExecutionSetup(
        { owner, claim, onStopInvalidation: (stop) => stop() },
        l.port,
      );
      expect(result).toMatchObject({
        state: "restartRequired",
        runtimeStatus: "restartRequired",
        stage: failure === 1 ? "policyCommitted" : "mappingCommitted",
      });
      expect(owner.policyCommitted(claim)).toBe(true);
      expect(existsSync(f.policyPath)).toBe(true);
      expect(
        JSON.parse(readFileSync(f.approvalPath, "utf8")).schemaVersion,
      ).toBe(
        failure === 1
          ? "crewon.desktop-plugin-approval.v1"
          : "crewon.desktop-plugin-approval.v3",
      );
    },
  );

  it("keeps TTL before consent only, cancellation after claim cannot retract accepted stop operation", async () => {
    const f = await fixture(),
      owner = f.create(1000);
    const preview = await owner.preview({
      bootstrap: f.bootstrap,
      pluginId: f.identity.pluginId,
    });
    const claim = owner.claimPreview({
      previewId: preview.previewId,
      approveExecution: true,
    });
    owner.cancelPreview({ previewId: preview.previewId });
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 300_000);
    const result = await runDesktopLocalPluginExecutionSetup(
      { owner, claim, onStopInvalidation: (stop) => stop() },
      lifecycle(f).port,
    );
    expect(result.state).toBe("prepared");
  });

  it("rejects selection/configuration drift before commit and retains precise policy-committed fact after mapping drift", async () => {
    const f = await fixture(),
      { owner, claim } = await previewClaim(f);
    await owner.commitPolicyWhileStopped(claim);
    const mapping = await owner.captureProjectMappingWhileRunning(
      claim,
      f.fakePreparedRuntime(),
    );
    f.withdrawRuntime(); // The old runtime can never be checked after physical stop.
    const next = createExtensionConfiguration(
      {
        ...f.configuration,
        revision: 2,
        parameters: {
          ...f.configuration.parameters,
          preset: "krea2-character-three-view",
        },
      },
      { sha256: fixtureHash },
    );
    await f.store.extensionStore().saveExtensionConfiguration({
      configuration: next,
      expectedRevision: 1,
      receipt: {
        actorId: actor.actorId,
        idempotencyKey: "changed-config",
        requestDigest: fixtureHash("changed-config"),
      },
    });
    await expect(
      owner.commitProjectMappingWhileStopped(mapping),
    ).rejects.toThrow("records_changed");
    expect(owner.policyCommitted(claim)).toBe(true);
    expect(JSON.parse(readFileSync(f.approvalPath, "utf8")).schemaVersion).toBe(
      "crewon.desktop-plugin-approval.v1",
    );
    expect(existsSync(f.approvalPath + ".execution-pending-v1")).toBe(false);
  });

  it("rejects a current selection revision change without granting policy", async () => {
    const f = await fixture(),
      { owner, claim } = await previewClaim(f);
    await f.store.pluginInstallationStore().commitSelection({
      scope: f.scope,
      actor,
      expectedSelectionRevision: 1,
      selection: parsePluginSelection({
        ...f.installedSelection,
        revision: 2,
        state: "enabled",
      }),
      receipt: {
        idempotencyKey: "changed-selection",
        requestDigest: fixtureHash("changed-selection"),
      },
    });
    await expect(owner.commitPolicyWhileStopped(claim)).rejects.toThrow(
      "records_changed",
    );
    expect(owner.policyCommitted(claim)).toBe(false);
    expect(existsSync(f.policyPath)).toBe(false);
  });

  it("rejects approval inode replacement and owner withdrawal before publication", async () => {
    const f = await fixture(),
      { owner, claim } = await previewClaim(f);
    renameSync(f.approvalPath, f.approvalPath + ".original");
    writeFileSync(f.approvalPath, JSON.stringify(f.approval), { mode: 0o600 });
    await expect(owner.commitPolicyWhileStopped(claim)).rejects.toThrow(
      "approval_changed",
    );
    expect(owner.policyCommitted(claim)).toBe(false);
    await owner.close();
    await expect(async () =>
      owner.commitPolicyWhileStopped(claim),
    ).rejects.toThrow("withdrawn");
  });

  it("preserves every old Krea policy tuple and network grant while appending Short", async () => {
    const f = await fixture();
    await f.bootstrap.cleanup();
    const oldIdentity = {
      pluginId: "crewon.comfyui-krea2",
      publisherId: "old.publisher",
      version: "1.0.0",
      packageDigest: fixtureHash("old-package"),
    };
    const old = {
      schemaVersion: "crewon.desktop-native-plugin-policy.v1",
      packages: [{ ...oldIdentity, approvalRequirement: "perAction" }],
      networkGrants: [
        {
          ...oldIdentity,
          baseUrl: "https://old-comfy.example/",
          baseUrlParameter: "baseUrl",
          paths: [{ method: "POST", path: "/prompt" }],
        },
      ],
    };
    const oldDirectory = join(f.directory, "old-source");
    mkdirSync(oldDirectory, { mode: 0o700 });
    writeFileSync(
      f.approvalPath,
      JSON.stringify({
        ...f.approval,
        sources: [
          ...f.approval.sources,
          { ...oldIdentity, sourceId: "old-source", directory: oldDirectory },
        ],
      }),
      { mode: 0o600 },
    );
    writeFileSync(f.policyPath, JSON.stringify(old), { mode: 0o600 });
    const bootstrap = (await prepareDesktopPluginBootstrap({
      dataDirectory: f.dataDirectory,
      actor,
      sessionEntropy: fixtureHash("old-policy-fixture"),
    }))!;
    try {
      const owner = f.create(),
        preview = await owner.preview({
          bootstrap,
          pluginId: f.identity.pluginId,
        });
      const claim = owner.claimPreview({
        previewId: preview.previewId,
        approveExecution: true,
      });
      await owner.commitPolicyWhileStopped(claim);
      const policy = JSON.parse(readFileSync(f.policyPath, "utf8"));
      expect(policy.packages[0]).toEqual(old.packages[0]);
      expect(policy.networkGrants[0]).toEqual(old.networkGrants[0]);
      expect(policy.packages).toHaveLength(2);
    } finally {
      await bootstrap.cleanup();
    }
  });

  it("rejects expired consent without entering the physical mutation", async () => {
    const f = await fixture(),
      owner = f.create(1000);
    const preview = await owner.preview({
      bootstrap: f.bootstrap,
      pluginId: f.identity.pluginId,
    });
    vi.spyOn(Date, "now").mockReturnValue(preview.expiresAt + 1);
    expect(() =>
      owner.claimPreview({
        previewId: preview.previewId,
        approveExecution: true,
      }),
    ).toThrow("preview_expired");
    expect(existsSync(f.policyPath)).toBe(false);
  });

  it("does not overwrite or delete a different writer's fixed pending slot", async () => {
    const f = await fixture(),
      { owner, claim } = await previewClaim(f);
    const pending = f.policyPath + ".execution-pending-v1";
    writeFileSync(pending, "independent pending writer", { mode: 0o600 });
    await expect(owner.commitPolicyWhileStopped(claim)).rejects.toThrow();
    expect(readFileSync(pending, "utf8")).toBe("independent pending writer");
    expect(owner.policyCommitted(claim)).toBe(false);
    expect(existsSync(f.policyPath)).toBe(false);
  });

  it("rejects installed artifact mutation and external document withdrawal before policy publication", async () => {
    const f = await fixture(),
      { owner, claim } = await previewClaim(f);
    const node = join(f.installed.directory, "node.mjs");
    chmodSync(node, 0o600);
    writeFileSync(node, "changed implementation");
    await expect(owner.commitPolicyWhileStopped(claim)).rejects.toThrow();
    expect(owner.policyCommitted(claim)).toBe(false);
    expect(existsSync(f.policyPath)).toBe(false);
    f.withdrawDocument();
    await expect(async () =>
      owner.commitPolicyWhileStopped(claim),
    ).rejects.toThrow("document_withdrawn");
  });

  it.each(["url", "perAction"])(
    "preserves existing Short policy and rejects conflicting %s approval",
    async (change) => {
      const f = await fixture();
      const policy = {
        schemaVersion: "crewon.desktop-native-plugin-policy.v1",
        packages: [
          {
            ...f.identity,
            approvalRequirement: change === "perAction" ? "perAction" : "none",
          },
        ],
        networkGrants: [
          {
            ...f.identity,
            baseUrl:
              change === "url"
                ? "https://original-comfy.example/"
                : "https://comfy.example:8443/",
            baseUrlParameter: "baseUrl",
            paths: SHORT_NETWORK_PATHS,
          },
        ],
      };
      const bytes = Buffer.from(JSON.stringify(policy));
      writeFileSync(f.policyPath, bytes, { mode: 0o600 });
      await expect(
        f
          .create()
          .preview({ bootstrap: f.bootstrap, pluginId: f.identity.pluginId }),
      ).rejects.toThrow("policy_conflict");
      expect(readFileSync(f.policyPath)).toEqual(bytes);
      expect(
        await f.store
          .pluginInstallationStore()
          .loadSelection({ scope: f.scope, pluginId: f.identity.pluginId }),
      ).toEqual(f.installedSelection);
    },
  );

  it("does not rewrite an already identical exact execution policy", async () => {
    const f = await fixture(),
      first = await previewClaim(f);
    await first.owner.commitPolicyWhileStopped(first.claim);
    const before = lstatSync(f.policyPath),
      bytes = readFileSync(f.policyPath);
    await first.owner.close();
    const second = await previewClaim(f);
    await second.owner.commitPolicyWhileStopped(second.claim);
    expect(lstatSync(f.policyPath).ino).toBe(before.ino);
    expect(readFileSync(f.policyPath)).toEqual(bytes);
  });

  it("rejects a noncanonical or non-HTTPS saved network origin without changing any approval", async () => {
    const f = await fixture();
    const next = createExtensionConfiguration(
      {
        ...f.configuration,
        revision: 2,
        parameters: {
          ...f.configuration.parameters,
          baseUrl: "http://comfy.example/",
        },
      },
      { sha256: fixtureHash },
    );
    await f.store.extensionStore().saveExtensionConfiguration({
      configuration: next,
      expectedRevision: 1,
      receipt: {
        actorId: actor.actorId,
        idempotencyKey: "http-config",
        requestDigest: fixtureHash("http-config"),
      },
    });
    await expect(
      f
        .create()
        .preview({ bootstrap: f.bootstrap, pluginId: f.identity.pluginId }),
    ).rejects.toThrow();
    expect(existsSync(f.policyPath)).toBe(false);
    expect(JSON.parse(readFileSync(f.approvalPath, "utf8"))).toEqual(
      f.approval,
    );
  });
});
