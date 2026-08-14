import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const workspace = resolve(import.meta.dirname, "../..");
const execFileAsync = promisify(execFile);
const forbiddenCompatibility =
  /deterministic[ _-]?fake|device[ _-]?gateway|app[ _-]?server|6176/iu;

test("production Dockerfiles pin a reproducible non-root TypeScript runtime", async () => {
  const fixtures = [
    {
      file: "control-api.Dockerfile",
      component: "control-api",
      command: 'CMD ["node", "/app/control-api.mjs"]',
    },
    {
      file: "runtime-worker.Dockerfile",
      component: "runtime-worker",
      command: 'CMD ["node", "/app/runtime-worker.mjs"]',
    },
  ];

  for (const fixture of fixtures) {
    const content = await readFile(
      join(import.meta.dirname, fixture.file),
      "utf8",
    );
    assert.match(content, /^ARG NODE_IMAGE=node:24\.18\.1-alpine$/mu);
    assert.match(content, /pnpm install --frozen-lockfile/u);
    assert.match(content, /--bundle/u);
    assert.match(content, /--platform=node/u);
    assert.match(content, /--target=node24/u);
    assert.match(
      content,
      new RegExp(`com\\.crewon\\.component="${fixture.component}"`, "u"),
    );
    assert.match(content, /com\.crewon\.runtime="typescript"/u);
    assert.match(content, /^USER node$/mu);
    assert.equal(content.match(/^CMD /gmu)?.length, 1);
    assert.ok(content.includes(fixture.command));
    assert.doesNotMatch(content, forbiddenCompatibility);
  }

  const worker = await readFile(
    join(import.meta.dirname, "runtime-worker.Dockerfile"),
    "utf8",
  );
  assert.match(
    worker,
    /com\.crewon\.init-bundle="\/app\/init\/release-main\.mjs"/u,
  );
  assert.match(worker, /src\/release-main\.ts/u);
  assert.match(worker, /\/out\/release-main\.mjs \.\/init\/release-main\.mjs/u);
});

test("production entries create self-contained bundles without compatibility code", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "crewon-production-bundles-"),
  );
  try {
    const entries = [
      ["@crewon/control-api", "src/main.ts", "control-api.mjs"],
      ["@crewon/runtime-worker", "src/main.ts", "runtime-worker.mjs"],
      ["@crewon/runtime-worker", "src/release-main.ts", "release-main.mjs"],
    ];
    await Promise.all(
      entries.map(([filter, entryPoint, output]) =>
        execFileAsync(
          "corepack",
          [
            "pnpm",
            "--filter",
            filter,
            "exec",
            "esbuild",
            entryPoint,
            "--bundle",
            "--format=esm",
            "--platform=node",
            "--target=node24",
            `--outfile=${join(outputDirectory, output)}`,
          ],
          { cwd: workspace },
        ),
      ),
    );

    for (const [, , output] of entries) {
      const bundle = await readFile(join(outputDirectory, output), "utf8");
      assert.doesNotMatch(bundle, /from\s+["']@crewon\//u);
      assert.doesNotMatch(bundle, forbiddenCompatibility);
    }
  } finally {
    await rm(outputDirectory, { recursive: true });
  }
});
