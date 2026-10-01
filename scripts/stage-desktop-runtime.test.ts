import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertNode24,
  bundleRuntime,
  runtimeBundleSpecs,
} from "./stage-desktop-runtime.ts";
import {
  createExtensionBuildIdentity,
  EXTENSION_BUILD_IDENTITY_FILE,
  getComfyImplementationDigest,
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
