import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePluginPackageDescriptor } from "@crewon/plugin-sdk/contracts";
import { validateComfyApiGraph } from "./build-support/comfyui-api-workflow-validation.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const version = process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "21.0.0";
if (
  version.length > 64 ||
  !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(version) ||
  BigInt(version.split(".")[0]) <= 19n
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
    "project-conversation-association-service.ts",
    "931bfd98c53c0ad0c3a39e16ef679aef889e647797c1cc495df48e65d2f1b1b9",
  ],
  [
    "project-conversation-association-codec.mjs",
    "6dcba744ba2162c8d53ae989dad1383853d8e296091cf9851eaf564d660dac48",
  ],
  [
    "project-assets-service.ts",
    "35afa93a1ec8c1bdb9aa3fe68777f54c2a74e05877d6e6dd620799b02fd7f8c0",
  ],
  [
    "project-assets-codec.mjs",
    "6758510fa295707d81582c23a0049a8fb515b44d31a64188858f6cccb7d97854",
  ],
  [
    "project-asset-recovery-service.ts",
    "411373fdd6c6cfedcf88c4d5134ac36ba2b5024af9c9892915133ff5e61caf82",
  ],
  [
    "project-asset-recovery-codec.mjs",
    "2c5f5822c42a02cf2f000d637d236a3f3934d7ae4ea463a1c702fa4cf1769364",
  ],
  [
    "project-asset-tools-service.ts",
    "c3299c78c664797c3fda2d3ec74d21df79f755a707c98abb77dfb3d9242b029e",
  ],
  [
    "project-asset-tools-codec.mjs",
    "9bde49d862666c24d228d45e95365988dde9959f1c2ef5d769b5b6a3046efcbd",
  ],
  [
    "plugin-project-historical-queries-service.ts",
    "51d464c490241da162c7806682f994c2e60c5982753cb1cadfebc6298e8324c6",
  ],
  [
    "project-historical-query-ui-client.ts",
    "1fe5b8686127380d2410806374fee0887b4b908b0eb3642daf94887818cb8860",
  ],
  [
    "project-historical-query-codec.mjs",
    "4ebd4625638255f59a2039314ebe3f6e50ca8edc906f7d4b996cafd87beb344e",
  ],
  [
    "project-planning-service.ts",
    "e276311252a3eff4aef042fed519c81e83a7f90f112eaab6df383c9664a15321",
  ],
  [
    "project-planning-codec.mjs",
    "5f8d5418bfeb6d2e82f4aa1a7bfac66415cc621a04806b5a949335f16ba5bf07",
  ],
  [
    "project-text-plans-service.ts",
    "54c3ce5c9b3a75e20de0e935754a50e1c65b820b17b6a7d50acc6814407a7d0e",
  ],
  [
    "project-text-plans-codec.mjs",
    "593250f1443e1c1b87708caf724e4df177945f99cc1df670a9161f357cc64ca5",
  ],
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
  [
    "project-conversations-service.ts",
    "2e31b156324314fdee7a5917ce3c60abc14a6687b5bcac8aff3a81d99713d8de",
  ],
  [
    "project-conversations-codec.mjs",
    "f32e610143d343883e61500d2d7febe1efc93894920819276175ecf3c6213fc5",
  ],
  [
    "project-context-service.ts",
    "0bd9d1b7842744bc2ef0d3fe60f3481332a658193898794b05d0e8d415bf0dce",
  ],
  [
    "project-context-codec.mjs",
    "3d375dcfc66455fc2ce7f1e3a45c1973bdc937afdeba4bbf8893bd26f94bde17",
  ],
]) {
  const bytes = await readFile(join(root, "src", file));
  if (createHash("sha256").update(bytes).digest("hex") !== expected)
    throw new Error("example_project_texts_ui_protocol_drift");
}
const mediaProtocol = await readFile(
  join(root, "src/project-media-execution-service.ts"),
);
if (
  createHash("sha256").update(mediaProtocol).digest("hex") !==
  "1c884be265bbf71d299025845c2e202b0d0e3799d06937505545f6cd046b0323"
)
  throw new Error("example_project_media_protocol_drift");
const reviewedWorkflows = [
  {
    file: "krea2-reference-four-view.api.json",
    sha256: "be639307e191225d9664a9b5c2f3488e62dc70cc9c167c229b0c610b51e8a099",
    nodeCount: 15,
    options: {
      outputNodeId: "129",
      prompt: { nodeId: "143", input: "prompt" },
      outputPrefix: { nodeId: "129", input: "filename_prefix" },
    },
  },
  {
    file: "flux2-three-reference-storyboard.api.json",
    sha256: "398840d13a306074d979ad05a62891f64f83b0c906c9e6fbe946bcf20a1f2e84",
    nodeCount: 39,
    options: {
      outputNodeId: "17",
      prompt: { nodeId: "235:231", input: "text" },
      outputPrefix: { nodeId: "17", input: "filename_prefix" },
    },
  },
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
await cp(
  join(root, "src/templates/reference-provenance.json"),
  join(output, "reference-workflow-provenance.json"),
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
    "短剧工作台：Agent 对话与手动创作共用大纲、剧本及角色/场景/道具资产；集成文字计划、概念生图、原任务查询和图片选用。",
  entrypoints: {
    node: "node.mjs",
    ui: { path: "ui.mjs", mode: "trustedModule" },
  },
  businessManifestPath: "business.json",
  requires: [
    {
      service: "crewon.project-media-execution",
      apiVersion: "1",
      optional: true,
    },
    ...[
      "crewon.project-assets",
      "crewon.project-asset-recovery",
      "crewon.project-asset-tools",
      "crewon.project-asset-context",
      "crewon.project-asset-stages",
    ].map((service) => ({ service, apiVersion: "1", optional: true })),
    {
      service: "crewon.project-planning-drafts",
      apiVersion: "1",
      optional: true,
    },
    {
      service: "crewon.project-historical-queries",
      apiVersion: "1",
      optional: true,
    },
    { service: "crewon.project-text-plans", apiVersion: "1", optional: true },
    {
      service: "crewon.project-conversation-association",
      apiVersion: "1",
      optional: true,
    },
    {
      service: "crewon.project-conversations",
      apiVersion: "1",
      optional: true,
    },
    { service: "crewon.project-context", apiVersion: "1", optional: true },
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
