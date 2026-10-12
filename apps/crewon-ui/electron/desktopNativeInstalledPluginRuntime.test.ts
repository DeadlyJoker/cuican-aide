import {
  writeFileSync,
  readFileSync,
  readdirSync,
  chmodSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ControlApiClient } from "@crewon/control-client";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { attachDesktopNativeProjectWorkspaceRuntime } from "./desktopNativeProjectWorkspaceRuntime.ts";
import { LocalWorkspaceAuthority } from "./localWorkspaceRegistry.ts";
import {
  compileAgentVersion,
  type CompiledAgentVersion,
} from "@crewon/agent-version";
import { desktopInstalledPluginRuntimeFixture } from "./desktopInstalledPluginRuntime.test-support.ts";
import { prepareNativeDesktopInstalledPluginRuntime } from "./desktopNativeInstalledPluginRuntime.ts";
import { prepareDesktopPluginBootstrap } from "./desktopPluginBootstrap.ts";
import { parseNativeInstalledPluginPreparationConfiguration } from "../../runtime-worker/src/plugins/installed-plugin-native-preparation-config.ts";
import { DESKTOP_NATIVE_PLUGIN_POLICY_FILE } from "./desktopNativePluginAuthority.ts";
import { desktopInstalledPluginModelCatalog } from "./desktopInstalledPluginModelCatalog.ts";
import { restoreDesktopNativePluginBusinessActivations } from "./desktopNativePluginBusinessActivation.ts";

const modelDigester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
function recompileModel(
  base: CompiledAgentVersion,
  modelId: string,
): CompiledAgentVersion {
  return compileAgentVersion(
    {
      schemaVersion: "crewon.agent-version-source.v0",
      agentVersionId: `${base.agentVersionId}-${modelId}`,
      runtimeGeneration: `${base.runtimeGeneration}-${modelId}`,
      policySnapshotId: `${base.policySnapshotId}-${modelId}`,
      instructions: base.instructions,
      model: { ...base.model, modelId },
      execution: base.execution,
      resources: base.resources,
      tools: base.tools,
    },
    modelDigester,
  );
}

function addModel(f: Awaited<ReturnType<typeof fixture>>, modelId: string) {
  const entry = f.release.entries[0]!,
    source = recompileModel(entry.modelSource.version, modelId),
    version = recompileModel(entry.version, modelId);
  const sibling = {
    ...entry,
    modelSource: {
      ...entry.modelSource,
      version: source,
      runtimeBinding: {
        ...entry.modelSource.runtimeBinding,
        agentVersionId: source.agentVersionId,
        contentDigest: source.contentDigest,
      },
      deployment: {
        ...entry.modelSource.deployment,
        agentVersionId: source.agentVersionId,
        contentDigest: source.contentDigest,
      },
    },
    version,
    target: {
      ...entry.target,
      agentVersionId: version.agentVersionId,
      agentVersionContentDigest: version.contentDigest,
      runtimeGeneration: version.runtimeGeneration,
      policySnapshotId: version.policySnapshotId,
    },
  };
  f.release.entries.push(sibling);
  return sibling;
}

