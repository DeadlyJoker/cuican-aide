import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
test("portable execution ABI stays structurally compatible with the original host runtime and native signal", () => {
  const output = execFileSync(
    process.execPath,
    [
      require.resolve("typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "false",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      "--lib",
      "ES2022",
      "--types",
      "node",
      "--allowImportingTsExtensions",
      fileURLToPath(
        new URL(
          "./fixtures/tool-runtime-compatibility.test-support.ts",
          import.meta.url,
        ),
      ),
    ],
    { encoding: "utf8", timeout: 60000 },
  );
  assert.equal(output.trim(), "");
});
