import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createAgentVersionAsset,
  parseAgentVersionAsset,
} from "@crewon/agent-version";
import { createExtensionConfiguration } from "@crewon/domain";
import { parseExtensionHostResponse } from "@crewon/contracts";
import { createHash } from "node:crypto";
import {
  createExtensionBuildIdentity,
  createScopedExtensionBuildIdentity,
  EXTENSION_BUILD_IDENTITY_FILE,
  getComfyImplementationDigest,
  resolveRetainedExtensionBuild,
  type RetainedExtensionBuild,
} from "@crewon/agent-version/extension-build";
import { retainInstalledExtensionBuild } from "./extensions/retain-installed-extension-build.ts";
import {
  extensionProcessFixture,
  completeExtensionProcess,
  waitForExtensionProcess,
  type OwnedExtensionProcess,
} from "../../control-api/src/extension-process-flow.test-support.ts";
import { SqliteRunStore } from "@crewon/store";
import { compileComfyAgentVersion } from "./extensions/comfyui-agent-version.ts";
import { bundledComfyRegistration } from "./extensions/comfyui-bundled-registration.ts";

const ARCHIVE_ROOT = "CREWON_EXTENSION_BUILD_ARCHIVE_DATA_ROOT";
const enabled = {
  CREWON_EXTENSIONS_ENABLED: "1",
  CREWON_CONTROL_SECURITY_MODE: "standalone",
};
const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};

function ownedProcess(
  args: string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
): OwnedExtensionProcess {
  const child = spawn(process.execPath, args, {
    cwd,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end();
  let stdout = "",
    stderr = "",
    finished = false;
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    if (stdout.length > 128 * 1024) child.kill("SIGTERM");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    if (stderr.length > 128 * 1024) child.kill("SIGTERM");
  });
  const completion = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((accept, reject) => {
    child.once("error", (error) => {
      finished = true;
      reject(error);
    });
    child.once("close", (code, signal) => {
      finished = true;
      accept({ code, signal });
    });
  });
  void completion.catch(() => undefined);
  return {
    child,
    completion,
    stdout: () => stdout,
    stderr: () => stderr,
    finished: () => finished,
  };
}

