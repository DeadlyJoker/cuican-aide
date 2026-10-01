import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertComfyImplementationDigest,
  getComfyImplementationDigest,
  readComfySourceFingerprint,
} from "./extension-build.ts";

function fixture(context: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "crewon-extension-source-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path: string, content: string) => {
    const file = join(root, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, content);
  };
  write(
    "apps/runtime-worker/package.json",
    JSON.stringify({
      name: "@crewon/runtime-worker",
      dependencies: { "@crewon/contracts": "workspace:*" },
    }),
  );
  write(
    "apps/runtime-worker/src/extensions/comfy.ts",
    "export const adapter = 'v1';\n",
  );
  write(
    "packages/contracts/package.json",
    JSON.stringify({
      name: "@crewon/contracts",
      dependencies: { "@crewon/domain": "workspace:*" },
    }),
  );
  write("packages/contracts/src/index.ts", "export const contract = 'v1';\n");
  write(
    "packages/domain/package.json",
    JSON.stringify({ name: "@crewon/domain" }),
  );
  write("packages/domain/src/index.ts", "export const domain = 'v1';\n");
  write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  write(".node-version", "24.18.1\n");
  write(
    "scripts/stage-desktop-runtime.ts",
    "export const target = 'node24';\n",
  );
  return { root, write };
}

test("source identity covers actual production bytes and transitive private dependencies", (context) => {
  const { root, write } = fixture(context);
  const original = readComfySourceFingerprint(root);
  assert.match(original, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(readComfySourceFingerprint(root), original);
  write("packages/domain/src/index.ts", "export const domain = 'v2';\n");
  assert.notEqual(readComfySourceFingerprint(root), original);
  const changedDependency = readComfySourceFingerprint(root);
  write(
    "apps/runtime-worker/src/comfy-host.ts",
    "export const host = 'new';\n",
  );
  assert.notEqual(readComfySourceFingerprint(root), changedDependency);
});

test("test edits leave identity stable while pin, build and dependency lock edits invalidate it", (context) => {
  const { root, write } = fixture(context);
  const original = readComfySourceFingerprint(root);
  write("apps/runtime-worker/src/comfy.test.ts", "throw new Error('test');\n");
  write(
    "packages/domain/src/domain.test-support.ts",
    "export const fixture = 1;\n",
  );
  write(
    "packages/contracts/src/fixtures/sample.ts",
    "export const fixture = 2;\n",
  );
  assert.equal(readComfySourceFingerprint(root), original);
  write("pnpm-lock.yaml", "lockfileVersion: '9.0'\nsnapshots: {}\n");
  const lockChanged = readComfySourceFingerprint(root);
  assert.notEqual(lockChanged, original);
  write(".node-version", "24.19.0\n");
  const nodeChanged = readComfySourceFingerprint(root);
  assert.notEqual(nodeChanged, lockChanged);
  write(
    "scripts/stage-desktop-runtime.ts",
    "export const target = 'changed';\n",
  );
  assert.notEqual(readComfySourceFingerprint(root), nodeChanged);
});

test("source identity rejects missing, oversized, symlinked or escaped production inputs", (context) => {
  const { root, write } = fixture(context);
  symlinkSync(
    join(root, "packages/domain/src/index.ts"),
    join(root, "apps/runtime-worker/src/linked.ts"),
  );
  assert.throws(
    () => readComfySourceFingerprint(root),
    /extension_source_identity_invalid/u,
  );
  rmSync(join(root, "apps/runtime-worker/src/linked.ts"));
  write("apps/runtime-worker/src/large.ts", "a".repeat(2 * 1024 * 1024 + 1));
  assert.throws(
    () => readComfySourceFingerprint(root),
    /extension_source_identity_invalid/u,
  );
  rmSync(join(root, "apps/runtime-worker/src/large.ts"));
  write(
    "apps/runtime-worker/package.json",
    JSON.stringify({
      name: "@crewon/runtime-worker",
      dependencies: { "@crewon/../outside": "workspace:*" },
    }),
  );
  assert.throws(
    () => readComfySourceFingerprint(root),
    /extension_source_identity_invalid/u,
  );
});

test("production accessor and saved-code check use the current source fingerprint", () => {
  const actual = getComfyImplementationDigest();
  assert.match(actual, /^sha256:[a-f0-9]{64}$/u);
  assert.doesNotThrow(() => assertComfyImplementationDigest(actual));
  assert.throws(
    () => assertComfyImplementationDigest(`sha256:${"0".repeat(64)}`),
    /extension_implementation_mismatch/u,
  );
  assert.throws(
    () => assertComfyImplementationDigest("claimed"),
    /extension_implementation_mismatch/u,
  );
});

test("a loaded source process cannot claim edited disk code as its own implementation", (context) => {
  const { root, write } = fixture(context);
  const helper = join(root, "packages/agent-version/src/extension-build.ts");
  write(
    "packages/agent-version/src/extension-build.ts",
    readFileSync(
      fileURLToPath(new URL("./extension-build.ts", import.meta.url)),
      "utf8",
    ),
  );
  const source = join(root, "apps/runtime-worker/src/extensions/comfy.ts");
  const result = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import { writeFileSync } from 'node:fs';
    const { getComfyImplementationDigest } = await import(${JSON.stringify(pathToFileURL(helper).href)});
    getComfyImplementationDigest();
    writeFileSync(${JSON.stringify(source)}, "export const adapter = 'changed';\\n");
    try { getComfyImplementationDigest(); process.exit(1); }
    catch (error) { console.log(error.message); }
  `,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  assert.equal(result.trim(), "extension_source_changed_since_load");
});
