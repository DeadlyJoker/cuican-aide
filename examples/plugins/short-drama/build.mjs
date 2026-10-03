import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePluginPackageDescriptor } from "@crewon/plugin-sdk/contracts";

const root = dirname(fileURLToPath(import.meta.url));
const version = process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "3.0.0";
if (version.length > 64 || !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(version))
  throw new Error("example_version_invalid");
const output = join(root, "dist", version);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: [join(root, "src/ui.tsx")],
  outfile: join(output, "ui.mjs"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  loader: { ".css": "text", ".png": "file" },
  assetNames: "assets/[name]-[hash]",
  define: { "process.env.NODE_ENV": '"production"' },
  metafile: true,
});
for (const input of Object.keys(result.metafile.inputs)) {
  const path = relative(root, resolve(root, input));
  if (path === ".." || path.startsWith("../"))
    throw new Error("example_host_source_dependency");
}
for (const file of Object.values(result.metafile.outputs))
  if (file.imports.some((item) => item.external))
    throw new Error("example_unbundled_dependency");

const sdkDirectory = dirname(
  fileURLToPath(import.meta.resolve("@crewon/plugin-sdk/ui")),
);
await cp(join(sdkDirectory, "LICENSE"), join(output, "SDK-LICENSE"));
await cp(join(sdkDirectory, "NOTICE"), join(output, "SDK-NOTICE"));
for (const name of ["react", "react-dom", "lucide-react"]) {
  const directory = dirname(
    fileURLToPath(import.meta.resolve(name + "/package.json")),
  );
  await cp(join(directory, "LICENSE"), join(output, name + "-LICENSE"));
}

const files = [];
async function collect(directory, prefix = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (entry.isDirectory())
      await collect(join(directory, entry.name), path + "/");
    else if (entry.isFile()) {
      const bytes = await readFile(join(directory, entry.name));
      files.push({
        path,
        byteLength: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    } else throw new Error("example_artifact_not_regular");
  }
}
await collect(output);
files.sort((left, right) =>
  left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
);
const descriptor = parsePluginPackageDescriptor({
  schemaVersion: "crewon.plugin-package.v1",
  hostApi: "crewon.plugin-host.v1",
  pluginId: "crewon.short-drama",
  publisherId: "example.publisher",
  version,
  title: "AI 短剧工作台",
  description:
    "独立短剧工作台：保存项目、需求和概念输入，查看版本历史；生成服务待接入，不扣费。",
  entrypoints: {
    node: null,
    ui: { path: "ui.mjs", mode: "trustedModule" },
  },
  businessManifestPath: null,
  requires: [
    { service: "crewon.creative-projects", apiVersion: "1", optional: false },
  ],
  provides: [],
  contributions: [
    { id: "workbench", kind: "module", slot: "main.content", title: "AI 短剧" },
  ],
  files,
});
await writeFile(
  join(output, "crewon.plugin.json"),
  JSON.stringify(descriptor, null, 2) + "\n",
);
console.log(output);
