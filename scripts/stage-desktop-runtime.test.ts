import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertNode24,
  bundleRuntime,
  runtimeBundleSpecs,
} from "./stage-desktop-runtime.ts";
import {
  createExtensionBuildIdentity,
  createScopedExtensionBuildIdentity,
  EXTENSION_BUILD_IDENTITY_FILE,
  getComfyImplementationDigest,
  readComfySourceFingerprint,
} from "../packages/agent-version/src/extension-build.ts";

test("desktop staging contains only the active TypeScript runtime bundles", () => {
  const specs = runtimeBundleSpecs("/repo", "/runtime");

  assert.deepEqual(
    specs.map(({ entry, output }) => ({ entry, output })),
    [
      {
        entry: "/repo/apps/control-api/src/main.ts",
        output: "/runtime/control-api.mjs",
      },
      {
        entry: "/repo/apps/runtime-worker/src/main.ts",
        output: "/runtime/runtime-worker.mjs",
      },
      {
        entry: "/repo/apps/runtime-worker/src/release-main.ts",
        output: "/runtime/runtime-release.mjs",
      },
      {
        entry: "/repo/apps/runtime-worker/src/provider-model-catalog-main.ts",
        output: "/runtime/provider-model-catalog.mjs",
      },
      {
        entry:
          "/repo/apps/control-api/src/provider-settings-native-coordinator.ts",
        output: "/runtime/provider-settings-coordinator.mjs",
      },
      {
        entry: "/repo/apps/device-gateway/src/main.ts",
        output: "/runtime/device-gateway.mjs",
      },
      {
        entry: "/repo/scripts/local-workspace-checks-mcp.mjs",
        output: "/runtime/local-workspace-checks-mcp.mjs",
      },
    ],
  );
});

test("desktop staging accepts only Node 24", () => {
  assert.doesNotThrow(() => assertNode24("v24.10.0"));
  assert.throws(() => assertNode24("v22.22.0"), /requires Node 24/u);
  assert.throws(() => assertNode24("v25.0.0"), /requires Node 24/u);
});

test("desktop staging ignores implicit class-field, path and extended configs in entries and dependencies", (context) => {
  const directory = mkdtempSync(
    join(tmpdir(), "crewon-fixed-runtime-tsconfig-"),
  );
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const write = (file: string, bytes: string) => {
    const path = join(directory, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  };
  for (const app of ["control-api", "runtime-worker", "device-gateway"]) {
    write(
      `apps/${app}/package.json`,
      JSON.stringify({ name: `@crewon/${app}` }),
    );
    write(`apps/${app}/src/main.ts`, "export const app = 1;\n");
  }
  write(".node-version", "24.18.1\n");
  write("pnpm-lock.yaml", "lockfileVersion: 9\n");
  write(
    "scripts/stage-desktop-runtime.ts",
    readFileSync(
      fileURLToPath(new URL("./stage-desktop-runtime.ts", import.meta.url)),
      "utf8",
    ),
  );
  for (const script of [
    "local-workspace-checks-mcp.mjs",
    "local-workspace-command-guard.mts",
    "local-workspace-commands.mts",
    "local-workspace-reads.mts",
  ])
    write(`scripts/${script}`, "export const script = 1;\n");
  write(
    "apps/control-api/src/main.ts",
    `
    import { value } from "fixture-alias";
    import { classFields } from "./lib/class-fields.ts";
    console.log(JSON.stringify({value,...classFields()}));
  `,
  );
  write(
    "apps/control-api/src/lib/class-fields.ts",
    `
    export function classFields() {
      let setterCalls = 0;
      class Base { set field(value: number) { setterCalls += value; } }
      class Derived extends Base { field = 1; }
      const instance = new Derived();
      return {setterCalls,ownField:Object.hasOwn(instance,"field")};
    }
  `,
  );
  write("apps/control-api/src/a.ts", 'export const value = "path-a";\n');
  write("apps/control-api/src/b.ts", 'export const value = "path-b";\n');
  write(
    "node_modules/fixture-alias/package.json",
    JSON.stringify({
      name: "fixture-alias",
      type: "module",
      exports: "./index.mjs",
    }),
  );
  write(
    "node_modules/fixture-alias/index.mjs",
    'export const value = "package-export";\n',
  );
  write(
    "apps/control-api/tsconfig.json",
    JSON.stringify({ extends: "./compiler-options.json" }),
  );
  const builds: { fingerprint: string; bytes: Buffer; behavior: unknown }[] =
    [];
  for (const [route, define] of [
    ["a", false],
    ["b", true],
  ] as const) {
    write(
      "apps/control-api/compiler-options.json",
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          useDefineForClassFields: define,
          baseUrl: ".",
          paths: { "fixture-alias": [`./src/${route}.ts`] },
        },
      }),
    );
    write(
      "apps/control-api/src/lib/tsconfig.json",
      JSON.stringify({
        compilerOptions: { target: "ES2022", useDefineForClassFields: define },
      }),
    );
    const fingerprint = readComfySourceFingerprint(directory);
    const output = join(directory, "control-api.mjs");
    bundleRuntime(
      { entry: join(directory, "apps/control-api/src/main.ts"), output },
      fingerprint,
    );
    builds.push({
      fingerprint,
      bytes: readFileSync(output),
      behavior: JSON.parse(
        execFileSync(process.execPath, [output], { encoding: "utf8" }),
      ),
    });
  }
  assert.equal(builds[0]!.fingerprint, builds[1]!.fingerprint);
  assert.deepEqual(builds[0]!.bytes, builds[1]!.bytes);
  for (const build of builds)
    assert.deepEqual(build.behavior, {
      value: "package-export",
      setterCalls: 0,
      ownField: true,
    });
});

