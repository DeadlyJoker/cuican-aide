import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative, resolve } from "node:path";
import { build } from "esbuild";

if (!process.version.startsWith("v24."))
  throw new Error("plugin_tools_node_24_required");
const root = fileURLToPath(new URL("../", import.meta.url));
const repository = resolve(root, "../..");
const output = join(root, "dist");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: ["src/cli.ts"],
  outfile: join(output, "cli.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  metafile: true,
  legalComments: "none",
  sourcemap: false,
});
for (const name of Object.keys(result.metafile.inputs)) {
  const path = relative(repository, resolve(root, name)).replaceAll("\\", "/");
  if (
    !path.startsWith("packages/contracts/src/") &&
    ![
      "packages/plugin-tools/src/cli.ts",
      "packages/plugin-host/src/local-plugin-package-verifier.ts",
      "packages/plugin-host/src/local-plugin-package-files.ts",
      "packages/plugin-host/src/local-plugin-package-types.ts",
    ].includes(path)
  )
    throw new Error(`plugin_tools_unexpected_dependency:${path}`);
}
for (const entry of Object.values(result.metafile.outputs))
  if (
    entry.imports.some(
      (item) => !item.external || !item.path.startsWith("node:"),
    )
  )
    throw new Error("plugin_tools_runtime_dependency");
await chmod(join(output, "cli.mjs"), 0o755);
for (const name of ["LICENSE", "NOTICE"])
  await writeFile(join(output, name), await readFile(join(repository, name)));
console.log(
  "Built standalone check command from the original package verifier.",
);
