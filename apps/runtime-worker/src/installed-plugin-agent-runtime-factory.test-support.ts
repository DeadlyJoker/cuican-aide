import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  compileAgentVersion,
  type AgentVersionSource,
} from "@crewon/agent-version";
import {
  createExtensionConfiguration,
  parseExtensionManifest,
} from "@crewon/domain";
import { installLocalPluginPackage } from "@crewon/plugin-host";
import { InMemoryToolBroker, type ToolRuntimePort } from "@crewon/tool-broker";
import { ConfiguredAgentVersionRuntimeFactory } from "./configured-agent-version-runtime-factory.ts";
import { compileInstalledPluginAgentVersion } from "./plugins/installed-plugin-agent-version.ts";
import { loadInstalledPluginBusinessRegistration } from "./plugins/installed-plugin-business-registration.ts";
import type { InstalledPluginAgentRuntimeEntry } from "./plugins/installed-plugin-agent-runtime-factory.ts";
import {
  definition,
  command,
  policy,
  rebind,
} from "./plugin-tool-runtime-adapter.test-support.ts";
export { command, rebind };

export const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
export const scope = {
  tenantId: "tenant-1",
  spaceId: "space-1",
  profileId: "profile-1",
};
export const pluginId = "example.enterprise-video";
export const baseTool = definition("host_read");
const schema = {
  type: "object" as const,
  properties: {},
  required: [],
  additionalProperties: false,
};
export const manifest = parseExtensionManifest({
  schemaVersion: "crewon.extension-manifest.v0",
  hostApi: "crewon.extensions.v0",
  pluginId,
  version: "1.0.0",
  title: "Enterprise video fixture",
  description: "Independent installed business metadata, unrelated to Comfy",
  task: {
    instructions: "Use the enterprise render tool once and keep its receipt.",
    inputSchema: schema,
  },
  configurationSchema: schema,
  credentialSlots: [],
  tools: [
    {
      operationId: "render",
      adapterId: "example.video-api",
      description: "Render one external enterprise video",
      inputSchema: schema,
      outputSchema: schema,
      execution: "serial",
      effect: "mutation",
      recovery: "reconcilable",
      capability: "example.video.generate",
    },
  ],
  resultViews: ["text"],
});

export function baseSource(): AgentVersionSource {
  return {
    schemaVersion: "crewon.agent-version-source.v0",
    agentVersionId: "default-agent",
    runtimeGeneration: "base-generation",
    policySnapshotId: "base-policy",
    instructions: "Keep the host's original instructions.",
    model: {
      adapterName: "fixture-provider",
      adapterVersion: "1",
      modelId: "original-model",
      contextWindowTokens: 32_000,
      maxOutputTokens: 1_000,
      autoCompactAtTokens: null,
    },
    execution: { streamMaxRetries: 0, maxToolRounds: 8 },
    resources: { workspaceRequired: false, governedContextDigest: null },
    tools: [baseTool],
  };
}

async function removeInstalled(directory: string): Promise<void> {
  await chmod(directory, 0o700);
  for (const item of await readdir(directory, { withFileTypes: true }))
    if (item.isDirectory()) await removeInstalled(join(directory, item.name));
  await rm(directory, { recursive: true, force: true });
}