test("independent desktop bundles share the source identity and verify their own bytes", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-extension-bundles-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const helper = fileURLToPath(
    new URL(
      "../packages/agent-version/src/extension-build.ts",
      import.meta.url,
    ),
  );
  const identity = getComfyImplementationDigest();
  const outputs = ["control-api", "runtime-worker", "runtime-release"].map(
    (name) => {
      const entry = join(directory, `${name}.ts`);
      const output = join(directory, `${name}.mjs`);
      writeFileSync(
        entry,
        `import { getComfyImplementationDigest } from ${JSON.stringify(helper)};\nconsole.log(JSON.stringify({ entry: ${JSON.stringify(name)}, digest: getComfyImplementationDigest() }));\n`,
      );
      bundleRuntime({ entry, output }, identity);
      return output;
    },
  );
  assert.throws(
    () => execFileSync(process.execPath, [outputs[0]!], { stdio: "pipe" }),
    /extension_build_identity_unavailable/u,
  );
  const buildIdentity = createExtensionBuildIdentity(identity, outputs);
  assert.equal(
    new Set(buildIdentity.bundles.map(({ digest }) => digest)).size,
    3,
  );
  writeFileSync(
    join(directory, EXTENSION_BUILD_IDENTITY_FILE),
    JSON.stringify(buildIdentity),
  );
  for (const [index, output] of outputs.entries()) {
    assert.deepEqual(
      JSON.parse(
        execFileSync(process.execPath, [output], { encoding: "utf8" }),
      ),
      {
        entry: ["control-api", "runtime-worker", "runtime-release"][index],
        digest: identity,
      },
    );
  }
  const scopedIdentity = createScopedExtensionBuildIdentity({
    implementationDigest: identity,
    bundlePaths: outputs,
  });
  assert.equal(
    scopedIdentity.schemaVersion,
    "crewon.extension-build-identity.v1",
  );
  writeFileSync(
    join(directory, EXTENSION_BUILD_IDENTITY_FILE),
    JSON.stringify(scopedIdentity),
  );
  assert.equal(
    JSON.parse(
      execFileSync(process.execPath, [outputs[1]!], { encoding: "utf8" }),
    ).digest,
    identity,
  );
  writeFileSync(
    join(directory, EXTENSION_BUILD_IDENTITY_FILE),
    JSON.stringify({
      ...scopedIdentity,
      historicalWorkItemScope: "crewon.extension-work-item-scope.v0",
    }),
  );
  // Legacy archives remain verifiable; historical execution requires the newer
  // capability and is rejected separately by the retained Worker launcher.
  assert.equal(
    JSON.parse(
      execFileSync(process.execPath, [outputs[1]!], { encoding: "utf8" }),
    ).digest,
    identity,
  );
  writeFileSync(
    join(directory, EXTENSION_BUILD_IDENTITY_FILE),
    JSON.stringify({
      ...scopedIdentity,
      historicalWorkItemScope: "unknown-scope",
    }),
  );
  assert.throws(
    () => execFileSync(process.execPath, [outputs[1]!], { stdio: "pipe" }),
    /extension_build_identity_invalid/u,
  );
  writeFileSync(
    join(directory, EXTENSION_BUILD_IDENTITY_FILE),
    JSON.stringify(scopedIdentity),
  );
  appendFileSync(outputs[1]!, "\n// artifact drift\n");
  assert.throws(
    () => execFileSync(process.execPath, [outputs[1]!], { stdio: "pipe" }),
    /extension_build_identity_mismatch/u,
  );
  assert.equal(
    JSON.parse(
      execFileSync(process.execPath, [outputs[0]!], { encoding: "utf8" }),
    ).digest,
    identity,
  );
  writeFileSync(
    join(directory, EXTENSION_BUILD_IDENTITY_FILE),
    JSON.stringify({
      ...buildIdentity,
      implementationDigest: `sha256:${"0".repeat(64)}`,
    }),
  );
  assert.throws(
    () => execFileSync(process.execPath, [outputs[0]!], { stdio: "pipe" }),
    /extension_build_identity_invalid/u,
  );
});

test("a loaded bundle rejects replacement even when a rewritten sidecar matches disk", (context) => {
  const directory = mkdtempSync(
    join(tmpdir(), "crewon-extension-live-bundle-"),
  );
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const helper = fileURLToPath(
    new URL(
      "../packages/agent-version/src/extension-build.ts",
      import.meta.url,
    ),
  );
  const entry = join(directory, "runtime-worker.ts");
  const output = join(directory, "runtime-worker.mjs");
  const identity = getComfyImplementationDigest();
  writeFileSync(
    entry,
    `
    import { appendFileSync, writeFileSync } from 'node:fs';
    import { dirname, join } from 'node:path';
    import { fileURLToPath } from 'node:url';
    import { getComfyImplementationDigest, createExtensionBuildIdentity, EXTENSION_BUILD_IDENTITY_FILE } from ${JSON.stringify(helper)};
    const actual = getComfyImplementationDigest();
    const ownPath = fileURLToPath(import.meta.url);
    appendFileSync(ownPath, '\\n// replacement\\n');
    writeFileSync(join(dirname(ownPath), EXTENSION_BUILD_IDENTITY_FILE), JSON.stringify(createExtensionBuildIdentity(actual, [ownPath])));
    try { getComfyImplementationDigest(); process.exit(1); }
    catch (error) { console.log(error.message); }
  `,
  );
  bundleRuntime({ entry, output }, identity);
  writeFileSync(
    join(directory, EXTENSION_BUILD_IDENTITY_FILE),
    JSON.stringify(createExtensionBuildIdentity(identity, [output])),
  );
  assert.equal(
    execFileSync(process.execPath, [output], { encoding: "utf8" }).trim(),
    "extension_build_identity_mismatch",
  );
});
