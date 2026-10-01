import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  chmodSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createExtensionBuildIdentity,
  createScopedExtensionBuildIdentity,
  EXTENSION_BUILD_IDENTITY_FILE,
  retainExtensionBuild,
} from "../packages/agent-version/src/extension-build.ts";
import {
  parseRetainedExtensionWorkerSelection,
  retainedExtensionWorkerLaunchPlan,
} from "./retained-extension-worker.ts";

const implementationDigest = `sha256:${"a".repeat(64)}`;
const environment = {
  CREWON_EXTENSIONS_ENABLED: "1",
  CREWON_PRINCIPAL_ID: "principal",
  CREWON_ACTOR_ID: "actor",
  CREWON_TENANT_ID: "tenant",
  CREWON_SPACE_ID: "space",
  CREWON_EXTENSION_HOST_PORT: "0",
  CREWON_EXTENSION_HOST_TOKEN: "operator-private-token-with-32-bytes",
  CREWON_EXTENSION_RUNTIME_BINDINGS_PATH: "/immutable/bindings.json",
  CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH: "/immutable/assets.json",
};

test("operator selection pins both identities and rejects path overrides or ambiguous arguments", () => {
  const args = [
    "--data-root",
    "/data",
    "--implementation-digest",
    implementationDigest,
    "--build-identity-digest",
    `sha256:${"b".repeat(64)}`,
  ];
  assert.ok(Object.isFrozen(parseRetainedExtensionWorkerSelection(args)));
  for (const invalid of [
    args.slice(0, 4),
    [...args, "--worker-path", "/arbitrary.mjs"],
    args.map((value) => (value === "/data" ? "./data" : value)),
    args.map((value) =>
      value === implementationDigest
        ? implementationDigest.toUpperCase()
        : value,
    ),
  ])
    assert.throws(
      () => parseRetainedExtensionWorkerSelection(invalid),
      /arguments_invalid/u,
    );
});

test("recovery launches only the verified retained Worker and forces historical mode", async (context) => {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "crewon-retained-launcher-")),
  );
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "runtime-worker.mjs");
  const audit = join(directory, "audit.json");
  // This is a launcher fixture, not the production Worker or an execution permission proof.
  writeFileSync(
    source,
    `import {writeFileSync} from 'node:fs';writeFileSync(process.env.AUDIT_PATH,JSON.stringify({mode:process.env.CREWON_EXTENSION_EXECUTION_MODE,archiveRoot:process.env.CREWON_EXTENSION_BUILD_ARCHIVE_DATA_ROOT??null}));`,
  );
  writeFileSync(
    join(directory, EXTENSION_BUILD_IDENTITY_FILE),
    JSON.stringify(
      createScopedExtensionBuildIdentity({
        implementationDigest,
        bundlePaths: [source],
      }),
    ),
  );
  const retained = await retainExtensionBuild({
    dataRoot: directory,
    currentBuildDirectory: directory,
    expectedImplementationDigest: implementationDigest,
  });
  const selection = {
    dataRoot: directory,
    implementationDigest,
    buildIdentityDigest: retained.buildIdentityDigest,
  };
  const mutableEnvironment = {
    ...environment,
    AUDIT_PATH: audit,
    CREWON_EXTENSION_BUILD_ARCHIVE_DATA_ROOT: "/untrusted-ambient",
  };
  const pending = retainedExtensionWorkerLaunchPlan({
    selection,
    environment: mutableEnvironment,
  });
  mutableEnvironment.CREWON_ACTOR_ID = "changed-after-await";
  const plan = await pending;
  assert.equal(plan.workerPath, join(retained.directory, "runtime-worker.mjs"));
  assert.equal(plan.environment.CREWON_ACTOR_ID, "actor");
  assert.equal(plan.environment.CREWON_EXTENSION_EXECUTION_MODE, "historical");
  assert.equal(
    plan.environment.CREWON_EXTENSION_BUILD_ARCHIVE_DATA_ROOT,
    undefined,
  );
  assert.ok(Object.isFrozen(plan.environment));
  const cli = fileURLToPath(
    new URL("./retained-extension-worker.ts", import.meta.url),
  );
  execFileSync(
    process.execPath,
    [
      "--experimental-strip-types",
      cli,
      "--data-root",
      directory,
      "--implementation-digest",
      implementationDigest,
      "--build-identity-digest",
      retained.buildIdentityDigest,
    ],
    {
      env: { ...process.env, ...environment, AUDIT_PATH: audit },
      stdio: "pipe",
    },
  );
  assert.deepEqual(JSON.parse(readFileSync(audit, "utf8")), {
    mode: "historical",
    archiveRoot: null,
  });
  for (const invalid of [
    { ...environment, CREWON_EXTENSIONS_ENABLED: "0" },
    { ...environment, CREWON_CONTROL_SECURITY_MODE: "production" },
    { ...environment, CREWON_EXTENSION_EXECUTION_MODE: "current" },
    { ...environment, CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH: undefined },
    { ...environment, CREWON_NATIVE_WORKSPACE_BOOTSTRAP: "1" },
  ])
    await assert.rejects(
      retainedExtensionWorkerLaunchPlan({ selection, environment: invalid }),
    );
  await assert.rejects(
    retainedExtensionWorkerLaunchPlan({
      selection: {
        ...selection,
        buildIdentityDigest: `sha256:${"b".repeat(64)}`,
      },
      environment,
    }),
    /mismatch/u,
  );
  chmodSync(plan.workerPath, 0o600);
  writeFileSync(plan.workerPath, "// replacement");
  await assert.rejects(
    retainedExtensionWorkerLaunchPlan({ selection, environment }),
    /mismatch/u,
  );
});

test("legacy schema and implementation-only scope builds remain retainable but cannot execute", async (context) => {
  for (const legacyScope of [null, "crewon.extension-work-item-scope.v0"])
    await context.test(legacyScope ?? "legacy schema", async (subcontext) => {
      const directory = realpathSync(
        mkdtempSync(join(tmpdir(), "crewon-legacy-retained-launcher-")),
      );
      subcontext.after(() =>
        rmSync(directory, { recursive: true, force: true }),
      );
      const source = join(directory, "runtime-worker.mjs");
      const audit = join(directory, "must-not-execute.json");
      writeFileSync(
        source,
        `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(audit)},'executed');`,
      );
      writeFileSync(
        join(directory, EXTENSION_BUILD_IDENTITY_FILE),
        JSON.stringify(
          legacyScope === null
            ? createExtensionBuildIdentity(implementationDigest, [source])
            : {
                ...createExtensionBuildIdentity(implementationDigest, [source]),
                schemaVersion: "crewon.extension-build-identity.v1",
                historicalWorkItemScope: legacyScope,
              },
        ),
      );
      const legacy = await retainExtensionBuild({
        dataRoot: directory,
        currentBuildDirectory: directory,
        expectedImplementationDigest: implementationDigest,
      });
      assert.equal(legacy.historicalWorkItemScope, legacyScope);
      const cli = fileURLToPath(
        new URL("./retained-extension-worker.ts", import.meta.url),
      );
      assert.throws(
        () =>
          execFileSync(
            process.execPath,
            [
              "--experimental-strip-types",
              cli,
              "--data-root",
              directory,
              "--implementation-digest",
              implementationDigest,
              "--build-identity-digest",
              legacy.buildIdentityDigest,
            ],
            { env: { ...process.env, ...environment }, stdio: "pipe" },
          ),
        /scope_unsupported/u,
      );
      assert.throws(() => readFileSync(audit), /ENOENT/u);
    });
});
