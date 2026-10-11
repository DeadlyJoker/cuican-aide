import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  createPluginCompositionLock,
  type PluginCompositionNode,
  type PluginCompositionHostService,
} from "@crewon/contracts/plugins";
import { installLocalPluginPackage } from "./local-plugin-package-installer.ts";
import {
  PluginCompositionCoordinator,
  type PluginCompositionAuthority,
} from "./plugin-composition-coordinator.ts";

export const scope = {
  tenantId: "tenant-1",
  spaceId: "space-1",
  profileId: "profile-1",
  authorityEpoch: "epoch-1",
};
export const digester = {
  sha256: (body: string) =>
    `sha256:${createHash("sha256").update(body).digest("hex")}`,
};
export const allow: PluginCompositionAuthority = {
  authorizePreparation: () => "allow",
  authorizePublication: () => "allow",
};
export const borrow = (lockDigest: string, pluginId = "example.consumer") => ({
  lockDigest,
  pluginId,
  authorizeBorrow: () => "allow" as const,
});
export const service = [{ service: "story.source", apiVersion: "1" }];
async function writable(directory: string): Promise<void> {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory()) await writable(join(directory, entry.name));
}
export async function compositionFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "crewon-composition-"));
  await mkdir(join(root, "installed"), { mode: 0o700 });
  const coordinators: Readonly<{ close(): Promise<void> }>[] = [];
  t.after(async () => {
    try {
      const results = await Promise.allSettled(
        coordinators.map((owner) => owner.close()),
      );
      const failures = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length)
        throw new AggregateError(failures, "fixture_owner_cleanup_failed");
    } finally {
      await writable(root);
      await rm(root, { recursive: true, force: true });
    }
  });
  let sequence = 0;
  const make = async (input: {
    pluginId: string;
    setup: string;
    version?: string;
    requires?: PluginCompositionNode["requires"];
    provides?: PluginCompositionNode["provides"];
  }) => {
    const directory = await mkdtemp(join(root, "source-"));
    const log = join(root, `log-${sequence++}`);
    const bytes = Buffer.from(`import {appendFileSync} from 'node:fs';
const record=(text)=>appendFileSync(${JSON.stringify(log)},text+'\\n'); record('load');
export default {apiVersion:'crewon.plugin-host.v1',pluginId:${JSON.stringify(input.pluginId)},async setup(ctx){record('setup');${input.setup};return {dispose(){record('dispose')}}}};`);
    await writeFile(join(directory, "entry.mjs"), bytes);
    await writeFile(
      join(directory, "crewon.plugin.json"),
      JSON.stringify({
        schemaVersion: "crewon.plugin-package.v1",
        hostApi: "crewon.plugin-host.v1",
        pluginId: input.pluginId,
        version: input.version ?? "1.0.0",
        title: "Fixture",
        description: "Actual composition fixture",
        publisherId: "example",
        entrypoints: { node: "entry.mjs", ui: null },
        businessManifestPath: null,
        requires: input.requires ?? [],
        provides: input.provides ?? [],
        contributions: [],
        files: [
          {
            path: "entry.mjs",
            byteLength: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        ],
      }),
    );
    const installed = await installLocalPluginPackage({
      directory,
      installRoot: join(root, "installed"),
      authorization: async () => ({ outcome: "allow" }),
    });
    const descriptor = installed.descriptor;
    const node: PluginCompositionNode = {
      pluginId: descriptor.pluginId,
      publisherId: descriptor.publisherId,
      version: descriptor.version,
      packageDigest: installed.packageDigest,
      hostApi: descriptor.hostApi,
      selectionRevision: 1,
      requires: descriptor.requires,
      provides: descriptor.provides,
    };
    return {
      directory,
      node,
      async records() {
        try {
          return (await readFile(log, "utf8"))
            .trim()
            .split("\n")
            .filter(Boolean);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw error;
        }
      },
    };
  };
  const source = await make({
    pluginId: "example.source",
    provides: service,
    setup: `ctx.services.provide('story.source','1',{read:()=>1})`,
  });
  const consumer = await make({
    pluginId: "example.consumer",
    requires: [{ ...service[0]!, optional: false }],
    provides: [{ service: "story.consumer", apiVersion: "1" }],
    setup: `const source=ctx.services.get('story.source','1');ctx.services.provide('story.consumer','1',{read:()=>source.read()})`,
  });
  const independent = await make({
    pluginId: "example.independent",
    setup: "",
  });
  const nodes = [source.node, consumer.node, independent.node];
  const lock = (
    revision = 1,
    selected: readonly PluginCompositionNode[] = nodes,
    hostServices: readonly PluginCompositionHostService[] = [],
  ) =>
    createPluginCompositionLock(
      {
        schemaVersion: "crewon.plugin-composition-lock.v1",
        scope,
        revision,
        nodes: selected,
        hostServices,
      },
      digester,
    );
  const coordinator = new PluginCompositionCoordinator({
    scope,
    installRoot: join(root, "installed"),
    services: [],
  });
  coordinators.push(coordinator);
  return {
    make,
    source,
    consumer,
    independent,
    nodes,
    lock,
    coordinator,
    installRoot: join(root, "installed"),
    ownCoordinator(value: PluginCompositionCoordinator) {
      coordinators.push(value);
    },
    ownOwner(value: Readonly<{ close(): Promise<void> }>) {
      coordinators.push(value);
    },
  };
}