/** Real immutable local package + host materializers; provider activity remains a named fixture. */
export async function factoryFixture(
  t: TestContext,
  options: { node?: string } = {},
) {
  const directory = await mkdtemp(
    join(tmpdir(), "crewon-installed-agent-factory-"),
  );
  const source = join(directory, "source");
  const installRoot = join(directory, "installed");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(source);
  await mkdir(installRoot, { mode: 0o700 });
  t.after(async () => {
    await removeInstalled(installRoot);
    await rm(directory, { recursive: true, force: true });
  });
  const node = Buffer.from(
    options.node ??
      "throw new Error('metadata-only factory must never import this Node entry');export default {};",
  );
  const business = Buffer.from(JSON.stringify(manifest));
  await writeFile(join(source, "node.mjs"), node);
  await writeFile(join(source, "business.json"), business);
  await writeFile(
    join(source, "crewon.plugin.json"),
    JSON.stringify({
      schemaVersion: "crewon.plugin-package.v1",
      hostApi: "crewon.plugin-host.v1",
      pluginId,
      version: "1.0.0",
      publisherId: "example.publisher",
      title: "Enterprise fixture",
      description: "Only installed metadata is read",
      entrypoints: { node: "node.mjs", ui: null },
      businessManifestPath: "business.json",
      requires: [
        { service: "crewon.execution", apiVersion: "1", optional: false },
      ],
      provides: [],
      contributions: [],
      files: [
        ["node.mjs", node],
        ["business.json", business],
      ].map(([path, bytes]) => ({
        path,
        byteLength: (bytes as Buffer).byteLength,
        sha256: createHash("sha256")
          .update(bytes as Buffer)
          .digest("hex"),
      })),
    }),
  );
  const installed = await installLocalPluginPackage({
    directory: source,
    installRoot,
    authorization: async () => ({ outcome: "allow" }),
  });
  const state = {
    allowed: true,
    reads: 0,
    transports: 0,
    transportCloses: 0,
    baseTools: 0,
    baseCloses: 0,
    baseCloseFails: false,
    baseCalls: 0,
    onRead: null as (() => Promise<void>) | null,
    onBaseCreate: null as (() => Promise<void>) | null,
    baseCatalog: [baseTool],
  };
  const registration = await loadInstalledPluginBusinessRegistration({
    installRoot,
    expectedPluginId: pluginId,
    expectedPublisherId: "example.publisher",
    expectedVersion: "1.0.0",
    expectedPackageDigest: installed.packageDigest,
    signal: new AbortController().signal,
    authorizeRead: async () => {
      state.reads++;
      await state.onRead?.();
      return state.allowed ? "allow" : "deny";
    },
  });
  const baseVersion = compileAgentVersion(baseSource(), digester);
  const createTransport: InstalledPluginAgentRuntimeEntry["createTransport"] = (
    version,
  ) => {
    state.transports++;
    return {
      ...version.model,
      async *stream() {
        yield { type: "completed" as const, checkpoint: null };
      },
      async close() {
        state.transportCloses++;
      },
    };
  };
  const createBaseToolRuntime: InstalledPluginAgentRuntimeEntry["createBaseToolRuntime"] =
    async () => {
      state.baseTools++;
      await state.onBaseCreate?.();
      const broker = new InMemoryToolBroker(
        state.baseCatalog,
        new Map([
          [
            "function:host_read",
            async () => {
              state.baseCalls++;
              return { output: "host-original" };
            },
          ],
        ]),
        new Map([["function:host_read", policy("readOnly", "replaySafe")]]),
      );
      const runtime: ToolRuntimePort = {
        definitions: () => broker.definitions(),
        executionPolicy: (kind, name) => broker.executionPolicy(kind, name),
        execute: (...args) => broker.execute(...args),
        reconcile: (...args) => broker.reconcile(...args),
        cancel: (...args) => broker.cancel(...args),
        canRetire: () => broker.canRetire(),
        async close() {
          state.baseCloses++;
          if (state.baseCloseFails)
            throw new Error("fixture base cleanup failed");
        },
      };
      return runtime;
    };
  // This is the actual fixture base factory's immutable deployment, never the new plugin digest.
  const baseFactory = new ConfiguredAgentVersionRuntimeFactory([
    {
      tenantId: scope.tenantId,
      agentVersionId: baseVersion.agentVersionId,
      contentDigest: baseVersion.contentDigest,
      authorityId: "base-authority",
      workspaceBindingId: null,
      materializationDigest: digester.sha256(
        JSON.stringify({
          provider: baseVersion.model,
          baseToolCatalog: baseVersion.tools,
        }),
      ),
      executionAuthority: "crewonKernel",
      createTransport,
      createToolRuntime: createBaseToolRuntime,
    },
  ]);
  const baseDeployment = baseFactory.deploymentBindings(scope.tenantId)[0]!;
  const version = compileInstalledPluginAgentVersion({
    base: { executionAuthority: "crewonKernel", version: baseVersion },
    registration,
    agentVersionId: "enterprise-agent",
    runtimeGeneration: "enterprise-generation",
    policySnapshotId: "enterprise-policy",
    digester,
  });
  const configuration = createExtensionConfiguration(
    {
      schemaVersion: "crewon.extension-configuration.v0",
      tenantId: scope.tenantId,
      spaceId: scope.spaceId,
      pluginId,
      revision: 1,
      pluginVersion: "1.0.0",
      manifestDigest: registration.manifestDigest,
      implementationDigest: registration.implementationDigest,
      parameters: {},
      credentialBindings: [],
      createdByActorId: "actor-1",
      createdAt: "2026-10-03T00:00:00.000Z",
    },
    digester,
  );
  const entry: InstalledPluginAgentRuntimeEntry = {
    scope,
    registration,
    configuration,
    approvalRequirement: "none",
    base: {
      executionAuthority: "crewonKernel",
      version: baseVersion,
      deployment: baseDeployment,
    },
    version,
    authorityId: "enterprise-authority",
    workspaceBindingId: null,
    createTransport,
    createBaseToolRuntime,
  };
  return { entry, state, directory, installRoot, installed, baseFactory };
}
