import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePluginPackageDescriptor } from "@crewon/plugin-sdk/contracts";
const root = dirname(fileURLToPath(import.meta.url));
const version = "0.2.3";
const output = join(root, "dist", version);
await mkdir(output, { recursive: true });
await build({
  entryPoints: [join(root, "src/ui.ts")],
  outfile: join(output, "ui.mjs"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
});
await build({
  entryPoints: [join(root, "src/demo.ts")],
  outfile: join(root, "dist/demo.mjs"),
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
});
const sdk = dirname(
  fileURLToPath(import.meta.resolve("@crewon/plugin-sdk/contracts")),
);
await cp(join(sdk, "LICENSE"), join(output, "SDK-LICENSE"));
await cp(join(sdk, "NOTICE"), join(output, "SDK-NOTICE"));
const files = [];
for (const path of ["ui.mjs", "SDK-LICENSE", "SDK-NOTICE"]) {
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
  pluginId: "crewon.travel-demo",
  publisherId: "crewon.examples",
  version,
  title: "出行助手 · 演示",
  description:
    "车票与机票需求、比较、监测和订单的本地交互演示。无真实供应商连接或扣款。",
  entrypoints: { node: null, ui: { path: "ui.mjs", mode: "trustedModule" } },
  businessManifestPath: null,
  requires: [{service:"crewon.plugin-navigation", apiVersion:"1", optional:true}],
  provides: [],
  contributions: [
    { id: "travel", kind: "module", slot: "main.content", title: "出行助手", icon:"book-open", surfaces:["workbench", "sidebar"] },
  ],
  files,
});
await writeFile(
  join(output, "crewon.plugin.json"),
  JSON.stringify(descriptor, null, 2) + "\n",
);
console.log(output);
