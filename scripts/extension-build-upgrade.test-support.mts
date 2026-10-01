import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXTENSION_BUILD_IDENTITY_FILE,
  EXTENSION_HISTORICAL_WORK_ITEM_SCOPE,
  type ExtensionBuildIdentity,
} from "../packages/agent-version/src/extension-build.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundleFiles = [
  "control-api.mjs",
  "device-gateway.mjs",
  "local-workspace-checks-mcp.mjs",
  "provider-model-catalog.mjs",
  "provider-settings-coordinator.mjs",
  "runtime-release.mjs",
  "runtime-worker.mjs",
];

// Each build owns its pnpm workspace links. Sharing the caller's node_modules
// would silently bundle live sources while fingerprinting the copied sources.
export function snapshotSources(destination: string): void {
  const files = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  for (const file of new Set(files.split("\0").filter(Boolean))) {
    assert.ok(!file.split("/").includes("node_modules"));
    const source = resolve(repositoryRoot, file);
    assert.ok(!relative(repositoryRoot, source).startsWith(`..${sep}`));
    let stat;
    try {
      stat = lstatSync(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), file);
    const target = join(destination, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
}

export async function command(
  executable: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const child = spawn(executable, [...args], {
    cwd,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "",
    failure: Error | undefined;
  const stop = (reason: Error) => {
    failure ??= reason;
    if (child.pid === undefined) return;
    try {
      // Stage launches pnpm/esbuild children; own and stop the whole group.
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        failure = new AggregateError(
          [failure, error],
          "build_process_cleanup_failed",
        );
        child.kill("SIGKILL");
      }
    }
  };
  const abort = () => stop(new Error("build_command_aborted"));
  const timer = setTimeout(
    () => stop(new Error("build_command_timeout")),
    120_000,
  );
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    if (stdout.length + stderr.length > 8 * 1024 * 1024)
      stop(new Error("build_command_output_limit"));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    if (stdout.length + stderr.length > 8 * 1024 * 1024)
      stop(new Error("build_command_output_limit"));
  });
  try {
    await new Promise<void>((accept, reject) => {
      child.once("error", (error) => {
        failure = error;
      });
      child.once("close", (code) => {
        if (failure !== undefined || code !== 0)
          reject(
            new Error(
              `${executable} ${args.join(" ")} failed in ${cwd}\n${stdout}\n${stderr}`,
              { cause: failure ?? new Error(`build_command_exit_${code}`) },
            ),
          );
        else accept();
      });
    });
    return stdout;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

export async function installAndVerifyWorkspace(
  root: string,
  signal: AbortSignal,
): Promise<string> {
  await command(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    [
      "install",
      "--offline",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--reporter=append-only",
    ],
    root,
    signal,
  );
  const output = await command(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        import assert from 'node:assert/strict';
        import { readFileSync, realpathSync } from 'node:fs';
        import { createRequire } from 'node:module';
        import { join, relative, sep } from 'node:path';
        import { pathToFileURL } from 'node:url';
        const root = process.argv[1];
        const visited = new Set();
        function visit(directory) {
          if (visited.has(directory)) return;
          visited.add(directory);
          const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
          const require = createRequire(join(directory, 'package.json'));
          for (const field of ['dependencies', 'optionalDependencies']) {
            for (const [name, version] of Object.entries(manifest[field] ?? {})) {
              if (!version.startsWith('workspace:')) continue;
              const packageRoot = join(root, 'packages', name.slice('@crewon/'.length));
              const entry = realpathSync(require.resolve(name));
              assert.ok(!relative(packageRoot, entry).startsWith('..' + sep), name + ' resolved outside copied package: ' + entry);
              visit(packageRoot);
            }
          }
        }
        for (const app of ['control-api', 'runtime-worker', 'device-gateway']) visit(join(root, 'apps', app));
        const require = createRequire(join(root, 'apps/runtime-worker/package.json'));
        assert.equal(realpathSync(require.resolve('@crewon/agent-version/extension-build')), join(root, 'packages/agent-version/src/extension-build.ts'));
        const helper = await import(pathToFileURL(join(root, 'packages/agent-version/src/extension-build.ts')));
        console.log(JSON.stringify({ digest: helper.getComfyImplementationDigest(), packages: visited.size }));
      `,
      root,
    ],
    root,
    signal,
  );
  const result = JSON.parse(output) as { digest: string; packages: number };
  assert.ok(result.packages > 3);
  return result.digest;
}

export function stagedIdentity(root: string): {
  directory: string;
  identity: ExtensionBuildIdentity;
} {
  const directory = join(root, "apps/crewon-ui/desktop-resources/runtime");
  const identity = JSON.parse(
    readFileSync(join(directory, EXTENSION_BUILD_IDENTITY_FILE), "utf8"),
  ) as ExtensionBuildIdentity;
  assert.equal(identity.schemaVersion, "crewon.extension-build-identity.v1");
  assert.ok("historicalWorkItemScope" in identity);
  assert.equal(
    identity.historicalWorkItemScope,
    EXTENSION_HISTORICAL_WORK_ITEM_SCOPE,
  );
  assert.deepEqual(
    identity.bundles.map(({ file }) => file),
    bundleFiles,
  );
  for (const bundle of identity.bundles) {
    assert.equal(
      `sha256:${createHash("sha256")
        .update(readFileSync(join(directory, bundle.file)))
        .digest("hex")}`,
      bundle.digest,
    );
  }
  return { directory, identity };
}
