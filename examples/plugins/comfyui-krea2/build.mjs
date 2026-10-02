import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cp, readFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePluginPackageDescriptor } from "@crewon/plugin-sdk/contracts";

const root = dirname(fileURLToPath(import.meta.url));
const version = process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "1.0.0";
if (!/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(version))
  throw new Error("example_version_invalid");
const output = join(root, "dist", version);
await mkdir(output, { recursive: true });
for (const entry of ["node", "ui"]) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [join(root, "src", entry + ".ts")],
    outfile: join(output, entry + ".mjs"),
    bundle: true,
    format: "esm",
    platform: entry === "node" ? "node" : "browser",
    target: entry === "node" ? "node24" : "es2022",
    define: { __PLUGIN_VERSION__: JSON.stringify(version) },
    metafile: true,
  });
  for (const input of Object.keys(result.metafile.inputs)) {
    const path = relative(root, resolve(root, input));
    if (path === ".." || path.startsWith("../"))
      throw new Error("example_host_source_dependency");
  }
  for (const file of Object.values(result.metafile.outputs))
    if (
      file.imports.some(
        (item) => item.external && !item.path.startsWith("node:"),
      )
    )
      throw new Error("example_unbundled_dependency");
}
const business = JSON.parse(
  await readFile(join(root, "business.json"), "utf8"),
);
business.version = version;
await writeFile(join(output, "business.json"), JSON.stringify(business));
await cp(join(root, "provenance.json"), join(output, "provenance.json"));
const sdkDirectory = dirname(
  fileURLToPath(import.meta.resolve("@crewon/plugin-sdk/contracts")),
);
await cp(join(sdkDirectory, "LICENSE"), join(output, "SDK-LICENSE"));
await cp(join(sdkDirectory, "NOTICE"), join(output, "SDK-NOTICE"));
const files = [];
for (const path of (await readdir(output))
  .filter((name) => name !== "crewon.plugin.json")
  .sort()) {
  const bytes = await readFile(join(output, path));
  files.push({
    path,
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
const descriptor = parsePluginPackageDescriptor({
  schemaVersion: "crewon.plugin-package.v1",
  hostApi: "crewon.plugin-host.v1",
  pluginId: business.pluginId,
  publisherId: "crewon",
  version,
  title: "Krea2 生图插件",
  description: business.description,
  entrypoints: {
    node: "node.mjs",
    ui: { path: "ui.mjs", mode: "trustedModule" },
  },
  businessManifestPath: "business.json",
  requires: [
    { service: "crewon.tasks", apiVersion: "2", optional: true },
    { service: "crewon.execution", apiVersion: "1", optional: true },
  ],
  provides: [{ service: business.pluginId, apiVersion: "1" }],
  contributions: [
    { id: "studio", kind: "module", slot: "main.content", title: "Krea2 生图" },
  ],
  files,
});
await writeFile(
  join(output, "crewon.plugin.json"),
  JSON.stringify(descriptor, null, 2) + "\n",
);
console.log(output);
