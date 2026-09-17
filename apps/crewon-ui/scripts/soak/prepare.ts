import { build, stop } from "esbuild";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  readdirSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { soakEnvironment } from "./environment.ts";
import { SOAK_FILE_CONTENT } from "./tool-fixture.ts";

/** Freeze executable bundles and renderer assets. No user database, .env, or workspace is copied. */
export async function prepareSoak(
  root: string,
  repository: string,
  providerOrigin: string,
) {
  try {
    return await prepareFrozenSoak(root, repository, providerOrigin);
  } finally {
    stop();
  }
}

async function prepareFrozenSoak(
  root: string,
  repository: string,
  providerOrigin: string,
) {
  const frozen = join(root, "frozen"),
    ui = join(frozen, "apps/crewon-ui");
  for (const directory of [
    "metrics",
    "workspace",
    "profile/control-runtime-v1",
    "frozen/apps/crewon-ui/dist-electron",
  ])
    mkdirSync(join(root, directory), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(frozen, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
    { flag: "wx" },
  );
  writeFileSync(join(root, "workspace/fixture.txt"), SOAK_FILE_CONTENT, {
    flag: "wx",
  });
  writeFileSync(
    join(root, "profile/control-runtime-v1/provider-credentials.json"),
    JSON.stringify({
      schemaVersion: "crewon.provider-credentials.v1",
      activeProviderId: "soak-local",
      bindings: [
        {
          providerId: "soak-local",
          endpoint: `${providerOrigin}/v1`,
          modelId: "crewon-soak-model",
          credentialKind: "environment",
          environmentVariable: "CREWON_SOAK_MODEL_KEY",
          encryptedSecret: null,
        },
      ],
    }),
    { mode: 0o600, flag: "wx" },
  );
  const bundle = async (
    entry: string,
    output: string,
    external: string[] = [],
    banner = false,
  ) => {
    mkdirSync(dirname(output), { recursive: true });
    await build({
      absWorkingDir: repository,
      entryPoints: [join(repository, entry)],
      outfile: output,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      external,
      legalComments: "none",
      ...(banner
        ? {
            banner: {
              js: 'import { createRequire as __crewonCreateRequire } from "node:module"; const require = __crewonCreateRequire(import.meta.url);',
            },
          }
        : {}),
    });
  };
  // Preserve the development Supervisor's entry paths while freezing their entire dependency graph.
  for (const entry of [
    "apps/control-api/src/main.ts",
    "apps/runtime-worker/src/main.ts",
    "apps/runtime-worker/src/release-main.ts",
    "apps/runtime-worker/src/provider-model-catalog-main.ts",
    "scripts/local-workspace-checks-mcp.mjs",
  ])
    await bundle(entry, join(frozen, entry), [], true);
  await bundle(
    "apps/crewon-ui/electron/main.ts",
    join(ui, "dist-electron/main.mjs"),
    ["electron", "electron-updater"],
  );
  await bundle(
    "apps/crewon-ui/electron/runtimeLogWriter.ts",
    join(ui, "dist-electron/runtimeLogWriter.mjs"),
  );
  await build({
    absWorkingDir: repository,
    entryPoints: [join(repository, "apps/crewon-ui/electron/preload.ts")],
    outfile: join(ui, "dist-electron/preload.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
    legalComments: "none",
  });
  symlinkSync(
    join(repository, "node_modules"),
    join(frozen, "node_modules"),
    "dir",
  );
  await bundle(
    "apps/crewon-ui/scripts/soak/electron-entry.ts",
    join(root, "electron-entry.mjs"),
    ["electron"],
  );
  await bundle(
    "apps/crewon-ui/scripts/soak/runtime-metrics-entry.ts",
    join(root, "runtime-metrics.mjs"),
  );
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      join(repository, "apps/crewon-ui/scripts/soak/renderer-build.ts"),
      repository,
      join(ui, "dist"),
    ],
    {
      cwd: root,
      env: {
        ...soakEnvironment(),
        VITE_CREWON_APP_SERVER_URL: `${providerOrigin.replace(/^http:/, "ws:")}/disabled-app-server`,
        VITE_AGENT_PLATFORM_BASE_URL: `${providerOrigin}/account`,
        VITE_AGENT_PLATFORM_RUNTIME_BASE_URL: `${providerOrigin}/account`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const deadline = setTimeout(() => child.kill("SIGKILL"), 120_000);
  let diagnostic = "";
  for (const stream of [child.stdout, child.stderr])
    stream?.on("data", (chunk) => {
      diagnostic = (diagnostic + chunk.toString()).slice(-16384);
    });
  let result: number | null;
  try {
    result = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
  } finally {
    clearTimeout(deadline);
  }
  writeFileSync(join(root, "build.log"), diagnostic, { mode: 0o600 });
  if (result !== 0) throw new Error("soak_renderer_build_failed");
  const files: { path: string; bytes: number; sha256: string }[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else {
        const value = readFileSync(file);
        files.push({
          path: relative(root, file),
          bytes: value.length,
          sha256: createHash("sha256").update(value).digest("hex"),
        });
      }
    }
  };
  visit(frozen);
  for (const name of ["electron-entry.mjs", "runtime-metrics.mjs"]) {
    const value = readFileSync(join(root, name));
    files.push({
      path: name,
      bytes: value.length,
      sha256: createHash("sha256").update(value).digest("hex"),
    });
  }
  return {
    files,
    sharedExternalModules: ["electron-updater and its installed dependencies"],
    frozen,
  };
}
