import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { parsePluginPackageDescriptor } from "@crewon/plugin-sdk/contracts";
import { metadata } from "./src/metadata.ts";

const root = dirname(fileURLToPath(import.meta.url));
// Validate identity/version before deriving an output path or removing anything.
const validation = parsePluginPackageDescriptor({
  schemaVersion: "crewon.plugin-package.v1",
  hostApi: "crewon.plugin-host.v1",
  pluginId: metadata.pluginId,
  publisherId: metadata.publisherId,
  version: metadata.version,
  title: metadata.title,
  description: metadata.description,
  entrypoints: { node: "node.mjs", ui: null },
  businessManifestPath: null,
  requires: [],
  provides: [{ service: metadata.service, apiVersion: metadata.apiVersion }],
  contributions: [],
  files: [{ path: "node.mjs", byteLength: 1, sha256: "0".repeat(64) }],
});
if (!/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(validation.version))
  throw new Error("template_output_version_invalid");
const output = join(root, "dist", validation.version);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true, mode: 0o700 });
const result = await build({
  absWorkingDir: root,
  entryPoints: ["src/node.ts"],
  outfile: join(output, "node.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  metafile: true,
});
for (const name of Object.keys(result.metafile.inputs)) {
  const path = relative(root, resolve(root, name));
  if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`))
    throw new Error("template_host_source_dependency");
}
for (const entry of Object.values(result.metafile.outputs))
  if (entry.imports.length) throw new Error("template_unbundled_dependency");
const sdk = dirname(
  fileURLToPath(import.meta.resolve("@crewon/plugin-sdk/node")),
);
for (const name of ["LICENSE", "NOTICE"])
  await writeFile(join(output, name), await readFile(join(sdk, name)));
const files = await Promise.all(
  ["node.mjs", "LICENSE", "NOTICE"].map(async (path) => {
    const bytes = await readFile(join(output, path));
    return {
      path,
      byteLength: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }),
);
const descriptor = parsePluginPackageDescriptor({ ...validation, files });
await writeFile(
  join(output, "crewon.plugin.json"),
  JSON.stringify(descriptor, null, 2) + "\n",
);
console.log(`Built ${descriptor.pluginId}@${descriptor.version}`);
