/** Reuses F05's checked-in driver on F02's existing WebContentsView. */
import { build } from "esbuild";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(uiRoot, "../..");
const output = join(uiRoot, "dist-electron");
const executionRoot = process.env.F02_EXECUTION_SOURCE_ROOT
  ? resolve(process.env.F02_EXECUTION_SOURCE_ROOT, "apps/crewon-ui")
  : uiRoot;
const driver = join(executionRoot, "electron/browserExecutionPuppeteer.ts");
await access(driver).catch(() => {
  throw new Error(
    "F05 driver is required: integrate its commit or set F02_EXECUTION_SOURCE_ROOT to its repository checkout.",
  );
});
await Promise.all([
  build({
    entryPoints: [driver],
    outfile: join(output, "recording-test-driver.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["electron", "puppeteer-core"],
  }),
  build({
    entryPoints: [
      join(executionRoot, "electron/browserExecutionInspection.ts"),
    ],
    outfile: join(output, "recording-test-inspection.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "CrewonBrowserInspection",
  }),
  ...["recording-gui-regression", "recording-recovery-regression"].map((name) =>
    build({
      entryPoints: [join(uiRoot, `scripts/${name}.ts`)],
      outfile: join(output, `${name}.mjs`),
      bundle: true,
      platform: "node",
      format: "esm",
      external: ["electron"],
    }),
  ),
]);
function run(executable: string, script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [join(output, `${script}.mjs`)], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, F02_REPO_ROOT: root },
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`)),
    );
  });
}
await run(process.execPath, "recording-recovery-regression");
const electronExecutable = createRequire(import.meta.url)("electron") as string;
await run(electronExecutable, "recording-gui-regression");
