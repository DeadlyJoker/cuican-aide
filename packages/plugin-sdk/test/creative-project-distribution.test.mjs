import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = resolve(packageRoot, "../..");
const packageManager = JSON.parse(
  await readFile(join(repositoryRoot, "package.json"), "utf8"),
).packageManager;
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const require = createRequire(import.meta.url);
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

test("creative project declarations and UI methods work from a real offline tarball without private or ambient dependencies", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "crewon-creative-project-sdk-"),
  );
  try {
    assert.equal(directory.startsWith(repositoryRoot), false);
    execFileSync(pnpm, ["pack", "--pack-destination", directory, "--json"], {
      cwd: packageRoot,
      encoding: "utf8",
      timeout: 60000,
    });
    const tarball = (await readdir(directory)).find((name) =>
      name.endsWith(".tgz"),
    );
    assert.ok(tarball);
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name: "external-creative-project-fixture",
        private: true,
        packageManager,
        type: "module",
        dependencies: { "@crewon/plugin-sdk": `file:./${tarball}` },
      }),
    );
    execFileSync(
      pnpm,
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--config.minimumReleaseAge=0",
      ],
      { cwd: directory, encoding: "utf8", timeout: 60000 },
    );
    const sdk = join(directory, "node_modules/@crewon/plugin-sdk");
    const manifest = JSON.parse(
      await readFile(join(sdk, "package.json"), "utf8"),
    );
    assert.equal(manifest.version, "0.1.2");
    assert.deepEqual(manifest.dependencies ?? {}, {});
    assert.deepEqual(manifest.peerDependencies ?? {}, {});
    assert.deepEqual(Object.keys(manifest.exports).sort(), [
      "./contracts",
      "./node",
      "./project-foundation-tools",
      "./project-foundation-ui",
      "./project-source-uploads",
      "./ui",
    ]);
    assert.equal(
      (await readdir(join(directory, "node_modules/@crewon"))).includes(
        "contracts",
      ),
      false,
    );
    const pending = [join(sdk, "dist")];
    while (pending.length) {
      const current = pending.pop();
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const path = join(current, entry.name);
        if (entry.isDirectory()) pending.push(path);
        else if (entry.name.endsWith(".js") || entry.name.endsWith(".d.ts")) {
          const source = await readFile(path, "utf8");
          assert.doesNotMatch(
            source,
            /@crewon\/contracts|@crewon\/domain|react|\/Users\//u,
          );
          for (const [, specifier] of source.matchAll(
            /\b(?:from\s+|import\s*(?:\(\s*)?)["']([^"']+)["']/gu,
          )) {
            assert.match(specifier, /^\.\.?\//u);
            const destination = resolve(
              dirname(path),
              entry.name.endsWith(".d.ts")
                ? specifier.replace(/\.js$/u, ".d.ts")
                : specifier,
            );
            const within = relative(join(sdk, "dist"), destination);
            assert.equal(isAbsolute(within), false);
            assert.notEqual(within, "..");
            assert.equal(within.startsWith(`..${sep}`), false);
            await readFile(destination);
          }
        }
      }
    }
    for (const name of [
      "external-project-foundation-tools-node.ts",
      "external-project-source-uploads.ts",
      "external-project-source-uploads-ui.ts",
      "project-source-upload-responses.mjs",
      "project-source-uploads-distribution-runner.mjs",
      "external-project-foundation.ts",
      "external-project-foundation-ui.ts",
      "project-foundation-responses.mjs",
      "project-foundation-distribution-runner.mjs",
      "external-creative-project-contracts.ts",
      "external-creative-project-ui.ts",
      "external-project-generation-contracts.ts",
      "external-project-generation-ui.ts",
      "external-project-generation-read-contracts.ts",
      "external-project-generation-read-ui.ts",
      "external-project-generation-context-contracts.ts",
      "external-project-generation-context-ui.ts",
      "external-project-generation-selection-contracts.ts",
      "external-project-generation-selection-ui.ts",
      "creative-project-responses.mjs",
      "creative-project-distribution-runner.mjs",
    ])
      await cp(join(fixtures, name), join(directory, name));
    const base = {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      skipLibCheck: false,
      types: [],
      outDir: "dist",
      rootDir: ".",
    };
    for (const [name, lib, files] of [
      [
        "pure",
        ["ES2022"],
        [
          "external-project-foundation-tools-node.ts",
          "external-project-source-uploads.ts",
          "external-project-foundation.ts",
          "external-creative-project-contracts.ts",
          "external-project-generation-contracts.ts",
          "external-project-generation-read-contracts.ts",
          "external-project-generation-context-contracts.ts",
          "external-project-generation-selection-contracts.ts",
        ],
      ],
      [
        "ui",
        ["ES2022", "DOM"],
        [
          "external-project-source-uploads.ts",
          "external-project-source-uploads-ui.ts",
          "external-project-foundation.ts",
          "external-project-foundation-ui.ts",
          "external-creative-project-contracts.ts",
          "external-creative-project-ui.ts",
          "external-project-generation-contracts.ts",
          "external-project-generation-ui.ts",
          "external-project-generation-read-contracts.ts",
          "external-project-generation-read-ui.ts",
          "external-project-generation-context-contracts.ts",
          "external-project-generation-context-ui.ts",
          "external-project-generation-selection-contracts.ts",
          "external-project-generation-selection-ui.ts",
        ],
      ],
    ]) {
      const path = join(directory, `tsconfig.${name}.json`);
      await writeFile(
        path,
        JSON.stringify({ compilerOptions: { ...base, lib }, files }),
      );
      assert.equal(
        execFileSync(
          process.execPath,
          [require.resolve("typescript/bin/tsc"), "-p", path],
          { cwd: directory, encoding: "utf8", timeout: 60000 },
        ).trim(),
        "",
      );
    }
    const executed = execFileSync(
      process.execPath,
      [join(directory, "creative-project-distribution-runner.mjs")],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 10000,
        env: { ...process.env, NODE_PATH: "" },
      },
    );
    assert.match(
      executed,
      /independent UI helper invoked fourteen existing-ABI actions/u,
    );
    assert.match(
      executed,
      /Independent saved-source generation helper preserved the original task receipt/u,
    );
    assert.match(
      executed,
      /Independent saved-source read helper recovered the original task/u,
    );
    assert.match(
      executed,
      /Independent readiness helper returned a bounded hint without submitting a task/u,
    );
    assert.match(
      executed,
      /Independent foundation client compiled without DOM and with original UI services, invoked twelve bounded actions and enforced native cancellation/u,
    );
    assert.match(
      executed,
      /Independent upload client compiled without DOM and with original UI services, invoked four JSON actions and a separate bounded native byte port/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
