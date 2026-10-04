import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extractFile, listPackage, statFile, uncache } from "@electron/asar";
import { FuseV1Options, getCurrentFuseWire } from "@electron/fuses";
import {
  Arch,
  Platform,
  build as buildElectronPackage,
  type Configuration,
} from "electron-builder";
import { build, stop, type BuildOptions } from "esbuild";
import {
  createScopedExtensionBuildIdentity,
  EXTENSION_BUILD_IDENTITY_FILE,
  readComfySourceFingerprint,
} from "../../../packages/agent-version/src/extension-build.ts";
type RuntimeBundle = Readonly<{ entry: string; output: string }>;
type OriginalRuntimeStage = Readonly<{
  assertNode24(version: string): void;
  bundleRuntime(spec: RuntimeBundle, implementationDigest: string): void;
  runtimeBundleSpecs(
    root: string,
    destination: string,
  ): readonly RuntimeBundle[];
}>;

export type NativePackagedCompiledFile = Readonly<{
  source: string;
  sourceSha256: string;
  path: string;
  sha256: string;
}>;
export type NativePackagedRendererFile = Readonly<{
  source: string;
  path: string;
  entry: string;
  sha256: string;
}>;
export type NativePackagedFile = Readonly<{
  location: "asar" | "runtime";
  entry: string;
  sha256: string;
}>;
type FuseWire = Readonly<Awaited<ReturnType<typeof getCurrentFuseWire>>>;
type ProductManifest = Readonly<{
  name: string;
  private: boolean;
  version: string;
  type: string;
  main: string;
  dependencies: Readonly<Record<string, string>>;
  devDependencies: Readonly<Record<string, string>>;
  build: Configuration;
}>;

/** This records the installed version's native startup implementation, not an injected override. */
const userDataSwitchEvidence = Object.freeze({
  electronVersion: "43.4.1",
  switch: "--user-data-dir",
  startupSource:
    "https://github.com/electron/electron/blob/v43.4.1/shell/app/electron_main_delegate.cc#L229-L238",
  appPathMappingSource:
    "https://github.com/electron/electron/blob/v43.4.1/shell/browser/api/electron_api_app.cc#L369-L399",
  behavior:
    "PreSandboxStartup overrides chrome::DIR_USER_DATA before Main initialization; app.getPath('userData') reads the same path.",
});

export type NativePackagedAppProof = Readonly<{
  schemaVersion: "crewon.test.native-packaged-report-app.v1";
  sourceManifest: Readonly<{ path: string; sha256: string }>;
  sourceBuildSha256: string;
  packagedManifestSha256: string;
  packageMain: "dist-electron/main.mjs";
  implementationDigest: string;
  electronVersion: "43.4.1";
  electronBuilderVersion: "26.15.7";
  electronDist: string;
  target: "dir";
  platform: "darwin";
  architecture: "arm64";
  npmRebuild: false;
  nodeGypRebuild: false;
  macIdentity: null;
  publish: "never";
  asarSha256: string;
  sourceFuses: FuseWire;
  packagedFuses: FuseWire;
  userDataSwitchEvidence: typeof userDataSwitchEvidence;
  compiledFiles: readonly NativePackagedCompiledFile[];
  rendererFiles: readonly NativePackagedRendererFile[];
  packagedFiles: readonly NativePackagedFile[];
}>;

export type NativePackagedReportApp = Readonly<{
  inputRoot: string;
  uiDirectory: string;
  outputDirectory: string;
  executable: string;
  appPath: string;
  resourcesPath: string;
  runtimeDirectory: string;
  asarPath: string;
  main: string;
  observerDirectory: string;
  compiledFiles: readonly NativePackagedCompiledFile[];
  rendererFiles: readonly NativePackagedRendererFile[];
  packagedFiles: readonly NativePackagedFile[];
  proof: NativePackagedAppProof;
  proofPath: string;
}>;