function fixture(context: TestContext) {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "crewon-installed-build-"),
  );
  const directory = join(root, "installed-runtime");
  const dataRoot = join(root, "native-data");
  mkdirSync(directory);
  mkdirSync(dataRoot);
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const entry = join(root, "fixture.ts");
  const release = join(directory, "runtime-release.mjs");
  const helper = fileURLToPath(
    new URL(
      "./extensions/retain-installed-extension-build.ts",
      import.meta.url,
    ),
  );
  writeFileSync(
    entry,
    `import { retainInstalledExtensionBuild } from ${JSON.stringify(helper)};
try {
  const environment = JSON.parse(process.argv[2]);
  const result = await retainInstalledExtensionBuild({environment, entrypointUrl: import.meta.url});
  console.log(JSON.stringify(result ?? null));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
`,
  );
  const implementationDigest = getComfyImplementationDigest();
  const stageUrl = new URL(
    "../../../scripts/stage-desktop-runtime.ts",
    import.meta.url,
  ).href;
  const outputs = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
    const { bundleRuntime, runtimeBundleSpecs } = await import(${JSON.stringify(stageUrl)});
    bundleRuntime({ entry: ${JSON.stringify(entry)}, output: ${JSON.stringify(release)} }, ${JSON.stringify(implementationDigest)});
    console.log(JSON.stringify(runtimeBundleSpecs('/unused', ${JSON.stringify(directory)}).map(({ output }) => output)));
  `,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ),
  ) as string[];
  for (const output of outputs) {
    if (output !== release)
      writeFileSync(
        output,
        `throw new Error(${JSON.stringify(`unloaded artifact ${basename(output)} must not execute`)});\n`,
      );
  }
  const identity = createExtensionBuildIdentity(implementationDigest, outputs);
  writeFileSync(
    join(directory, EXTENSION_BUILD_IDENTITY_FILE),
    JSON.stringify(identity),
  );
  const run = (
    environment: Record<string, string | undefined> = {
      ...enabled,
      [ARCHIVE_ROOT]: dataRoot,
    },
  ) =>
    JSON.parse(
      execFileSync(process.execPath, [release, JSON.stringify(environment)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ) as RetainedExtensionBuild | null;
  const fail = () => {
    try {
      run();
      assert.fail("the installed build should have been rejected");
    } catch (error) {
      assert.ok(
        error !== null &&
          typeof error === "object" &&
          "status" in error &&
          "stderr" in error,
      );
      assert.equal(error.status, 1);
      return String(error.stderr);
    }
  };
  return {
    directory,
    dataRoot,
    implementationDigest,
    outputs,
    identity,
    run,
    fail,
  };
}

test("installed release retains the complete verified bundle set without configuration or credentials", async (context) => {
  const f = fixture(context);
  writeFileSync(
    join(f.directory, "runtime-bindings.json"),
    "private operator configuration",
  );
  writeFileSync(
    join(f.directory, "credentials.json"),
    "private provider credential",
  );
  const retained = f.run();
  assert.ok(retained);
  assert.equal(retained.implementationDigest, f.implementationDigest);
  assert.equal(retained.historicalWorkItemScope, null);
  assert.deepEqual(
    retained.bundles.map(({ file }) => file),
    f.outputs.map((output) => basename(output)).sort(),
  );
  assert.deepEqual(
    readdirSync(retained.directory).sort(),
    [
      ...f.outputs.map((output) => basename(output)),
      EXTENSION_BUILD_IDENTITY_FILE,
    ].sort(),
  );
  assert.equal(
    readFileSync(join(f.directory, "credentials.json"), "utf8"),
    "private provider credential",
  );
  assert.deepEqual(
    await resolveRetainedExtensionBuild({
      dataRoot: f.dataRoot,
      implementationDigest: f.implementationDigest,
      expectedBuildIdentityDigest: retained.buildIdentityDigest,
    }),
    retained,
  );
});

test("installed release validates unloaded bundles before committing an archive", (context) => {
  const f = fixture(context);
  const unloaded = f.outputs.find((output) =>
    output.endsWith("runtime-worker.mjs"),
  )!;
  appendFileSync(unloaded, "// code changed after build\n");
  assert.match(f.fail(), /extension_retained_build_mismatch/u);
  assert.equal(existsSync(join(f.dataRoot, "extension-builds")), false);
});

test("installed release rejects altered sidecar identity or unknown fields", async (context) => {
  for (const kind of ["implementation", "unknown-field"] as const) {
    await context.test(kind, (subcontext) => {
      const f = fixture(subcontext);
      writeFileSync(
        join(f.directory, EXTENSION_BUILD_IDENTITY_FILE),
        JSON.stringify(
          kind === "implementation"
            ? {
                ...f.identity,
                implementationDigest: `sha256:${"0".repeat(64)}`,
              }
            : { ...f.identity, trusted: true },
        ),
      );
      assert.match(f.fail(), /extension_build_identity_(?:mismatch|invalid)/u);
      assert.equal(existsSync(join(f.dataRoot, "extension-builds")), false);
    });
  }
});

test("archive opt-in rejects source entries, disabled extensions and production mode before copying", async (context) => {
  const f = fixture(context);
  assert.equal(f.run({}), null);
  assert.equal(f.run({ CREWON_EXTENSIONS_ENABLED: "0" }), null);
  assert.equal(existsSync(join(f.dataRoot, "extension-builds")), false);
  for (const environment of [
    { [ARCHIVE_ROOT]: f.dataRoot, CREWON_EXTENSIONS_ENABLED: "0" },
    {
      [ARCHIVE_ROOT]: f.dataRoot,
      CREWON_EXTENSIONS_ENABLED: "1",
      CREWON_CONTROL_SECURITY_MODE: "production",
    },
  ]) {
    assert.throws(
      () => f.run(environment),
      (error: unknown) =>
        error !== null &&
        typeof error === "object" &&
        "stderr" in error &&
        /extension_installed_build_archive_configuration_invalid/u.test(
          String(error.stderr),
        ),
    );
  }
  for (const entrypointUrl of [
    import.meta.url,
    pathToFileURL(join(f.directory, "runtime-release.mjs")).href,
  ])
    await assert.rejects(
      retainInstalledExtensionBuild({
        environment: { ...enabled, [ARCHIVE_ROOT]: f.dataRoot },
        entrypointUrl,
      }),
      /extension_installed_build_archive_entry_invalid/u,
    );
  assert.equal(existsSync(join(f.dataRoot, "extension-builds")), false);
});

test(
  "the actual seven staged bundles retain through release and run a historical idle Worker after resource replacement",
  { timeout: 60_000 },
  async (context) => {
    const f = await extensionProcessFixture(context);
    const root = realpathSync(f.root);
    const staged = join(root, "owned-staged-runtime");
    const installed = join(root, "owned-installed-runtime");
    const dataRoot = join(root, "native-archive-data");
    for (const directory of [staged, installed, dataRoot]) mkdirSync(directory);
    const stageUrl = new URL(
      "../../../scripts/stage-desktop-runtime.ts",
      import.meta.url,
    ).href;
    const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const implementationDigest = getComfyImplementationDigest();
    const stagedFiles = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
    const { bundleRuntime, runtimeBundleSpecs } = await import(${JSON.stringify(stageUrl)});
    const specs = runtimeBundleSpecs(${JSON.stringify(repositoryRoot)}, ${JSON.stringify(staged)});
    for (const spec of specs) bundleRuntime(spec, ${JSON.stringify(implementationDigest)});
    console.log(JSON.stringify(specs.map(({ output }) => output)));
  `,
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 40_000,
        },
      ),
    ) as string[];
    assert.equal(stagedFiles.length, 7);
    const identity = createScopedExtensionBuildIdentity({
      implementationDigest,
      bundlePaths: stagedFiles,
    });
    writeFileSync(
      join(staged, EXTENSION_BUILD_IDENTITY_FILE),
      JSON.stringify(identity),
    );
    for (const path of [
      ...stagedFiles,
      join(staged, EXTENSION_BUILD_IDENTITY_FILE),
    ])
      copyFileSync(path, join(installed, basename(path)));
    writeFileSync(
      join(installed, "private-configuration.json"),
      "fixture configuration must remain outside the archive",
    );
    const release = spawn(
      process.execPath,
      [join(installed, "runtime-release.mjs")],
      {
        cwd: root,
        env: {
          ...f.environment,
          CREWON_EXTENSIONS_ENABLED: "1",
          [ARCHIVE_ROOT]: dataRoot,
          CREWON_MODEL_API_KEY: "nonsecret-fixture-key",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    context.after(() => {
      if (release.exitCode === null && release.signalCode === null)
        release.kill("SIGKILL");
    });
    let stdout = "",
      stderr = "";
    release.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 128 * 1024) release.kill("SIGKILL");
    });
    release.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 128 * 1024) release.kill("SIGKILL");
    });
    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((accept, reject) => {
      const timer = setTimeout(() => {
        release.kill("SIGKILL");
        reject(new Error("installed-release-test-timeout"));
      }, 15_000);
      release.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      release.once("close", (code, signal) => {
        clearTimeout(timer);
        accept({ code, signal });
      });
    });
    assert.equal(result.code, 0, stderr || stdout);
    assert.equal(result.signal, null);
    assert.deepEqual(JSON.parse(stdout).agentVersionIds, [
      f.environment.CREWON_AGENT_VERSION_ID,
    ]);
    assert.equal(
      f.requests.length,
      0,
      "release metadata must not make a model or external Comfy request",
    );
    const store = new SqliteRunStore(f.databasePath);
    const baseAsset = await (async () => {
      try {
        return await store.loadAgentVersion({
          tenantId: f.environment.CREWON_TENANT_ID!,
          agentVersionId: f.environment.CREWON_AGENT_VERSION_ID!,
        });
      } finally {
        await store.close();
      }
    })();
    assert.ok(baseAsset);
    const baseVersion = parseAgentVersionAsset(baseAsset, digester);
    const registration = bundledComfyRegistration();
    assert.notEqual(registration.implementationDigest, implementationDigest);
    const actor = {
      principalId: f.environment.CREWON_PRINCIPAL_ID!,
      actorId: f.environment.CREWON_ACTOR_ID!,
      tenantId: f.environment.CREWON_TENANT_ID!,
      spaceId: f.environment.CREWON_SPACE_ID!,
    };
    const configuration = createExtensionConfiguration(
      {
        schemaVersion: "crewon.extension-configuration.v0",
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        pluginId: registration.manifest.pluginId,
        revision: 1,
        pluginVersion: registration.manifest.version,
        manifestDigest: registration.manifestDigest,
        implementationDigest: registration.implementationDigest,
        parameters: { baseUrl: "https://comfy.example.com/" },
        credentialBindings: [],
        createdByActorId: actor.actorId,
        createdAt: "2026-10-02T00:00:00.000Z",
      },
      digester,
    );
    const pluginVersion = compileComfyAgentVersion({
      base: { executionAuthority: "crewonKernel", version: baseVersion },
      agentVersionId: "retained-process-image-agent",
      runtimeGeneration: "ts-v0",
      policySnapshotId: "retained-process-plugin-policy",
      digester,
    });
    const snapshotPath = join(root, "old-comfy-snapshot.json");
    const bindingsPath = join(root, "old-plugin-bindings.json");
    const assetsPath = join(root, "old-plugin-assets.json");
    const baseBindingsPath = join(root, "base-bindings.json");
    writeFileSync(
      snapshotPath,
      JSON.stringify({
        schemaVersion: "crewon.extension-runtime-config.v0",
        configuration,
        approvalRequirement: "none",
      }),
      { flag: "wx", mode: 0o600 },
    );
    writeFileSync(
      bindingsPath,
      JSON.stringify({
        schemaVersion: "crewon.agent-version-runtime-bindings.v0",
        bindings: [
          {
            tenantId: actor.tenantId,
            agentVersionId: pluginVersion.agentVersionId,
            contentDigest: pluginVersion.contentDigest,
            authorityId: "retained-process-comfy-authority",
            workspaceBindingId: null,
            provider: {
              kind: "directResponses",
              endpoint: f.endpoint,
              apiKeyEnvironment: null,
              storeResponses: false,
              requestProfile: "responsesLite",
              idleTimeoutMs: 5000,
              sequencePolicy: "whenPresent",
            },
            mcpStdioConfigPath: null,
            deviceToolConfigPath: null,
            remoteMcpConfigPath: null,
            extensionConfigPath: snapshotPath,
          },
        ],
      }),
      { flag: "wx", mode: 0o600 },
    );
    writeFileSync(
      assetsPath,
      JSON.stringify({
        schemaVersion: "crewon.extension-agent-version-assets.v0",
        assets: [
          createAgentVersionAsset({
            tenantId: actor.tenantId,
            version: pluginVersion,
            createdAt: "2026-10-02T00:00:00.000Z",
          }),
        ],
      }),
      { flag: "wx", mode: 0o600 },
    );
    writeFileSync(
      baseBindingsPath,
      JSON.stringify({
        schemaVersion: "crewon.agent-version-runtime-bindings.v0",
        bindings: [],
      }),
      { flag: "wx", mode: 0o600 },
    );
    const oldInputs = [snapshotPath, bindingsPath, assetsPath].map((path) => ({
      path,
      bytes: readFileSync(path),
    }));
    const pluginEnvironment = {
      ...f.environment,
      CREWON_EXTENSIONS_ENABLED: "1",
      CREWON_EXTENSION_RUNTIME_BINDINGS_PATH: bindingsPath,
      CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH: assetsPath,
      CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH: baseBindingsPath,
      CREWON_MODEL_CATALOG_JSON: JSON.stringify([baseVersion.model.modelId]),
    };
    const pluginRelease = ownedProcess(
      [join(installed, "runtime-release.mjs")],
      { ...pluginEnvironment, [ARCHIVE_ROOT]: dataRoot },
      root,
    );
    context.after(async () => {
      await f.stop(pluginRelease);
    });
    assert.equal(
      (await completeExtensionProcess(pluginRelease)).code,
      0,
      pluginRelease.stderr(),
    );
    assert.ok(
      (JSON.parse(pluginRelease.stdout()).agentVersionIds as string[]).includes(
        pluginVersion.agentVersionId,
      ),
    );
    const retained = await resolveRetainedExtensionBuild({
      dataRoot,
      implementationDigest,
    });
    assert.equal(
      retained.historicalWorkItemScope,
      "crewon.extension-work-item-scope.v1",
    );
    assert.deepEqual(
      retained.bundles.map(({ file }) => file),
      identity.bundles.map(({ file }) => file),
    );
    assert.deepEqual(
      readdirSync(retained.directory).sort(),
      [
        ...identity.bundles.map(({ file }) => file),
        EXTENSION_BUILD_IDENTITY_FILE,
      ].sort(),
    );
    for (const bundle of retained.bundles)
      assert.deepEqual(
        readFileSync(bundle.path),
        readFileSync(join(installed, bundle.file)),
      );
    rmSync(installed, { recursive: true });
    mkdirSync(installed);
    writeFileSync(
      join(installed, "runtime-worker.mjs"),
      "installed resources were replaced",
    );
    writeFileSync(
      join(installed, EXTENSION_BUILD_IDENTITY_FILE),
      "new unverified sidecar",
    );
    rmSync(staged, { recursive: true });
    assert.deepEqual(
      await resolveRetainedExtensionBuild({
        dataRoot,
        implementationDigest,
        expectedBuildIdentityDigest: retained.buildIdentityDigest,
      }),
      retained,
    );
    const launcher = fileURLToPath(
      new URL("../../../scripts/retained-extension-worker.ts", import.meta.url),
    );
    const args = [
      "--experimental-strip-types",
      launcher,
      "--data-root",
      dataRoot,
      "--implementation-digest",
      implementationDigest,
      "--build-identity-digest",
      retained.buildIdentityDigest,
    ];
    const token = "retained-process-private-host-token-000001";
    const historicalEnvironment = {
      ...pluginEnvironment,
      CREWON_MODEL_CATALOG_JSON: undefined,
      CREWON_EXTENSION_EXECUTION_MODE: "historical",
      CREWON_EXTENSION_HOST_PORT: "0",
      CREWON_EXTENSION_HOST_TOKEN: token,
    };
    const once = ownedProcess(
      args,
      { ...historicalEnvironment, CREWON_WORKER_ONCE: "1" },
      root,
    );
    context.after(async () => {
      await f.stop(once);
    });
    assert.equal((await completeExtensionProcess(once)).code, 0, once.stderr());
    // This verifies consumer launch/readiness, not resumption of a provider operation.
    assert.deepEqual(JSON.parse(once.stdout()), { kind: "idle" });
    const serving = ownedProcess(args, historicalEnvironment, root);
    context.after(async () => {
      await f.stop(serving);
    });
    await waitForExtensionProcess(serving, "CrewON Extension Host origin");
    const origin =
      /CrewON Extension Host origin (http:\/\/127\.0\.0\.1:\d+)/u.exec(
        serving.stdout(),
      )?.[1];
    assert.ok(origin);
    const post = async (body: Record<string, unknown>) => {
      const response = await fetch(`${origin}/private/v0/extensions`, {
        method: "POST",
        headers: {
          "authorization": `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          protocol: "crewon.extension-host-request.v0",
          actor,
          ...body,
        }),
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200);
      return parseExtensionHostResponse(await response.json());
    };
    const catalog = await post({ operation: "catalog" });
    assert.equal(catalog.operation, "catalog");
    if (catalog.operation === "catalog")
      assert.equal(
        catalog.registrations[0]?.implementationDigest,
        registration.implementationDigest,
      );
    const readiness = await post({
      operation: "readiness",
      registration: {
        pluginId: registration.manifest.pluginId,
        pluginVersion: registration.manifest.version,
        manifestDigest: registration.manifestDigest,
        implementationDigest: registration.implementationDigest,
      },
      configuration,
      agentVersionId: pluginVersion.agentVersionId,
    });
    assert.equal(readiness.operation, "readiness");
    if (readiness.operation === "readiness")
      assert.equal(readiness.result.outcome, "ready");
    assert.equal((await f.stop(serving)).code, 0, serving.stderr());
    assert.equal(f.requests.length, 0);
    for (const input of oldInputs)
      assert.deepEqual(readFileSync(input.path), input.bytes);
  },
);
