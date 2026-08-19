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
      artifactStore: true,
    },
    {
      file: "runtime-worker.Dockerfile",
      component: "runtime-worker",
      command: 'CMD ["node", "/app/runtime-worker.mjs"]',
      artifactStore: true,
    },
    {
      file: "web-bff.Dockerfile",
      component: "web-bff",
      command: 'CMD ["node", "/app/web-bff.mjs"]',
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
    assert.match(content, /! grep -aEi/u);
    assert.match(
      content,
      new RegExp(`com\\.crewon\\.component="${fixture.component}"`, "u"),
    );
    assert.match(content, /com\.crewon\.runtime="typescript"/u);
    if (fixture.artifactStore === true) {
      assert.match(content, /chown node:node \/var\/lib\/crewon\/artifacts/u);
    }
    assert.match(content, /^USER node$/mu);
    assert.equal(content.match(/^CMD /gmu)?.length, 1);
    assert.ok(content.includes(fixture.command));
    assert.doesNotMatch(
      content
        .split("\n")
        .filter((line) => !line.includes("grep -aEi"))
        .join("\n"),
      forbiddenCompatibility,
    );
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
  assert.match(worker, /src\/release-rollback-main\.ts/u);
  assert.match(
    worker,
    /\/out\/release-rollback-main\.mjs \.\/init\/release-rollback-main\.mjs/u,
  );
  assert.match(worker, /production-backup-main\.mjs/u);
  assert.match(worker, /apk add --no-cache postgresql16-client/u);
});

test("static Web edge runs non-root with a no-eval browser policy", async () => {
  const [dockerfile, nginx, compose] = await Promise.all([
    readFile(join(import.meta.dirname, "web.Dockerfile"), "utf8"),
    readFile(join(import.meta.dirname, "nginx.conf"), "utf8"),
    readFile(join(import.meta.dirname, "compose.production.yml"), "utf8"),
  ]);

  assert.match(dockerfile, /^USER nginx$/mu);
  assert.match(dockerfile, /\/tmp\/nginx\.pid/u);
  assert.match(nginx, /client_body_temp_path \/tmp\/client-body;/u);
  assert.match(nginx, /proxy_temp_path \/tmp\/proxy;/u);
  assert.match(nginx, /fastcgi_temp_path \/tmp\/fastcgi;/u);
  assert.match(nginx, /uwsgi_temp_path \/tmp\/uwsgi;/u);
  assert.match(nginx, /scgi_temp_path \/tmp\/scgi;/u);
  assert.match(nginx, /Content-Security-Policy/u);
  assert.match(nginx, /script-src 'self'/u);
  assert.match(nginx, /style-src 'self' 'unsafe-inline'/u);
  assert.match(nginx, /frame-ancestors 'none'/u);
  assert.doesNotMatch(nginx, /unsafe-eval/u);
  assert.match(compose, /web:[\s\S]*?cap_drop:\s*\n\s*- ALL/u);
  assert.match(
    compose,
    /web:[\s\S]*?- \/tmp:size=64m,mode=1777,nosuid,nodev,noexec/u,
  );
});

test("production entries create self-contained bundles without compatibility code", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "crewon-production-bundles-"),
  );
  try {
    const entries = [
      ["@crewon/control-api", "src/main.ts", "control-api.mjs"],
      ["@crewon/web-bff", "src/main.ts", "web-bff.mjs"],
      ["@crewon/runtime-worker", "src/main.ts", "runtime-worker.mjs"],
      ["@crewon/runtime-worker", "src/release-main.ts", "release-main.mjs"],
      [
        "@crewon/runtime-worker",
        "src/release-rollback-main.ts",
        "release-rollback-main.mjs",
      ],
      [
        "@crewon/runtime-worker",
        "../../scripts/production-backup-main.mjs",
        "production-backup-main.mjs",
      ],
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