/** Assemble the unchanged product entry with the original builder; never launch the application. */
export async function prepareNativePackagedReportApp(
  input: Readonly<{
    directory: string;
    repositoryRoot: string;
    rendererDirectory: string;
  }>,
): Promise<NativePackagedReportApp> {
  assert.match(process.version, /^v24\./u);
  assert.equal(process.platform, "darwin");
  assert.equal(process.arch, "arm64");
  const directory = await realpath(input.directory);
  const sourceRoot = await realpath(input.repositoryRoot);
  assert.equal(
    sourceRoot,
    await realpath(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
    ),
    "native_packaged_app_stage_repository_mismatch",
  );
  // The existing CLI lives in the root package's Node-detected ESM scope. Load its
  // exported API by URL rather than changing that package or its compiler mode.
  const { assertNode24, bundleRuntime, runtimeBundleSpecs } = (await import(
    pathToFileURL(join(sourceRoot, "scripts", "stage-desktop-runtime.ts")).href
  )) as OriginalRuntimeStage;
  for (const method of [assertNode24, bundleRuntime, runtimeBundleSpecs])
    assert.equal(typeof method, "function");
  assertNode24(process.version);
  const rendererSource = await realpath(input.rendererDirectory);
  const owner = await lstat(directory);
  assert.ok(owner.isDirectory() && owner.uid === process.getuid?.());
  const inputRoot = join(directory, "packaged-app-input");
  const outputDirectory = join(directory, "packaged-app-output");
  const observerDirectory = join(directory, "packaged-app-observer");
  for (const path of [inputRoot, outputDirectory, observerDirectory])
    await mkdir(path, { mode: 0o700 });
  const uiDirectory = join(inputRoot, "apps", "crewon-ui");
  const electronDirectory = join(uiDirectory, "dist-electron");
  const rendererDirectory = join(uiDirectory, "dist");
  const stagedRuntime = join(uiDirectory, "desktop-resources", "runtime");
  for (const path of [electronDirectory, rendererDirectory, stagedRuntime])
    await mkdir(path, { recursive: true, mode: 0o700 });

  const manifestSource = join(sourceRoot, "apps", "crewon-ui", "package.json");
  const manifestBytes = await readFile(manifestSource);
  const manifest = JSON.parse(
    manifestBytes.toString("utf8"),
  ) as ProductManifest;
  assert.equal(manifest.main, "dist-electron/main.mjs");
  assert.equal(manifest.build.productName, "CrewON");
  assert.equal(manifest.build.asar, true);
  assert.equal(manifest.devDependencies.electron, "43.4.1");
  assert.equal(manifest.devDependencies["electron-builder"], "26.15.7");
  await writeFile(join(uiDirectory, "package.json"), manifestBytes, {
    flag: "wx",
    mode: 0o600,
  });
  // Both existing dependency levels are read inputs. Rebuilding and installation are disabled.
  await copyFile(
    join(sourceRoot, "package.json"),
    join(inputRoot, "package.json"),
  );
  await symlink(
    await realpath(join(sourceRoot, "node_modules")),
    join(inputRoot, "node_modules"),
    "dir",
  );
  await symlink(
    await realpath(join(sourceRoot, "apps", "crewon-ui", "node_modules")),
    join(uiDirectory, "node_modules"),
    "dir",
  );
  const electronPackage = JSON.parse(
    await readFile(
      join(sourceRoot, "node_modules", "electron", "package.json"),
      "utf8",
    ),
  ) as { version: string };
  const builderPackage = JSON.parse(
    await readFile(
      join(sourceRoot, "node_modules", "electron-builder", "package.json"),
      "utf8",
    ),
  ) as { version: string };
  assert.equal(electronPackage.version, manifest.devDependencies.electron);
  assert.equal(
    builderPackage.version,
    manifest.devDependencies["electron-builder"],
  );
  const electronDist = await realpath(
    join(sourceRoot, "node_modules", "electron", "dist"),
  );
  const sourceApp = join(electronDist, "Electron.app");
  const sourceFuses = Object.freeze(await getCurrentFuseWire(sourceApp));
  const rendererFiles = Object.freeze(
    await copyRenderer(rendererSource, rendererDirectory),
  );
  assert.ok(rendererFiles.some(({ entry }) => entry === "dist/index.html"));
  const implementationDigest = readComfySourceFingerprint(sourceRoot);
  const compiledFiles: NativePackagedCompiledFile[] = [];
  const hostOptions: BuildOptions = {
    bundle: true,
    platform: "node",
    target: "node24",
    sourcemap: true,
    legalComments: "none",
  };
  try {
    for (const specification of [
      {
        source: "runtimeLogWriter.ts",
        output: "runtimeLogWriter.mjs",
        options: { format: "esm" as const },
      },
      {
        source: "main.ts",
        output: "main.mjs",
        options: {
          format: "esm" as const,
          external: ["electron", "electron-updater"],
        },
      },
      {
        source: "preload.ts",
        output: "preload.cjs",
        options: { format: "cjs" as const, external: ["electron"] },
      },
    ]) {
      const source = join(
        sourceRoot,
        "apps",
        "crewon-ui",
        "electron",
        specification.source,
      );
      const sourceSha256 = digest(await readFile(source));
      const path = join(electronDirectory, specification.output);
      await build({
        ...hostOptions,
        ...specification.options,
        absWorkingDir: sourceRoot,
        entryPoints: [source],
        outfile: path,
      });
      assert.equal(digest(await readFile(source)), sourceSha256);
      compiledFiles.push(
        Object.freeze({
          source,
          sourceSha256,
          path,
          sha256: digest(await readFile(path)),
        }),
      );
    }
    const specifications = runtimeBundleSpecs(sourceRoot, stagedRuntime);
    assert.equal(specifications.length, 7);
    for (const specification of specifications) {
      const sourceSha256 = digest(await readFile(specification.entry));
      bundleRuntime(specification, implementationDigest);
      execFileSync(process.execPath, ["--check", specification.output], {
        cwd: sourceRoot,
        stdio: "inherit",
      });
      assert.equal(digest(await readFile(specification.entry)), sourceSha256);
      compiledFiles.push(
        Object.freeze({
          source: specification.entry,
          sourceSha256,
          path: specification.output,
          sha256: digest(await readFile(specification.output)),
        }),
      );
    }
    assert.equal(readComfySourceFingerprint(sourceRoot), implementationDigest);
    await writeFile(
      join(stagedRuntime, EXTENSION_BUILD_IDENTITY_FILE),
      JSON.stringify(
        createScopedExtensionBuildIdentity({
          implementationDigest,
          bundlePaths: specifications.map(({ output }) => output),
        }),
        null,
        2,
      ),
      { flag: "wx", mode: 0o600 },
    );
  } finally {
    await stop();
  }

  // The original manifest/build remain byte-for-byte input. Only owned paths and local build
  // controls are supplied to the original builder; there is no extraMetadata or wrapper Main.
  const configuration: Configuration = {
    directories: { ...manifest.build.directories, output: outputDirectory },
    electronVersion: "43.4.1",
    electronDist,
    npmRebuild: false,
    nodeGypRebuild: false,
    forceCodeSigning: false,
    mac: { identity: null },
  };
  await buildElectronPackage({
    projectDir: uiDirectory,
    targets: Platform.MAC.createTarget("dir", Arch.arm64),
    config: configuration,
    publish: "never",
  });
  assert.equal(digest(await readFile(manifestSource)), digest(manifestBytes));
  assert.equal(
    digest(await readFile(join(uiDirectory, "package.json"))),
    digest(manifestBytes),
  );
  assert.equal(readComfySourceFingerprint(sourceRoot), implementationDigest);
  for (const file of compiledFiles) {
    assert.equal(digest(await readFile(file.source)), file.sourceSha256);
    assert.equal(digest(await readFile(file.path)), file.sha256);
  }
  const appPath = join(outputDirectory, "mac-arm64", "CrewON.app");
  const executable = join(appPath, "Contents", "MacOS", "CrewON");
  const resourcesPath = join(appPath, "Contents", "Resources");
  const runtimeDirectory = join(resourcesPath, "runtime");
  const asarPath = join(resourcesPath, "app.asar");
  assert.ok((await lstat(executable)).isFile());
  assert.ok((await lstat(asarPath)).isFile());
  const packagedFiles: NativePackagedFile[] = [];
  let packagedManifestSha256: string;
  try {
    const packagedManifestBytes = extractFile(asarPath, "package.json");
    const packagedManifest = JSON.parse(
      packagedManifestBytes.toString("utf8"),
    ) as ProductManifest;
    // Normal electron-builder cleanup removes build/scripts/devDependencies from its output.
    for (const field of [
      "main",
      "name",
      "private",
      "version",
      "type",
      "dependencies",
    ] as const)
      assert.deepEqual(packagedManifest[field], manifest[field]);
    packagedManifestSha256 = digest(packagedManifestBytes);
    packagedFiles.push(
      Object.freeze({
        location: "asar",
        entry: "package.json",
        sha256: packagedManifestSha256,
      }),
    );
    const rendererEntries = listPackage(asarPath, { isPack: false })
      .map((entry) => entry.replace(/^\//u, ""))
      .filter((entry) => entry.startsWith("dist/"))
      .filter((entry) => {
        const metadata = statFile(asarPath, entry, false);
        assert.ok(!("link" in metadata), "native_packaged_app_renderer_link");
        return "size" in metadata;
      });
    assert.deepEqual(
      rendererEntries.sort(),
      rendererFiles.map(({ entry }) => entry).sort(),
    );
    for (const file of rendererFiles) {
      assert.equal(digest(await readFile(file.source)), file.sha256);
      assert.equal(digest(await readFile(file.path)), file.sha256);
      assert.equal(digest(extractFile(asarPath, file.entry)), file.sha256);
      packagedFiles.push(
        Object.freeze({
          location: "asar",
          entry: file.entry,
          sha256: file.sha256,
        }),
      );
    }
    for (const file of compiledFiles.filter(
      ({ path }) => dirname(path) === electronDirectory,
    )) {
      const entry = `dist-electron/${relative(electronDirectory, file.path)}`;
      assert.equal(digest(extractFile(asarPath, entry)), file.sha256);
      packagedFiles.push(
        Object.freeze({ location: "asar", entry, sha256: file.sha256 }),
      );
      const sourceMapEntry = `${entry}.map`;
      const sourceMapSha256 = digest(await readFile(`${file.path}.map`));
      assert.equal(
        digest(extractFile(asarPath, sourceMapEntry)),
        sourceMapSha256,
      );
      packagedFiles.push(
        Object.freeze({
          location: "asar",
          entry: sourceMapEntry,
          sha256: sourceMapSha256,
        }),
      );
    }
  } finally {
    uncache(asarPath);
  }
  const runtimeEntries = (await readdir(stagedRuntime)).sort();
  assert.equal(runtimeEntries.length, 8);
  assert.deepEqual((await readdir(runtimeDirectory)).sort(), runtimeEntries);
  for (const entry of runtimeEntries) {
    const expected = digest(await readFile(join(stagedRuntime, entry)));
    const compiled = compiledFiles.find(
      (file) => file.path === join(stagedRuntime, entry),
    );
    if (compiled) assert.equal(expected, compiled.sha256);
    assert.equal(
      digest(await readFile(join(runtimeDirectory, entry))),
      expected,
    );
    packagedFiles.push(
      Object.freeze({ location: "runtime", entry, sha256: expected }),
    );
  }
  // Read-only fuse inspection. Runtime children and fixture CA trust require these original fuses.
  const packagedFuses = Object.freeze(await getCurrentFuseWire(appPath));
  assert.deepEqual(packagedFuses, sourceFuses);
  assert.equal(packagedFuses[FuseV1Options.RunAsNode], 0x31);
  assert.equal(
    packagedFuses[FuseV1Options.EnableNodeCliInspectArguments],
    0x31,
  );
  assert.equal(
    packagedFuses[FuseV1Options.EnableNodeOptionsEnvironmentVariable],
    0x31,
  );
  const frozenCompiledFiles = Object.freeze(compiledFiles);
  const frozenPackagedFiles = Object.freeze(packagedFiles);
  const proof: NativePackagedAppProof = Object.freeze({
    schemaVersion: "crewon.test.native-packaged-report-app.v1",
    sourceManifest: Object.freeze({
      path: manifestSource,
      sha256: digest(manifestBytes),
    }),
    sourceBuildSha256: digest(Buffer.from(JSON.stringify(manifest.build))),
    packagedManifestSha256,
    packageMain: "dist-electron/main.mjs",
    implementationDigest,
    electronVersion: "43.4.1",
    electronBuilderVersion: "26.15.7",
    electronDist,
    target: "dir",
    platform: "darwin",
    architecture: "arm64",
    npmRebuild: false,
    nodeGypRebuild: false,
    macIdentity: null,
    publish: "never",
    asarSha256: digest(await readFile(asarPath)),
    sourceFuses,
    packagedFuses,
    userDataSwitchEvidence,
    compiledFiles: frozenCompiledFiles,
    rendererFiles,
    packagedFiles: frozenPackagedFiles,
  });
  const proofPath = join(observerDirectory, "packaged-app-proof.json");
  await writeFile(proofPath, JSON.stringify(proof, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  return Object.freeze({
    inputRoot,
    uiDirectory,
    outputDirectory,
    executable,
    appPath,
    resourcesPath,
    runtimeDirectory,
    asarPath,
    main: join(asarPath, manifest.main),
    observerDirectory,
    compiledFiles: frozenCompiledFiles,
    rendererFiles,
    packagedFiles: frozenPackagedFiles,
    proof,
    proofPath,
  });
}

async function copyRenderer(
  source: string,
  destination: string,
): Promise<NativePackagedRendererFile[]> {
  const files: NativePackagedRendererFile[] = [];
  await walk(source);
  return files;

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const name = relative(source, path);
      assert.ok(name && name !== ".." && !name.startsWith(`..${sep}`));
      assert.ok(
        !entry.isSymbolicLink(),
        "native_packaged_app_renderer_symlink",
      );
      const target = join(destination, name);
      if (entry.isDirectory()) {
        await mkdir(target, { mode: 0o700 });
        await walk(path);
      } else {
        assert.ok(entry.isFile(), "native_packaged_app_renderer_file_invalid");
        const sha256 = digest(await readFile(path));
        await copyFile(path, target);
        assert.equal(digest(await readFile(target)), sha256);
        files.push(
          Object.freeze({
            source: path,
            path: target,
            entry: `dist/${name.split(sep).join("/")}`,
            sha256,
          }),
        );
      }
    }
  }
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
