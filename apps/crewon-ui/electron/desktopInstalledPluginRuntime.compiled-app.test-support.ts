import assert from "node:assert/strict";
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
import { basename, dirname, join, relative, sep } from "node:path";
import { build, stop, type BuildOptions } from "esbuild";
import {
  createScopedExtensionBuildIdentity,
  EXTENSION_BUILD_IDENTITY_FILE,
  readComfySourceFingerprint,
} from "../../../packages/agent-version/src/extension-build.ts";

type CompiledFile = Readonly<{
  source: string;
  path: string;
  sha256: string;
}>;
type RendererFile = Readonly<{ path: string; sha256: string }>;
type Compilation = Readonly<{
  source: string;
  path: string;
  options: BuildOptions;
  sourceAlias?: string;
}>;

/** Compile original entries into an owned source-layout root for the original Electron Main. */
export async function prepareNativeCompiledReportApp(
  input: Readonly<{
    directory: string;
    repositoryRoot: string;
    rendererDirectory: string;
  }>,
): Promise<
  Readonly<{
    repositoryRoot: string;
    main: string;
    launcherDirectory: string;
    compiledFiles: readonly CompiledFile[];
    rendererFiles: readonly RendererFile[];
  }>
> {
  assert.match(process.version, /^v24\./u);
  const directory = await realpath(input.directory);
  const sourceRoot = await realpath(input.repositoryRoot);
  const rendererSource = await realpath(input.rendererDirectory);
  const owned = await lstat(directory);
  assert.ok(owned.isDirectory() && owned.uid === process.getuid?.());
  const repositoryRoot = join(directory, "frozen");
  // Exclusive creation prevents a prior profile, environment file or source tree being inherited.
  await mkdir(repositoryRoot, { mode: 0o700 });
  const launcherDirectory = join(directory, "compiled-app-launcher");
  await mkdir(launcherDirectory, { mode: 0o700 });
  await writeFile(
    join(repositoryRoot, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
    { mode: 0o600 },
  );
  await symlink(
    await realpath(join(sourceRoot, "node_modules")),
    join(repositoryRoot, "node_modules"),
    "dir",
  );
  const electronDirectory = join(
    repositoryRoot,
    "apps",
    "crewon-ui",
    "dist-electron",
  );
  const rendererDirectory = join(repositoryRoot, "apps", "crewon-ui", "dist");
  await mkdir(electronDirectory, { recursive: true, mode: 0o700 });
  await symlink(
    await realpath(join(sourceRoot, "apps", "crewon-ui", "node_modules")),
    join(repositoryRoot, "apps", "crewon-ui", "node_modules"),
    "dir",
  );
  await mkdir(rendererDirectory, { mode: 0o700 });
  const rendererFiles = await copyRenderer(rendererSource, rendererDirectory);
  assert.ok(
    rendererFiles.some(
      (file) => file.path === join(rendererDirectory, "index.html"),
    ),
    "native_compiled_app_renderer_document_missing",
  );
  const implementationDigest = readComfySourceFingerprint(sourceRoot);
  const electronOptions: BuildOptions = {
    bundle: true,
    platform: "node",
    target: "node24",
    sourcemap: true,
    legalComments: "none",
  };
  const runtimeOptions: BuildOptions = {
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    packages: "bundle",
    treeShaking: true,
    legalComments: "none",
    tsconfigRaw: {
      compilerOptions: {
        target: "ES2022",
        useDefineForClassFields: true,
        verbatimModuleSyntax: false,
        experimentalDecorators: false,
      },
    },
    banner: {
      js: 'import { createRequire as __crewonCreateRequire } from "node:module"; const require = __crewonCreateRequire(import.meta.url);',
    },
    define: {
      __CREWON_COMFY_IMPLEMENTATION_DIGEST__:
        JSON.stringify(implementationDigest),
    },
  };
  const specifications: readonly Compilation[] = [
    {
      source: join(
        sourceRoot,
        "apps",
        "crewon-ui",
        "electron",
        "runtimeLogWriter.ts",
      ),
      path: join(electronDirectory, "runtimeLogWriter.mjs"),
      options: { ...electronOptions, format: "esm" },
    },
    {
      source: join(sourceRoot, "apps", "crewon-ui", "electron", "main.ts"),
      path: join(electronDirectory, "main.mjs"),
      options: {
        ...electronOptions,
        format: "esm",
        external: ["electron", "electron-updater"],
      },
    },
    {
      source: join(sourceRoot, "apps", "crewon-ui", "electron", "preload.ts"),
      path: join(electronDirectory, "preload.cjs"),
      options: { ...electronOptions, format: "cjs", external: ["electron"] },
    },
    runtimeSpecification("control-api", "main.ts", "control-api.mjs"),
    runtimeSpecification("runtime-worker", "main.ts", "runtime-worker.mjs"),
    runtimeSpecification(
      "runtime-worker",
      "release-main.ts",
      "runtime-release.mjs",
    ),
    runtimeSpecification(
      "runtime-worker",
      "provider-model-catalog-main.ts",
      "provider-model-catalog.mjs",
    ),
  ];
  const originalSources = await Promise.all(
    specifications.map(async ({ source }) => ({
      source,
      sha256: digest(await readFile(source)),
    })),
  );
  const compiledFiles: CompiledFile[] = [];
  try {
    for (const specification of specifications) {
      await mkdir(dirname(specification.path), {
        recursive: true,
        mode: 0o700,
      });
      await build({
        ...specification.options,
        absWorkingDir: sourceRoot,
        entryPoints: [specification.source],
        outfile: specification.path,
      });
      compiledFiles.push(
        Object.freeze({
          source: specification.source,
          path: specification.path,
          sha256: digest(await readFile(specification.path)),
        }),
      );
      if (specification.options.sourcemap)
        compiledFiles.push(
          Object.freeze({
            source: specification.source,
            path: `${specification.path}.map`,
            sha256: digest(await readFile(`${specification.path}.map`)),
          }),
        );
    }
    for (const original of originalSources)
      assert.equal(
        digest(await readFile(original.source)),
        original.sha256,
        "native_compiled_app_source_changed",
      );
    assert.equal(
      readComfySourceFingerprint(sourceRoot),
      implementationDigest,
      "native_compiled_app_runtime_source_changed",
    );
    const runtimeSpecifications = specifications.filter(
      (specification) => specification.sourceAlias !== undefined,
    );
    for (const outputDirectory of new Set(
      runtimeSpecifications.map((specification) => dirname(specification.path)),
    )) {
      const identity = createScopedExtensionBuildIdentity({
        implementationDigest,
        bundlePaths: runtimeSpecifications
          .filter(
            (specification) => dirname(specification.path) === outputDirectory,
          )
          .map((specification) => specification.path),
      });
      await writeFile(
        join(outputDirectory, EXTENSION_BUILD_IDENTITY_FILE),
        JSON.stringify(identity, null, 2),
        { mode: 0o600 },
      );
    }
    for (const specification of runtimeSpecifications) {
      // Node resolves the source-mode path to its .mjs bundle, retaining original bundle checks.
      await symlink(
        basename(specification.path),
        specification.sourceAlias!,
        "file",
      );
      assert.equal(
        await realpath(specification.sourceAlias!),
        specification.path,
      );
    }
  } finally {
    await stop();
  }
  return Object.freeze({
    repositoryRoot,
    main: join(electronDirectory, "main.mjs"),
    launcherDirectory,
    compiledFiles: Object.freeze(compiledFiles),
    rendererFiles: Object.freeze(rendererFiles),
  });

  function runtimeSpecification(
    application: "control-api" | "runtime-worker",
    entry: string,
    output: string,
  ): Compilation {
    const outputDirectory = join(repositoryRoot, "apps", application, "src");
    return {
      source: join(sourceRoot, "apps", application, "src", entry),
      path: join(outputDirectory, output),
      sourceAlias: join(outputDirectory, entry),
      options: runtimeOptions,
    };
  }
}

async function copyRenderer(
  source: string,
  destination: string,
): Promise<RendererFile[]> {
  const files: RendererFile[] = [];
  const originals: Readonly<{ source: string; sha256: string }>[] = [];
  await walk(source);
  for (const original of originals)
    assert.equal(
      digest(await readFile(original.source)),
      original.sha256,
      "native_compiled_app_renderer_changed",
    );
  return files;

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const name = relative(source, path);
      assert.ok(name && name !== ".." && !name.startsWith(`..${sep}`));
      const target = join(destination, name);
      assert.ok(
        !entry.isSymbolicLink(),
        "native_compiled_app_renderer_symlink",
      );
      if (entry.isDirectory()) {
        await mkdir(target, { mode: 0o700 });
        await walk(path);
      } else {
        assert.ok(entry.isFile(), "native_compiled_app_renderer_file_invalid");
        const sha256 = digest(await readFile(path));
        await copyFile(path, target);
        assert.equal(digest(await readFile(target)), sha256);
        originals.push({ source: path, sha256 });
        files.push(Object.freeze({ path: target, sha256 }));
      }
    }
  }
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
