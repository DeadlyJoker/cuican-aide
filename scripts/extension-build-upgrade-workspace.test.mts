import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { verifyWorkspacePackageLinks } from "./extension-build-upgrade.test-support.mts";

const digest = "copied-workspace-fixture-digest";

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function fixture(context: TestContext): string {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "crewon-workspace-links-")),
  );
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const packages = {
    "agent-version": {
      ".": "./src/index.ts",
      "./extension-build": "./src/extension-build.ts",
    },
    "copied-fixture": {
      ".": { import: "./dist/index.js", require: "./dist/index.cjs" },
    },
    "plugin-sdk": Object.fromEntries(
      ["contracts", "node", "ui"].map((entry) => [
        `./${entry}`,
        {
          types: `./dist/types/${entry}.d.ts`,
          import: `./dist/${entry}.js`,
        },
      ]),
    ),
  };
  for (const [name, exports] of Object.entries(packages)) {
    write(
      join(root, "packages", name, "package.json"),
      JSON.stringify({
        name: `@crewon/${name}`,
        type: "module",
        exports,
      }),
    );
  }
  write(join(root, "packages/agent-version/src/index.ts"), "export {};\n");
  write(
    join(root, "packages/agent-version/src/extension-build.ts"),
    `export function getComfyImplementationDigest() { return ${JSON.stringify(digest)}; }\n`,
  );
  write(
    join(root, "packages/copied-fixture/dist/index.js"),
    "export default true;\n",
  );
  write(
    join(root, "packages/copied-fixture/dist/index.cjs"),
    "module.exports = true;\n",
  );
  for (const entry of ["contracts", "node", "ui"])
    write(
      join(root, "packages/plugin-sdk/dist", `${entry}.js`),
      "export default true;\n",
    );
  for (const app of ["control-api", "runtime-worker", "device-gateway"]) {
    const directory = join(root, "apps", app);
    write(
      join(directory, "package.json"),
      JSON.stringify({
        type: "module",
        dependencies: Object.fromEntries(
          Object.keys(packages).map((name) => [
            `@crewon/${name}`,
            "workspace:*",
          ]),
        ),
      }),
    );
    const scope = join(directory, "node_modules/@crewon");
    mkdirSync(scope, { recursive: true });
    for (const name of Object.keys(packages))
      symlinkSync(
        join(root, "packages", name),
        join(scope, name),
        process.platform === "win32" ? "junction" : "dir",
      );
  }
  return root;
}

function replaceWithEscapedEntry(root: string, entry: string): void {
  const outside = join(root, "outside-package-entry.js");
  write(outside, "export default true;\n");
  rmSync(join(root, entry));
  symlinkSync(outside, join(root, entry));
}

test("checks every SDK import-only subpath without requiring a root export", async (context) => {
  const root = fixture(context);
  const require = createRequire(join(root, "apps/control-api/package.json"));
  assert.throws(() => require.resolve("@crewon/plugin-sdk"), {
    code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
  });
  assert.throws(() => require.resolve("@crewon/plugin-sdk/node"), {
    code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
  });
  assert.equal(await verifyWorkspacePackageLinks(root, context.signal), digest);
});

test("rejects a missing SDK UI entry even when its node entry exists", async (context) => {
  const root = fixture(context);
  rmSync(join(root, "packages/plugin-sdk/dist/ui.js"));
  await assert.rejects(
    verifyWorkspacePackageLinks(root, context.signal),
    /plugin-sdk\/dist\/ui\.js/,
  );
});

test("rejects an SDK public import resolving outside the copied package", async (context) => {
  const root = fixture(context);
  replaceWithEscapedEntry(root, "packages/plugin-sdk/dist/ui.js");
  await assert.rejects(
    verifyWorkspacePackageLinks(root, context.signal),
    /@crewon\/plugin-sdk\/ui resolved outside copied package/,
  );
});

test("preserves the private dependency root require path check", async (context) => {
  const root = fixture(context);
  replaceWithEscapedEntry(root, "packages/copied-fixture/dist/index.cjs");
  await assert.rejects(
    verifyWorkspacePackageLinks(root, context.signal),
    /@crewon\/copied-fixture resolved outside copied package/,
  );
});

test("also checks the private dependency root import condition", async (context) => {
  const root = fixture(context);
  replaceWithEscapedEntry(root, "packages/copied-fixture/dist/index.js");
  await assert.rejects(
    verifyWorkspacePackageLinks(root, context.signal),
    /@crewon\/copied-fixture resolved outside copied package/,
  );
});
