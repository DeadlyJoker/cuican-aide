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

test("the real tarball installs offline outside the workspace, compiles independent plugins and runs compiled ABI", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "crewon-plugin-sdk-distribution-"),
  );
  try {
    assert.equal(directory.startsWith(repositoryRoot), false);
    const packed = execFileSync(
      pnpm,
      ["pack", "--pack-destination", directory, "--json"],
      {
        cwd: packageRoot,
        encoding: "utf8",
        timeout: 60000,
      },
    );
    const tarball = (await readdir(directory)).find((name) =>
      name.endsWith(".tgz"),
    );
    assert.ok(tarball, packed);
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify(
        {
          name: "external-crewon-plugin-fixture",
          private: true,
          packageManager,
          type: "module",
          dependencies: { "@crewon/plugin-sdk": `file:./${tarball}` },
        },
        null,
        2,
      ),
    );
    // This is an actual isolated package-manager install, with no registry or workspace dependencies.
    const installed = execFileSync(
      pnpm,
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--config.minimumReleaseAge=0",
      ],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 60000,
      },
    );
    const sdk = join(directory, "node_modules/@crewon/plugin-sdk");
    const manifest = JSON.parse(
      await readFile(join(sdk, "package.json"), "utf8"),
    );
    assert.equal(manifest.private, false);
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
    assert.equal((await readdir(sdk)).includes("src"), false);
    assert.equal((await readdir(sdk)).includes("scripts"), false);
    assert.equal(
      (await readdir(join(directory, "node_modules/@crewon"))).includes(
        "contracts",
      ),
      false,
    );
    assert.equal(
      await readFile(join(sdk, "dist/LICENSE"), "utf8"),
      await readFile(join(repositoryRoot, "LICENSE"), "utf8"),
    );
    assert.equal(
      await readFile(join(sdk, "dist/NOTICE"), "utf8"),
      await readFile(join(repositoryRoot, "NOTICE"), "utf8"),
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
            const resolved = resolve(
              dirname(path),
              entry.name.endsWith(".d.ts")
                ? specifier.replace(/\.js$/u, ".d.ts")
                : specifier,
            );
            const withinDistribution = relative(join(sdk, "dist"), resolved);
            assert.equal(isAbsolute(withinDistribution), false);
            assert.notEqual(withinDistribution, "..");
            assert.equal(withinDistribution.startsWith(`..${sep}`), false);
            await readFile(resolved);
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
      "external-node.ts",
      "external-task-node.ts",
      "external-execution-node.ts",
      "external-optional-node.ts",
      "external-project-historical-query-node.ts",
      "external-project-historical-query-ui.ts",
      "external-ui.ts",
      "type-boundaries.ts",
      "distribution-runner.mjs",
      "execution-distribution-runner.mjs",
      "optional-distribution-runner.mjs",
    ])
      await cp(join(fixtures, name), join(directory, name));
    await writeFile(
      join(directory, "tsconfig.node.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            lib: ["ES2022"],
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            skipLibCheck: false,
            types: [],
            outDir: "dist",
            rootDir: ".",
          },
          files: [
            "external-project-foundation-tools-node.ts",
            "external-project-source-uploads.ts",
            "external-project-foundation.ts",
            "external-node.ts",
            "external-task-node.ts",
            "external-execution-node.ts",
            "external-optional-node.ts",
            "external-project-historical-query-node.ts",
          ],
        },
        null,
        2,
      ),
    );
    execFileSync(
      process.execPath,
      [
        require.resolve("typescript/bin/tsc"),
        "-p",
        join(directory, "tsconfig.node.json"),
      ],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 60000,
      },
    );
    await writeFile(
      join(directory, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            lib: ["ES2022", "DOM"],
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            skipLibCheck: false,
            types: [],
            outDir: "dist",
            rootDir: ".",
          },
          include: ["*.ts"],
        },
        null,
        2,
      ),
    );
    const compiled = execFileSync(
      process.execPath,
      [
        require.resolve("typescript/bin/tsc"),
        "-p",
        join(directory, "tsconfig.json"),
      ],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 60000,
      },
    );
    assert.equal(compiled.trim(), "");
    // The compiler executable is a development tool; every resolved plugin dependency lives in this fixture's install.
    const executed = execFileSync(
      process.execPath,
      [join(directory, "distribution-runner.mjs")],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 10000,
        env: { ...process.env, NODE_PATH: "" },
      },
    );
    assert.match(
      executed,
      /Node setup, service ABI and cleanup passed; UI ABI compiled and validated/u,
    );
    assert.match(executed, /Task and action ABI compiled and invoked/u);
    assert.match(
      executed,
      /Execution factory ABI compiled Node-only and invoked/u,
    );
    assert.match(
      executed,
      /Optional service ABI compiled Node-only and invoked in both contexts; old host rejected explicitly/u,
    );
    console.log(installed.trim());
    console.log(executed.trim());
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
