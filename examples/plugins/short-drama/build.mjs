import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePluginPackageDescriptor } from "@crewon/plugin-sdk/contracts";
import { validateComfyApiGraph } from "./build-support/comfyui-api-workflow-validation.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const version = process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "15.0.0";
if (
  version.length > 64 ||
  !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(version) ||
  BigInt(version.split(".")[0]) <= 14n
)
  throw new Error("example_version_invalid");
// Pinned portable public capability protocol; no private host source import.
const projectProtocol = await readFile(
  join(root, "src/project-tools-service.ts"),
);
if (
  createHash("sha256").update(projectProtocol).digest("hex") !==
  "7ac394c7ee01a4eb93278b1c23e5b57da36e36c0e043a66a21abd7b02be6f73a"
)
  throw new Error("example_project_tools_protocol_drift");
// Independently published text UI protocol and its self-contained strict public codec.
for (const [file, expected] of [
  [
    "project-texts-ui-service.ts",
    "6ca41f221e55f7c3aae6e541f2ebef34655df5e58a2ce45396519029e2c108c4",
  ],
  [
    "project-texts-ui-codec.mjs",
    "3b99d94c5d0cc7f5104be5135a03122b248212720e8ded4f9242139d3d5b9765",
  ],
  [
    "project-text-recovery-service.ts",
    "60e3d01d59deedaf9adff20ffea17334d0ce0c39ad59c8ac3753d0af8f38561a",
  ],
  [
    "project-text-recovery-codec.mjs",
    "73f27132eb7356bf7c7f826faef446f9df7297e58886812311bbf48776da2696",
  ],
]) {
  const bytes = await readFile(join(root, "src", file));
  if (createHash("sha256").update(bytes).digest("hex") !== expected)
    throw new Error("example_project_texts_ui_protocol_drift");
}
const reviewedWorkflows = [
  {
    file: "krea2-portrait.api.json",
    sha256: "fee684ddcda82366507eb4a10f2aec4b682fa2cfa772866b59a057a9a07790bb",
    nodeCount: 11,
    options: {
      outputNodeId: "29",
      prompt: { nodeId: "51", input: "text" },
      outputPrefix: { nodeId: "29", input: "filename_prefix" },
    },
  },
  {
    file: "krea2-character-three-view.api.json",
    sha256: "46d489340f58c69ea86afe17db0f0e21c789d321050c929426211fa88b9fddbb",
    nodeCount: 16,
    options: {
      outputNodeId: "29",
      prompt: { nodeId: "121", input: "prompt" },
      outputPrefix: { nodeId: "29", input: "filename_prefix" },
    },
  },
];
for (const workflow of reviewedWorkflows) {
  const bytes = await readFile(join(root, "src/templates", workflow.file));
  if (createHash("sha256").update(bytes).digest("hex") !== workflow.sha256)
    throw new Error("example_workflow_source_changed");
  const graph = validateComfyApiGraph(JSON.parse(bytes), workflow.options);
  if (Object.keys(graph).length !== workflow.nodeCount)
    throw new Error("example_workflow_nodes_changed");
}
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

const nodeResult = await build({
  absWorkingDir: root,
  entryPoints: [join(root, "src/node.ts")],
  outfile: join(output, "node.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  metafile: true,
});
for (const input of Object.keys(nodeResult.metafile.inputs)) {
  const path = relative(root, resolve(root, input));
  if (path === ".." || path.startsWith("../"))
    throw new Error("example_host_source_dependency");
}
for (const file of Object.values(nodeResult.metafile.outputs))
  if (
    file.imports.some((item) => item.external && !item.path.startsWith("node:"))
  )
    throw new Error("example_unbundled_dependency");
const business = JSON.parse(
  await readFile(join(root, "business.json"), "utf8"),
);
business.version = version;
await writeFile(join(output, "business.json"), JSON.stringify(business));
await cp(
  join(root, "src/templates/provenance.json"),
  join(output, "workflow-provenance.json"),
);

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
    "短剧工作台：项目需求、大纲与分集剧本共用版本记录；集成概念生图、原任务查询、图片选用与 Agent 项目工具。",
  entrypoints: {
    node: "node.mjs",
    ui: { path: "ui.mjs", mode: "trustedModule" },
  },
  businessManifestPath: "business.json",
  requires: [
    {
      service: "crewon.project-text-recovery",
      apiVersion: "1",
      optional: true,
    },
    { service: "crewon.project-texts", apiVersion: "1", optional: true },
    { service: "crewon.creative-projects", apiVersion: "1", optional: true },
    { service: "crewon.plugin-ui-recovery", apiVersion: "1", optional: true },
    {
      service: "crewon.project-generation-reads",
      apiVersion: "1",
      optional: true,
    },
    { service: "crewon.project-generations", apiVersion: "1", optional: true },
    {
      service: "crewon.project-generation-queries",
      apiVersion: "1",
      optional: true,
    },
    {
      service: "crewon.project-generation-selections",
      apiVersion: "1",
      optional: true,
    },
    {
      service: "crewon.project-generation-contexts",
      apiVersion: "1",
      optional: true,
    },
    { service: "crewon.tasks", apiVersion: "2", optional: true },
    { service: "crewon.execution", apiVersion: "1", optional: true },
    { service: "crewon.project-tools", apiVersion: "1", optional: true },
  ],
  provides: [{ service: "crewon.short-drama", apiVersion: "1" }],
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
