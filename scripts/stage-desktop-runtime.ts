import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = join(
  repositoryRoot,
  "apps",
  "crewon-ui",
  "desktop-resources",
  "runtime",
);

type RuntimeBundle = Readonly<{ entry: string; output: string }>;

export function runtimeBundleSpecs(
  root = repositoryRoot,
  destination = outputRoot,
): readonly RuntimeBundle[] {
  return [
    {
      entry: join(root, "apps", "control-api", "src", "main.ts"),
      output: join(destination, "control-api.mjs"),
    },
    {
      entry: join(root, "apps", "runtime-worker", "src", "main.ts"),
      output: join(destination, "runtime-worker.mjs"),
    },
    {
      entry: join(root, "apps", "runtime-worker", "src", "release-main.ts"),
      output: join(destination, "runtime-release.mjs"),
    },
    {
      entry: join(
        root,
        "apps",
        "runtime-worker",
        "src",
        "provider-model-catalog-main.ts",
      ),
      output: join(destination, "provider-model-catalog.mjs"),
    },
    {
      entry: join(
        root,
        "apps",
        "control-api",
        "src",
        "provider-settings-native-coordinator.ts",
      ),
      output: join(destination, "provider-settings-coordinator.mjs"),
    },
    {
      entry: join(root, "apps", "device-gateway", "src", "main.ts"),
      output: join(destination, "device-gateway.mjs"),
    },
    {
      entry: join(root, "scripts", "local-workspace-checks-mcp.mjs"),
      output: join(destination, "local-workspace-checks-mcp.mjs"),
    },
  ];
}

export function assertNode24(version: string): void {
  if (!/^v24\./u.test(version.trim())) {
    throw new Error("CrewON desktop runtime requires Node 24");
  }
}

function executable(name: string): string {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function bundle(spec: RuntimeBundle): void {
  execFileSync(
    executable("pnpm"),
    [
      "exec",
      "esbuild",
      spec.entry,
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--target=node24",
      "--packages=bundle",
      "--tree-shaking=true",
      "--legal-comments=none",
      '--banner:js=import { createRequire as __crewonCreateRequire } from "node:module"; const require = __crewonCreateRequire(import.meta.url);',
      `--outfile=${spec.output}`,
    ],
    { cwd: repositoryRoot, stdio: "inherit" },
  );
}

export function main(): void {
  assertNode24(process.version);
  mkdirSync(outputRoot, { recursive: true });
  const specs = runtimeBundleSpecs();
  for (const spec of specs) bundle(spec);
  for (const spec of specs) {
    execFileSync(process.execPath, ["--check", spec.output], {
      cwd: repositoryRoot,
      stdio: "inherit",
    });
  }
  process.stdout.write(`TypeScript desktop runtime staged in ${outputRoot}\n`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