async function fixture() {
  const f = await desktopInstalledPluginRuntimeFixture();
  const policyPath = join(f.dataDirectory, DESKTOP_NATIVE_PLUGIN_POLICY_FILE);
  const policy = {
    schemaVersion: "crewon.desktop-native-plugin-policy.v1",
    packages: [
      {
        pluginId: f.source.pluginId,
        publisherId: f.source.publisherId,
        version: f.source.version,
        packageDigest: f.source.packageDigest,
        approvalRequirement: "none",
      },
    ],
    networkGrants: [],
  };
  const prepare = () => prepareNativeDesktopInstalledPluginRuntime(f.input);
  const writePolicy = (value: unknown = policy) =>
    writeFileSync(policyPath, JSON.stringify(value), { mode: 0o600 });
  const paths = (owner: NonNullable<ReturnType<typeof prepare>>) => {
    const path =
      owner.preparationEnvironment
        .CREWON_INSTALLED_PLUGIN_NATIVE_PREPARATION_PATH!;
    const directory = dirname(path);
    return {
      directory,
      release: join(directory, "release.json"),
      result: join(directory, "preparation-result.json"),
      worker: join(directory, "worker.json"),
    };
  };
  function result(
    owner: NonNullable<ReturnType<typeof prepare>>,
    prepared: boolean,
  ) {
    const p = paths(owner),
      entry = f.release.entries[0]!;
    if (prepared)
      writeFileSync(p.release, JSON.stringify(f.release), {
        mode: 0o600,
        flag: "wx",
      });
    writeFileSync(
      p.result,
      JSON.stringify({
        schemaVersion: "crewon.installed-plugin-native-preparation-result.v1",
        actor: f.input.bootstrap
          ? JSON.parse(readFileSync(f.bootstrap.bootstrapPath, "utf8")).actor
          : undefined,
        scope: f.bootstrap.scope,
        defaultAgentVersionId: f.release.defaultAgentVersionId,
        plugins: prepared
          ? [
              {
                pluginId: f.source.pluginId,
                state: "prepared",
                packageIdentity: entry.packageIdentity,
                configuration: {
                  revision: entry.configuration.revision,
                  contentDigest: entry.configuration.contentDigest,
                },
                approvalRequirement: "none",
                target: entry.target,
              },
            ]
          : [
              {
                pluginId: f.source.pluginId,
                state: "blocked",
                reasonCode: "notInstalled",
              },
            ],
      }),
      { mode: 0o600, flag: "wx" },
    );
    return p;
  }
  return {
    ...f,
    async close() {
      await f.bootstrap.cleanup();
      rmSync(f.directory, { recursive: true, force: true });
    },
    policyPath,
    policy,
    prepare,
    writePolicy,
    paths,
    result,
  };
}

