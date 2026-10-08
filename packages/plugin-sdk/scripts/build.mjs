import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = resolve(packageRoot, "../..");
const output = join(packageRoot, "dist");
const require = createRequire(import.meta.url);
if (!process.version.startsWith("v24."))
  throw new Error("plugin_sdk_node_24_required");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await build({
  entryPoints: {
    "contracts": join(packageRoot, "src/contracts.ts"),
    "node": join(packageRoot, "src/node.ts"),
    "ui": join(packageRoot, "src/ui.ts"),
    "project-foundation-ui": join(packageRoot, "src/project-foundation-ui.ts"),
    "project-source-uploads": join(
      packageRoot,
      "src/project-source-uploads.ts",
    ),
  },
  outdir: output,
  bundle: true,
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  platform: "neutral",
  format: "esm",
  target: "es2022",
  tsconfig: join(packageRoot, "tsconfig.json"),
  legalComments: "none",
  sourcemap: false,
});
execFileSync(
  process.execPath,
  [
    require.resolve("typescript/bin/tsc"),
    "-p",
    join(packageRoot, "tsconfig.build.json"),
  ],
  {
    cwd: packageRoot,
    stdio: "inherit",
  },
);

const contractsDeclaration = join(
  output,
  "types/plugin-sdk/src/contracts.d.ts",
);
const declaration = await readFile(contractsDeclaration, "utf8");
const authorityImport = '"@crewon/contracts/plugins"';
if (declaration.split(authorityImport).length !== 2)
  throw new Error("plugin_sdk_contract_declaration_unexpected");
await writeFile(
  contractsDeclaration,
  declaration.replace(authorityImport, '"../../contracts/src/plugins.js"'),
);

// Declaration emit does not always rewrite import suffixes. Keep the original contract
// source authoritative while making its emitted declaration closure portable.
const pending = [output];
let declarations = 0;
while (pending.length) {
  const directory = pending.pop();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) pending.push(path);
    else if (entry.name.endsWith(".d.ts")) {
      const source = await readFile(path, "utf8");
      const rewritten = source.replace(
        /((?:from\s+|import\s*)["']\.\.?\/[^"']+)\.ts(["'])/gu,
        "$1.js$2",
      );
      const imports = [
        ...rewritten.matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/gu),
      ];
      for (const [, specifier] of imports) {
        if (!specifier.startsWith("./") && !specifier.startsWith("../"))
          throw new Error(`plugin_sdk_private_declaration_import:${specifier}`);
        const destination = resolve(
          dirname(path),
          specifier.replace(/\.js$/u, ".d.ts"),
        );
        const withinOutput = relative(output, destination);
        if (
          isAbsolute(withinOutput) ||
          withinOutput === ".." ||
          withinOutput.startsWith(`..${sep}`)
        )
          throw new Error("plugin_sdk_declaration_escape");
        await readFile(destination);
      }
      if (rewritten !== source) await writeFile(path, rewritten);
      declarations++;
    }
  }
}
await writeFile(
  join(output, "LICENSE"),
  await readFile(join(repositoryRoot, "LICENSE")),
);
await writeFile(
  join(output, "NOTICE"),
  await readFile(join(repositoryRoot, "NOTICE")),
);
console.log(
  `Built five portable SDK entries and ${declarations} self-contained declarations.`,
);
