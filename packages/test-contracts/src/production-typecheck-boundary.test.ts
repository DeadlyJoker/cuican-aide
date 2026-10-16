import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const testSource = /\.(?:test|test-support|fixture)\.tsx?$/u;

for (const app of ["control-api", "runtime-worker"]) {
  test(`${app} production typecheck excludes test dependencies while the full check retains them`, () => {
    const appRoot = path.join(root, "apps", app);
    const config = (name: string) => {
      const file = path.join(appRoot, name);
      const loaded = ts.readConfigFile(file, ts.sys.readFile);
      assert.equal(loaded.error, undefined);
      const parsed = ts.parseJsonConfigFileContent(
        loaded.config,
        ts.sys,
        appRoot,
      );
      assert.deepEqual(parsed.errors, []);
      return parsed;
    };
    const full = config("tsconfig.json");
    const production = config("tsconfig.production.json");
    assert.ok(full.fileNames.some((file) => testSource.test(file)));
    assert.deepEqual(
      production.fileNames.sort(),
      full.fileNames.filter((file) => !testSource.test(file)).sort(),
      "Every production root must remain included",
    );
    const manifest = JSON.parse(
      readFileSync(path.join(appRoot, "package.json"), "utf8"),
    );
    assert.equal(manifest.scripts.typecheck, "tsc -p tsconfig.json --noEmit");
    assert.equal(
      manifest.scripts["typecheck:production"],
      "tsc -p tsconfig.production.json --noEmit",
    );

    // TypeScript exclude only controls roots: an imported test or sibling app
    // still enters the program. Inspect the resolved graph, not just config text.
    const program = ts.createProgram(production.fileNames, production.options);
    const violations = program.getSourceFiles().flatMap((source) => {
      const file = path.resolve(source.fileName);
      if (file.includes(`${path.sep}node_modules${path.sep}`)) return [];
      if (testSource.test(file))
        return [`test dependency: ${path.relative(root, file)}`];
      if (
        file.startsWith(path.join(root, "apps") + path.sep) &&
        !file.startsWith(appRoot + path.sep)
      ) {
        return [`sibling app dependency: ${path.relative(root, file)}`];
      }
      return [];
    });
    assert.deepEqual(violations, []);
  });
}
