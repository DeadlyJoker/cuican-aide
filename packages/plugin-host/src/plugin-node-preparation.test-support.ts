import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { installLocalPluginPackage } from "./local-plugin-package-installer.ts";

/** Actual immutable packages and native ESM imports; no loader or lifecycle mocks. */
export async function preparedPackage(
  t: TestContext,
  input: {
    pluginId?: string;
    version?: string;
    setup?: string;
    dispose?: string;
    requires?: Array<{
      service: string;
      apiVersion: string;
      optional: boolean;
    }>;
    provides?: Array<{ service: string; apiVersion: string }>;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "crewon-plugin-prepared-"));
  const installRoot = await mkdtemp(
    join(tmpdir(), "crewon-plugin-prepared-root-"),
  );
  const log = `${directory}.log`;
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await removeInstalled(installRoot);
    await rm(log, { force: true });
  });
  const pluginId = input.pluginId ?? "example.story";
  const bytes = Buffer.from(`import {appendFileSync} from 'node:fs';
const record = (value) => appendFileSync(${JSON.stringify(log)}, value+'\\n');
record('load');
export default {apiVersion:'crewon.plugin-host.v1',pluginId:${JSON.stringify(pluginId)},
setup(ctx){record('setup'); ${input.setup ?? ""}
return {dispose(){record('dispose'); ${input.dispose ?? ""}}};}};`);
  await writeFile(join(directory, "entry.mjs"), bytes);
  await writeFile(
    join(directory, "crewon.plugin.json"),
    JSON.stringify({
      schemaVersion: "crewon.plugin-package.v1",
      hostApi: "crewon.plugin-host.v1",
      pluginId,
      version: input.version ?? "1.0.0",
      title: "Prepared fixture",
      description: "Actual Node package lifecycle fixture",
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
    installRoot,
    authorization: async () => ({ outcome: "allow" }),
  });
  return {
    installRoot,
    expectedPluginId: pluginId,
    expectedPackageDigest: installed.packageDigest,
    authorizeActivation: () => "allow" as const,
    async records(): Promise<string[]> {
      try {
        return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
  };
}

async function removeInstalled(directory: string): Promise<void> {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory()) await removeInstalled(join(directory, entry.name));
  await rm(directory, { recursive: true, force: true });
}

export const preparedBorrow = (pluginId: string, packageDigest: string) => ({
  pluginId,
  packageDigest,
  purpose: "newOperation" as const,
  authorizeBorrow: () => "allow" as const,
});
export const allowPreparedCommit = { authorizeCommit: () => "allow" as const };