describe("explicit Main Native installed plugin execution", () => {
  it("actual Native completion privately lends its authority to one child bridge and withdrawal revokes it", async () => {
    const f = await fixture();
    let owner: ReturnType<typeof f.prepare> = null;
    let child: ReturnType<typeof spawn> | undefined;
    let bridge: ReturnType<typeof attachDesktopNativeProjectWorkspaceRuntime>;
    try {
      f.writePolicy();
      owner = f.prepare()!;
      f.result(owner, true);
      const completed = owner.complete();
      if (completed.kind !== "installed") throw new Error("expected installed");
      const ordinary = join(f.dataDirectory, "ordinary");
      mkdirSync(ordinary);
      const workspaces = new LocalWorkspaceAuthority(f.dataDirectory, ordinary);
      child = spawn(
        process.execPath,
        ["-e", "process.on('message',()=>{});process.send({kind:'ready'});"],
        { stdio: ["ignore", "pipe", "pipe", "ipc"] },
      );
      child.stdout?.resume();
      child.stderr?.resume();
      await once(child, "message");
      const input = {
        owner: completed.runtime,
        workspaces,
        control: child,
        signal: new AbortController().signal,
      };
      expect(
        attachDesktopNativeProjectWorkspaceRuntime({
          ...input,
          owner: { ...completed.runtime },
        }),
      ).toBeUndefined();
      bridge = attachDesktopNativeProjectWorkspaceRuntime(input);
      expect(bridge).toBeDefined();
      owner.withdraw();
      expect(() =>
        bridge!.prepare({
          projectId: "test-project",
          packageIdentity: f.source,
        }),
      ).toThrow("unavailable");
    } finally {
      await bridge?.close();
      if (child && child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
      await owner?.close();
      await f.close();
    }
  });
  it.each(["enabled", "disabled", "revoked"] as const)(
    "restores one %s business activation for a plugin with multiple published models without replacing its prepared default or re-enabling it",
    async (state) => {
      const f = await fixture();
      let owner: ReturnType<typeof f.prepare> = null;
      try {
        f.writePolicy();
        addModel(f, "gpt-5.6-sol");
        owner = prepareNativeDesktopInstalledPluginRuntime({
          ...f.input,
          sharedEnvironment: {
            ...f.input.sharedEnvironment,
            CREWON_MODEL_CATALOG_JSON: '["native-model","gpt-5.6-sol"]',
          },
          workerEnvironment: {
            ...f.input.workerEnvironment,
            CREWON_MODEL_CATALOG_JSON: '["native-model","gpt-5.6-sol"]',
          },
        })!;
        f.result(owner, true);
        const completed = owner.complete();
        if (completed.kind !== "installed")
          throw new Error("expected installed");
        const entry = completed.runtime.expectedCatalogEntries[0]!;
        const selection = {
          pluginId: entry.identity.pluginId,
          publisherId: entry.identity.publisherId,
          revision: 3,
          state: "enabled",
          selectedPackageDigest: entry.identity.packageDigest,
          updatedAt: "2026-10-09T00:00:00.000Z",
        };
        const activation = {
          schemaVersion: "crewon.extension-activation.v0",
          tenantId: completed.runtime.scope.tenantId,
          spaceId: completed.runtime.scope.spaceId,
          pluginId: entry.identity.pluginId,
          revision: 2,
          configurationRevision: entry.configuration.revision,
          configurationDigest: entry.configuration.contentDigest,
          state,
          target: state === "enabled" ? entry.configuredTarget : null,
          updatedByActorId: "named-actor",
          updatedAt: "2026-10-09T00:00:00.000Z",
        };
        const writes: string[] = [];
        const client = new ControlApiClient({
          baseUrl: "https://named-model-restore-control.test",
          origin: "https://named-model-restore-ui.test",
          accessToken: "named-token",
          csrfToken: "named-csrf",
          fetch: async (input, init = {}) => {
            const path = new URL(String(input)).pathname;
            if ((init.method ?? "GET") !== "GET") {
              writes.push(path);
              throw new Error("restoration must retain the prepared default");
            }
            if (path.endsWith("/activation"))
              return Response.json({ activation });
            if (path.includes("/plugins/selections/"))
              return Response.json({ selection });
            if (path.includes("/plugins/packages/"))
              return Response.json({
                package: {
                  pluginId: entry.identity.pluginId,
                  publisherId: entry.identity.publisherId,
                  version: entry.identity.version,
                  packageDigest: entry.identity.packageDigest,
                  installedAt: "2026-10-09T00:00:00.000Z",
                },
              });
            if (path.endsWith("/configuration"))
              return Response.json({ configuration: entry.configuration });
            throw new Error(`Unexpected restoration read: ${path}`);
          },
        });
        const issues = await restoreDesktopNativePluginBusinessActivations({
          runtime: completed.runtime,
          client,
          signal: f.controller.signal,
        });
        expect(issues).toEqual([]);
        expect(writes).toEqual([]);
        expect(completed.runtime.expectedCatalogEntries).toHaveLength(2);
        expect(
          completed.runtime.expectedCatalogEntries.map(
            (value) => value.configuredTarget,
          ),
        ).toEqual(f.release.entries.map((value) => value.target));
      } finally {
        await owner?.close();
        await f.close();
      }
    },
  );

  it("captures model siblings from Main's Key catalog while publishing one prepared default", async () => {
    const f = await fixture();
    let owner: ReturnType<typeof f.prepare> = null;
    try {
      f.writePolicy();
      const sibling = addModel(f, "gpt-5.6-sol");
      owner = prepareNativeDesktopInstalledPluginRuntime({
        ...f.input,
        sharedEnvironment: {
          ...f.input.sharedEnvironment,
          CREWON_MODEL_CATALOG_JSON: '["native-model","gpt-5.6-sol"]',
        },
        workerEnvironment: {
          ...f.input.workerEnvironment,
          CREWON_MODEL_CATALOG_JSON: '["native-model","gpt-5.6-sol"]',
        },
      })!;
      f.result(owner, true);
      const completed = owner.complete();
      expect(completed.kind).toBe("installed");
      if (completed.kind !== "installed") throw new Error("expected installed");
      expect(completed.statuses).toHaveLength(1);
      expect(completed.runtime.expectedCatalogEntries).toHaveLength(2);
      expect(
        completed.runtime.expectedCatalogEntries[1]!.configuredTarget,
      ).toEqual(sibling.target);
      const env = completed.runtime.controlAfterPeer({
        origin: "http://127.0.0.1:39431",
      });
      const control = JSON.parse(
        readFileSync(env.CREWON_DESKTOP_NATIVE_PLUGIN_CONTROL_PATH!, "utf8"),
      );
      expect(control.schemaVersion).toBe(
        "crewon.desktop-native-plugin-control.v2",
      );
      expect(control.entries).toHaveLength(2);
      expect(JSON.stringify(control)).not.toContain(f.input.provider.apiKey);
    } finally {
      await owner?.close();
      await f.close();
    }
  });

  it.each(["unadvertised", "duplicate-model", "default-target-missing"])(
    "rejects %s sibling outputs before lending Control access",
    async (kind) => {
      const f = await fixture();
      let owner: ReturnType<typeof f.prepare> = null;
      try {
        f.writePolicy();
        addModel(
          f,
          kind === "duplicate-model" ? "native-model" : "gpt-5.6-sol",
        );
        const catalog =
          kind === "unadvertised"
            ? '["native-model"]'
            : '["native-model","gpt-5.6-sol"]';
        owner = prepareNativeDesktopInstalledPluginRuntime({
          ...f.input,
          sharedEnvironment: {
            ...f.input.sharedEnvironment,
            CREWON_MODEL_CATALOG_JSON: catalog,
          },
          workerEnvironment: {
            ...f.input.workerEnvironment,
            CREWON_MODEL_CATALOG_JSON: catalog,
          },
        })!;
        const p = f.result(owner, true);
        if (kind === "default-target-missing") {
          const doc = JSON.parse(readFileSync(p.result, "utf8"));
          doc.plugins[0].target = {
            ...doc.plugins[0].target,
            agentVersionId: "foreign-default-version",
          };
          writeFileSync(p.result, JSON.stringify(doc), { mode: 0o600 });
        }
        expect(() => owner!.complete()).toThrow();
        expect(() =>
          readFileSync(join(p.directory, "native-control.json")),
        ).toThrow();
      } finally {
        await owner?.close();
        await f.close();
      }
    },
  );

  it("does not restore an omitted default and rejects malformed Key catalogs", () => {
    expect(
      desktopInstalledPluginModelCatalog(
        { CREWON_MODEL_CATALOG_JSON: '["gpt-5.6-sol","gpt-image-2"]' },
        "gpt-5.5",
      ),
    ).toEqual(["gpt-5.6-sol"]);
    expect(
      desktopInstalledPluginModelCatalog(
        { CREWON_MODEL_CATALOG_JSON: "[]" },
        "gpt-5.5",
      ),
    ).toEqual([]);
    expect(desktopInstalledPluginModelCatalog({}, "legacy")).toEqual([
      "legacy",
    ]);
    for (const value of [
      "bad",
      "{}",
      '["sol","sol"]',
      "[null]",
      '[" bad "]',
      " ".repeat(32769),
    ])
      expect(() =>
        desktopInstalledPluginModelCatalog(
          { CREWON_MODEL_CATALOG_JSON: value },
          "legacy",
        ),
      ).toThrow("model_catalog");
  });
  it.each([
    [false, "none"],
    [true, "none"],
    [false, "perAction"],
    [true, "perAction"],
  ] as const)(
    "prepares one plugin for multiple approved versions while retaining exact package approvals (reverse=%s, requirement=%s)",
    async (reverse, requirement) => {
      const f = await fixture();
      let owner: ReturnType<typeof f.prepare> = null;
      let bootstrap: Awaited<ReturnType<typeof prepareDesktopPluginBootstrap>> =
        null;
      try {
        const nextSource = {
          ...f.source,
          sourceId: "approved-short-drama-v2",
          directory: join(f.directory, "approved-source-v2"),
          version: "2.0.0",
          packageDigest: `sha256:${"b".repeat(64)}`,
        };
        mkdirSync(nextSource.directory, { mode: 0o700 });
        f.writeApproval({
          ...f.approval,
          sources: [...f.approval.sources, nextSource],
        });
        bootstrap = await prepareDesktopPluginBootstrap({
          dataDirectory: f.dataDirectory,
          actor: f.input.bootstrap
            ? JSON.parse(readFileSync(f.bootstrap.bootstrapPath, "utf8")).actor
            : undefined,
          sessionEntropy: "named-upgrade-bootstrap-entropy-1234567890",
        });
        if (!bootstrap) throw new Error("expected upgraded bootstrap");
        const approvals = [
          { ...f.policy.packages[0]!, approvalRequirement: "perAction" },
          {
            ...f.policy.packages[0]!,
            version: nextSource.version,
            packageDigest: nextSource.packageDigest,
          },
        ];
        f.writePolicy({
          ...f.policy,
          packages: reverse ? approvals.toReversed() : approvals,
        });
        owner = prepareNativeDesktopInstalledPluginRuntime({
          ...f.input,
          bootstrap,
        })!;
        const path =
          owner.preparationEnvironment
            .CREWON_INSTALLED_PLUGIN_NATIVE_PREPARATION_PATH!;
        const document = JSON.parse(readFileSync(path, "utf8"));
        const parsed =
          parseNativeInstalledPluginPreparationConfiguration(document);
        expect(parsed.plugins).toEqual([
          { pluginId: f.source.pluginId, approvalRequirement: "perAction" },
        ]);
        expect(
          parsed.approvedPackages.map((pkg) => pkg.packageDigest).sort(),
        ).toEqual([f.source.packageDigest, nextSource.packageDigest].sort());
      } finally {
        await owner?.close();
        await bootstrap?.cleanup();
        await f.close();
      }
    },
  );

  it("absent policy leaves default Agent and management unchanged", async () => {
    const f = await fixture();
    try {
      const before = readdirSync(f.dataDirectory);
      expect(f.prepare()).toBeNull();
      expect(readdirSync(f.dataDirectory)).toEqual(before);
    } finally {
      await f.close();
    }
  });
  it("refuses unapproved tuples and nonprivate policy before publishing authority", async () => {
    const f = await fixture();
    try {
      f.writePolicy({
        ...f.policy,
        packages: [
          {
            ...f.policy.packages[0],
            packageDigest: `sha256:${"f".repeat(64)}`,
          },
        ],
      });
      expect(() => f.prepare()).toThrow("native_package_unapproved");
      f.writePolicy();
      chmodSync(f.policyPath, 0o644);
      expect(() => f.prepare()).toThrow();
      expect(
        readdirSync(f.dataDirectory).some((name) =>
          name.startsWith(".native-plugin-authority-"),
        ),
      ).toBe(false);
    } finally {
      await f.close();
    }
  });
  it("not yet installed falls back without supplying execution or bypassing default Agent", async () => {
    const f = await fixture();
    let owner: ReturnType<typeof f.prepare> = null;
    try {
      f.writePolicy();
      owner = f.prepare()!;
      f.result(owner, false);
      const completed = owner.complete();
      expect(completed.kind).toBe("default");
      if (completed.kind !== "default") throw new Error("expected fallback");
      expect(
        completed.environments.sharedEnvironment
          .CREWON_INSTALLED_PLUGIN_EXECUTION_CONFIG_PATH,
      ).toBeUndefined();
      expect(
        completed.environments.workerEnvironment.CREWON_MODEL_API_KEY,
      ).toBe(f.input.workerEnvironment.CREWON_MODEL_API_KEY);
      await owner.close();
      expect(
        readdirSync(f.dataDirectory).some((name) =>
          name.startsWith(".native-plugin-authority-"),
        ),
      ).toBe(false);
    } finally {
      await owner?.close();
      await f.close();
    }
  });
  it("uses an actual pinned release and publishes Control access only after the real peer challenge", async () => {
    const f = await fixture();
    let owner: ReturnType<typeof f.prepare> = null;
    try {
      f.writePolicy();
      owner = f.prepare()!;
      const p = f.result(owner, true);
      const config = JSON.parse(readFileSync(p.worker, "utf8"));
      expect(config.schemaVersion).toBe(
        "crewon.installed-plugin-native-worker.v1",
      );
      expect(config.actorAuthority).toBeUndefined();
      const completed = owner.complete();
      expect(completed.kind).toBe("installed");
      if (completed.kind !== "installed") throw new Error("expected installed");
      const runtime = completed.runtime;
      expect(
        runtime.control.CREWON_DESKTOP_NATIVE_PLUGIN_CONTROL_PATH,
      ).toBeUndefined();
      expect(() =>
        runtime.controlAfterPeer({ origin: "https://unapproved.example" }),
      ).toThrow();
      const env = runtime.controlAfterPeer({
        origin: "http://127.0.0.1:39431",
      });
      const control = JSON.parse(
        readFileSync(env.CREWON_DESKTOP_NATIVE_PLUGIN_CONTROL_PATH!, "utf8"),
      );
      expect(control.entries).toEqual(runtime.expectedCatalogEntries);
      expect(control.authorityPath).toBe(config.nativeAuthorityPath);
      expect(() =>
        runtime.controlAfterPeer({ origin: "http://127.0.0.1:39432" }),
      ).toThrow("native_peer_changed");
      owner.withdraw();
      expect(() => runtime.worker).toThrow("withdrawn");
      await owner.close();
    } finally {
      await owner?.close();
      await f.close();
    }
  });
  it("revokes a running owner when the actual host approval or private policy changes", async () => {
    const f = await fixture();
    let owner: ReturnType<typeof f.prepare> = null;
    try {
      f.writePolicy();
      owner = f.prepare()!;
      f.writePolicy({ ...f.policy, networkGrants: [] });
      expect(() => owner!.assertCurrent()).toThrow("file_changed");
    } finally {
      try {
        await owner?.close();
      } catch {}
      await f.close();
    }
  });
});
