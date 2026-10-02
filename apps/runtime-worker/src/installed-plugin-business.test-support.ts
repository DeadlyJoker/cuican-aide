import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  compileAgentVersion,
  type CompiledAgentVersion,
} from "@crewon/agent-version";
import {
  createExtensionConfiguration,
  type ExtensionManifest,
} from "@crewon/domain";
import { installLocalPluginPackage } from "@crewon/plugin-host";
import {
  loadInstalledPluginBusinessRegistration,
  type InstalledPluginBusinessRegistration,
} from "./plugins/installed-plugin-business-registration.ts";

export const businessDigester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
export const businessSignal = () => new AbortController().signal;
export const businessManifest: ExtensionManifest = {
  schemaVersion: "crewon.extension-manifest.v0",
  hostApi: "crewon.extensions.v0",
  pluginId: "example.professional",
  version: "1.0.0",
  title: "Professional report fixture",
  description:
    "Independent business metadata fixture, with no image-specific parameters.",
  task: {
    instructions:
      "Use the professional report tools; preserve the provider's actual outcome.",
    inputSchema: {
      type: "object",
      properties: { subject: { type: "string", maxLength: 2000, enum: null } },
      required: ["subject"],
      additionalProperties: false,
    },
  },
  configurationSchema: {
    type: "object",
    properties: {
      organization: { type: "string", maxLength: 160, enum: null },
    },
    required: ["organization"],
    additionalProperties: false,
  },
  credentialSlots: [],
  tools: [
    {
      operationId: "generate",
      adapterId: "example.professional.api",
      description: "Generate a professional report once.",
      inputSchema: {
        type: "object",
        properties: {
          subject: { type: "string", maxLength: 2000, enum: null },
        },
        required: ["subject"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { report: { type: "string", maxLength: 8000, enum: null } },
        required: ["report"],
        additionalProperties: false,
      },
      execution: "serial",
      effect: "mutation",
      recovery: "reconcilable",
      capability: "example.report.generate",
    },
  ],
  resultViews: ["text"],
};

export function businessBaseVersion(): CompiledAgentVersion {
  return compileAgentVersion(
    {
      schemaVersion: "crewon.agent-version-source.v0",
      agentVersionId: "business-base-agent",
      runtimeGeneration: "ts-v0",
      policySnapshotId: "host-base-policy",
      instructions: "Host instructions.",
      model: {
        adapterName: "direct-responses",
        adapterVersion: "1",
        modelId: "fixture-model",
        contextWindowTokens: 4096,
        maxOutputTokens: 512,
        autoCompactAtTokens: 3072,
      },
      execution: { streamMaxRetries: 0, maxToolRounds: 8 },
      resources: { workspaceRequired: false, governedContextDigest: null },
      tools: [],
    },
    businessDigester,
  );
}

export function businessConfiguration(
  registration: InstalledPluginBusinessRegistration,
) {
  return createExtensionConfiguration(
    {
      schemaVersion: "crewon.extension-configuration.v0",
      tenantId: "business-tenant",
      spaceId: "business-space",
      pluginId: registration.manifest.pluginId,
      pluginVersion: registration.manifest.version,
      manifestDigest: registration.manifestDigest,
      implementationDigest: registration.implementationDigest,
      revision: 1,
      parameters: { organization: "Fixture company" },
      credentialBindings: [],
      createdByActorId: "business-actor",
      createdAt: "2026-10-03T00:00:00.000Z",
    },
    businessDigester,
  );
}

/** Real installer artifacts; all authorization in this fixture is explicitly test-owned. */
export async function businessPackageFixture(
  t: TestContext,
  options: {
    manifest?: unknown;
    node?: string;
    version?: string;
    requires?: readonly Readonly<{
      service: string;
      apiVersion: string;
      optional: boolean;
    }>[];
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "crewon-business-source-"));
  const installRoot = await mkdtemp(
    join(tmpdir(), "crewon-business-installed-"),
  );
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await removeInstalled(installRoot);
  });
  const manifest = Buffer.from(
    JSON.stringify(options.manifest ?? businessManifest),
  );
  const node = Buffer.from(
    options.node ?? "throw new Error('metadata_reader_must_never_execute');",
  );
  const files = [
    { path: "business.json", bytes: manifest },
    { path: "entry.mjs", bytes: node },
  ];
  for (const file of files)
    await writeFile(join(directory, file.path), file.bytes);
  await writeFile(
    join(directory, "crewon.plugin.json"),
    JSON.stringify({
      schemaVersion: "crewon.plugin-package.v1",
      hostApi: "crewon.plugin-host.v1",
      pluginId: businessManifest.pluginId,
      publisherId: "example.publisher",
      version: options.version ?? "1.0.0",
      title: "Installed professional fixture",
      description: "Actual immutable package used in business metadata tests.",
      entrypoints: { node: "entry.mjs", ui: null },
      businessManifestPath: "business.json",
      requires: options.requires ?? [
        { service: "crewon.execution", apiVersion: "1", optional: false },
      ],
      provides: [],
      contributions: [],
      files: files.map((file) => ({
        path: file.path,
        byteLength: file.bytes.byteLength,
        sha256: createHash("sha256").update(file.bytes).digest("hex"),
      })),
    }),
  );
  const installed = await installLocalPluginPackage({
    directory,
    installRoot,
    authorization: async () => ({ outcome: "allow" }),
  });
  const controls = { reads: 0, allowed: true };
  const input = {
    installRoot,
    expectedPluginId: installed.descriptor.pluginId,
    expectedPublisherId: installed.descriptor.publisherId,
    expectedVersion: installed.descriptor.version,
    expectedPackageDigest: installed.packageDigest,
    signal: businessSignal(),
    authorizeRead: async () => {
      controls.reads++;
      return controls.allowed ? ("allow" as const) : ("deny" as const);
    },
  };
  return {
    installed,
    input,
    controls,
    load: () => loadInstalledPluginBusinessRegistration(input),
  };
}

async function removeInstalled(directory: string): Promise<void> {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory()) await removeInstalled(join(directory, entry.name));
  await rm(directory, { recursive: true, force: true });
}
