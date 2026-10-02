import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));

/** Build the public example outside the host; consumers receive only the prebuilt artifacts. */
export async function buildInstalledBusinessPluginExamples(ownedRoot) {
  const development = join(ownedRoot, "development");
  const sdkOutput = join(ownedRoot, "sdk");
  await mkdir(development, { mode: 0o700 });
  await mkdir(sdkOutput, { mode: 0o700 });
  execFileSync("pnpm", ["pack", "--pack-destination", sdkOutput], {
    cwd: join(repository, "packages/plugin-sdk"),
    stdio: "inherit",
    timeout: 60000,
  });
  const tarballs = (await readdir(sdkOutput)).filter((name) =>
    name.endsWith(".tgz"),
  );
  assert.equal(tarballs.length, 1);
  await cp(
    join(repository, "examples/plugins/professional-report"),
    development,
    { recursive: true },
  );
  const packagePath = join(development, "package.json");
  const manifest = JSON.parse(await readFile(packagePath, "utf8"));
  manifest.dependencies["@crewon/plugin-sdk"] =
    "file:" + join(sdkOutput, tarballs[0]);
  await writeFile(packagePath, JSON.stringify(manifest));
  execFileSync(
    "pnpm",
    [
      "install",
      "--ignore-scripts",
      "--registry=https://registry.npmjs.org",
      "--config.minimumReleaseAge=0",
    ],
    {
      cwd: development,
      stdio: "inherit",
      timeout: 60000,
    },
  );
  const packages = [];
  for (const version of ["1.0.0", "2.0.0"]) {
    execFileSync("pnpm", ["build"], {
      cwd: development,
      stdio: "inherit",
      timeout: 60000,
      env: { ...process.env, CREWON_EXAMPLE_PLUGIN_VERSION: version },
    });
    const directory = join(ownedRoot, "packages", version);
    await cp(join(development, "dist", version), directory, {
      recursive: true,
    });
    packages.push({ version, directory });
  }
  // Deleting the actual development project proves later imports cannot borrow its dependencies.
  await rm(development, { recursive: true });
  await rm(sdkOutput, { recursive: true });
  return Object.freeze({
    v1Directory: packages[0].directory,
    v2Directory: packages[1].directory,
    developmentRemoved: true,
  });
}
