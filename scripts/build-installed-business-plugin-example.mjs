import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));

/** Build the public example outside the host; consumers receive only the prebuilt artifacts. */
export async function buildInstalledBusinessPluginExamples(
  ownedRoot,
  { includeKrea = false, includeShortDrama = false } = {},
) {
  const sdkOutput = join(ownedRoot, "sdk");
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
  async function buildExample({ name, outputRoot, sourceDirectory }) {
    const development = join(ownedRoot, "development", name);
    await mkdir(development, { recursive: true, mode: 0o700 });
    await cp(sourceDirectory, development, {
      recursive: true,
    });
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
      const directory = join(ownedRoot, outputRoot, version);
      await cp(join(development, "dist", version), directory, {
        recursive: true,
      });
      packages.push(directory);
    }
    await rm(development, { recursive: true });
    return packages;
  }
  const example = (name, outputRoot) => ({
    name,
    outputRoot,
    sourceDirectory: join(repository, "examples/plugins", name),
  });
  const packages = await buildExample(
    example("professional-report", "packages"),
  );
  const krea = includeKrea
    ? await buildExample(example("comfyui-krea2", "krea-packages"))
    : null;
  const shortDrama = includeShortDrama
    ? await buildExample({
        name: "ui-workbench-v1-compatibility",
        outputRoot: "short-drama-packages",
        sourceDirectory: join(
          repository,
          "apps/runtime-worker/test-fixtures/ui-workbench-v1",
        ),
      })
    : null;
  // Deleting the actual development projects proves consumers cannot borrow their dependencies.
  await rm(join(ownedRoot, "development"), { recursive: true });
  await rm(sdkOutput, { recursive: true });
  return Object.freeze({
    v1Directory: packages[0],
    v2Directory: packages[1],
    ...(krea === null
      ? {}
      : { kreaV1Directory: krea[0], kreaV2Directory: krea[1] }),
    ...(shortDrama === null
      ? {}
      : {
          shortDramaV1Directory: shortDrama[0],
          shortDramaV2Directory: shortDrama[1],
        }),
    developmentRemoved: true,
  });
}
