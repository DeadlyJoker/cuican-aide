import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createExtensionConfiguration } from "@crewon/domain";
import {
  installLocalPluginPackage,
  loadInstalledPluginBusinessRegistration,
} from "../../../packages/plugin-host/src/index.ts";
import { SqliteRunStore } from "@crewon/store";
import { prepareDesktopPluginBootstrap } from "../../crewon-ui/electron/desktopPluginBootstrap.ts";
import { LocalWorkspaceAuthority } from "../../crewon-ui/electron/localWorkspaceRegistry.ts";
import { composeDesktopLocalComfyProjectExecutionApproval } from "../../crewon-ui/electron/desktopLocalComfyProjectExecutionApproval.ts";
import { parseDesktopPluginApproval } from "../../crewon-ui/electron/desktopPluginBootstrap.ts";
import type { DesktopInstalledPluginExpectedCatalogEntry } from "../../crewon-ui/electron/desktopInstalledPluginRuntime.ts";
import { DESKTOP_RUNTIME_OWNER as actor } from "../../crewon-ui/electron/desktopExtensionRuntime.ts";
import { prepareNativeDesktopInstalledPluginRuntime } from "../../crewon-ui/electron/desktopNativeInstalledPluginRuntime.ts";
import { terminateRuntimeChild } from "../../crewon-ui/electron/runtimeSupervisor.ts";
import {
  observeRuntimeChildClose,
  waitForRuntimeChildTerminalBefore,
} from "../../crewon-ui/electron/runtimeChildClose.ts";
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const digest = (value: string) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
/** Real source release CLI, Main-issued Native policy, SQLite and Worker. No HTTP policy or model-response server. */
export async function nativeLocalProcessFixture(
  t: TestContext,
  options: Readonly<{
    packagedRuntimeDirectory?: string;
    projectSourceDirectory?: string;
    saveConfiguration?: boolean;
    diagnosticImport?: string;
  }> = {},
) {
  const directory = await mkdtemp(
    join(await realpath(tmpdir()), "crewon-native-local-process-"),
  );
  await chmod(directory, 0o700);
  const dataDirectory = join(directory, "native");
  await mkdir(dataDirectory, { mode: 0o700 });
  const workspaceRoots = [
    join(directory, "workspace-a"),
    join(directory, "workspace-b"),
  ] as const;
  for (const root of workspaceRoots) await mkdir(root, { mode: 0o700 });
  const workspaceAuthority = new LocalWorkspaceAuthority(dataDirectory);
  const firstWorkspace = workspaceAuthority.select(workspaceRoots[0], {
    expectedRevision: 0,
    idempotencyKey: "workspace-first",
  }).snapshot.current!;
  const secondWorkspace = workspaceAuthority.select(workspaceRoots[1], {
    expectedRevision: 1,
    idempotencyKey: "workspace-second",
  }).snapshot.current!;
  workspaceAuthority.activate(firstWorkspace.workspaceId, {
    expectedRevision: 2,
    idempotencyKey: "workspace-first-active",
  });
  const installRoot = join(dataDirectory, "plugins");
  await mkdir(installRoot, { mode: 0o700 });
  const packageDirectory = process.env.CREWON_TEST_KREA_PLUGIN_DIR;
  assert.ok(
    packageDirectory,
    "the independently built Krea2 package is required",
  );
  const sourceDirectory = await realpath(packageDirectory);
  const installed = await installLocalPluginPackage({
    directory: sourceDirectory,
    installRoot,
    authorization: async () => ({ outcome: "allow" }),
  });
  const identity = {
    pluginId: installed.descriptor.pluginId,
    publisherId: installed.descriptor.publisherId,
    version: installed.descriptor.version,
    packageDigest: installed.packageDigest,
  };
  const projectSource =
    options.projectSourceDirectory === undefined
      ? null
      : await (async () => {
          assert.ok(options.projectSourceDirectory);
          const directory = await realpath(options.projectSourceDirectory);
          const installed = await installLocalPluginPackage({
            directory,
            installRoot,
            authorization: async () => ({ outcome: "allow" }),
          });
          assert.equal(
            installed.descriptor.entrypoints.node,
            null,
            "project source must remain a UI-only package without Node permission",
          );
          return {
            directory,
            descriptor: installed.descriptor,
            identity: {
              pluginId: installed.descriptor.pluginId,
              publisherId: installed.descriptor.publisherId,
              version: installed.descriptor.version,
              packageDigest: installed.packageDigest,
            },
          };
        })();
  const approvalPath = join(dataDirectory, "plugin-approvals.json"),
    policyPath = join(dataDirectory, "plugin-native-policy.json");
  await writeFile(
    approvalPath,
    JSON.stringify({
      schemaVersion:
        projectSource === null
          ? "crewon.desktop-plugin-approval.v1"
          : "crewon.desktop-plugin-approval.v2",
      sources: [
        { ...identity, sourceId: "approved-krea", directory: sourceDirectory },
        ...(projectSource === null
          ? []
          : [
              {
                ...projectSource.identity,
                sourceId: "approved-short-drama",
                directory: projectSource.directory,
              },
            ]),
      ],
      publications: [
        {
          pluginId: identity.pluginId,
          publisherId: identity.publisherId,
          packageDigest: identity.packageDigest,
          publicAssets: ["ui.mjs"],
        },
        ...(projectSource === null
          ? []
          : [
              {
                pluginId: projectSource.identity.pluginId,
                publisherId: projectSource.identity.publisherId,
                packageDigest: projectSource.identity.packageDigest,
                publicAssets: [projectSource.descriptor.entrypoints.ui!.path],
              },
            ]),
      ],
      ...(projectSource === null
        ? {}
        : {
            projects: {
              version: "crewon.desktop-project-history.v1",
              pluginUi: {
                publications: [
                  {
                    pluginId: projectSource.identity.pluginId,
                    packageDigest: projectSource.identity.packageDigest,
                    contributionId: "workbench",
                  },
                ],
              },
              uiRecovery: {
                version: "crewon.plugin-ui-recovery.v1",
                publications: [
                  {
                    pluginId: projectSource.identity.pluginId,
                    packageDigest: projectSource.identity.packageDigest,
                    contributionId: "workbench",
                    actions: [],
                  },
                ],
              },
            },
          }),
    }),
    { mode: 0o600 },
  );
  let bootstrap = await prepareDesktopPluginBootstrap({
    dataDirectory,
    actor,
    sessionEntropy: randomBytes(32).toString("hex"),
  });
  assert.ok(bootstrap);
  const databasePath = join(dataDirectory, "control.sqlite"),
    store = new SqliteRunStore(databasePath),
    scope = bootstrap.scope;
  await store.pluginInstallationStore().migrate();
  await store.extensionStore().migrate();
  const at = "2026-10-04T00:00:00.000Z";
  await store.pluginInstallationStore().recordInstalledPackage({
    scope,
    actor,
    package: {
      schemaVersion: "crewon.installed-plugin-package.v1",
      ...scope,
      ...identity,
      installedAt: at,
      installedByActorId: actor.actorId,
      installedByPrincipalId: actor.principalId,
    },
    expectedSelectionRevision: null,
    receipt: {
      idempotencyKey: "install-krea",
      requestDigest: digest("install-krea"),
    },
  });
  if (projectSource !== null)
    await store.pluginInstallationStore().recordInstalledPackage({
      scope,
      actor,
      package: {
        schemaVersion: "crewon.installed-plugin-package.v1",
        ...scope,
        ...projectSource.identity,
        installedAt: at,
        installedByActorId: actor.actorId,
        installedByPrincipalId: actor.principalId,
      },
      expectedSelectionRevision: null,
      receipt: {
        idempotencyKey: "install-short-drama",
        requestDigest: digest("install-short-drama"),
      },
    });
  const registration = await loadInstalledPluginBusinessRegistration({
    installRoot,
    expectedPluginId: identity.pluginId,
    expectedPublisherId: identity.publisherId,
    expectedVersion: identity.version,
    expectedPackageDigest: identity.packageDigest,
    authorizeRead: async () => "allow",
    signal: new AbortController().signal,
  });
  const baseUrl = "https://u564342-7908818e1ac4.westd.seetacloud.com:8443/";
  const configuration = createExtensionConfiguration(
    {
      schemaVersion: "crewon.extension-configuration.v0",
      tenantId: scope.tenantId,
      spaceId: scope.spaceId,
      pluginId: identity.pluginId,
      pluginVersion: identity.version,
      revision: 1,
      manifestDigest: registration.manifestDigest,
      implementationDigest: registration.implementationDigest,
      parameters: { baseUrl },
      credentialBindings: [],
      createdByActorId: actor.actorId,
      createdAt: at,
    },
    { sha256: digest },
  );
  if (options.saveConfiguration !== false)
    await store.extensionStore().saveExtensionConfiguration({
      configuration,
      expectedRevision: 0,
      receipt: {
        actorId: actor.actorId,
        idempotencyKey: "configure-krea",
        requestDigest: digest("configure-krea"),
      },
    });
  await writeFile(
    policyPath,
    JSON.stringify({
      schemaVersion: "crewon.desktop-native-plugin-policy.v1",
      packages: [{ ...identity, approvalRequirement: "none" }],
      networkGrants: [
        {
          ...identity,
          baseUrl,
          baseUrlParameter: "baseUrl",
          paths: [
            { method: "POST", path: "/prompt" },
            { method: "GET", path: "/queue" },
            { method: "GET", operationPathPrefix: "/history/" },
          ],
        },
      ],
    }),
    { mode: 0o600 },
  );
  const port = await unusedPort(),
    origin = "http://127.0.0.1:5730",
    sessionToken = randomBytes(32).toString("hex"),
    provider = {
      providerId: "openai",
      endpoint: "https://api.openai.com/v1",
      modelId: "gpt-4.1",
      apiKey: null,
    };
  const artifactKeyPath = join(dataDirectory, "artifact-encryption.key");
  await writeFile(artifactKeyPath, randomBytes(32), { mode: 0o600 });
  const environment: NodeJS.ProcessEnv = {
    PATH: dirname(process.execPath),
    NODE_NO_WARNINGS: "1",
    CREWON_CONTROL_SECURITY_MODE: "standalone",
    CREWON_CONTROL_DB_PATH: databasePath,
    CREWON_DESKTOP_WORKSPACE_REGISTRY_PATH: join(
      dataDirectory,
      "desktop-workspace.json",
    ),
    CREWON_CONTROL_PORT: String(port),
    CREWON_CONTROL_ORIGIN: origin,
    CREWON_CONTROL_ALLOWED_ORIGINS: origin,
    CREWON_CONTROL_CSRF_TOKEN: randomBytes(32).toString("hex"),
    CREWON_CONTROL_SESSION_TOKEN: sessionToken,
    CREWON_ARTIFACT_DB_PATH: join(dataDirectory, "artifact-metadata.sqlite"),
    CREWON_ARTIFACT_ENCRYPTION_KEY_ID: "desktop-artifact-key-v1",
    CREWON_ARTIFACT_ENCRYPTION_KEY_PATH: artifactKeyPath,
    CREWON_ARTIFACT_ROOT: join(dataDirectory, "artifacts"),
    CREWON_PRINCIPAL_ID: actor.principalId,
    CREWON_ACTOR_ID: actor.actorId,
    CREWON_TENANT_ID: actor.tenantId,
    CREWON_SPACE_ID: actor.spaceId,
    CREWON_RELEASE_PRINCIPAL_ID: actor.principalId,
    CREWON_RELEASE_ACTOR_ID: actor.actorId,
    CREWON_MODEL_ADAPTER: "responses",
    CREWON_MODEL_ID: provider.modelId,
    CREWON_MODEL_CATALOG_JSON: JSON.stringify([provider.modelId]),
    CREWON_DEV_AGENT_PROFILES_JSON: "[]",
    CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH: join(
      dataDirectory,
      "agent-version-runtime-bindings.json",
    ),
    CREWON_MODEL_CREDENTIAL_REQUIRED: "0",
    CREWON_MODEL_API_KEY: "",
    CREWON_RESPONSES_ENDPOINT: `${provider.endpoint}/responses`,
    CREWON_RESPONSES_STORE: "false",
    CREWON_RESPONSES_MAX_OUTPUT_TOKENS: "512",
    CREWON_RESPONSES_WEBSOCKET_ENABLED: "false",
    CREWON_AGENT_VERSION_ID: "native-local-original-agent",
    CREWON_AUTHORITY_ID: "standalone-authority",
    CREWON_RUNTIME_GENERATION: "native-original-generation",
    CREWON_POLICY_SNAPSHOT_ID: "standalone-policy-v0",
    CREWON_AGENT_INSTRUCTIONS:
      "Preserve the original desktop Agent; this test never requests inference.",
    CREWON_RESPONSES_STREAM_MAX_RETRIES: "0",
    CREWON_MODEL_CONTEXT_WINDOW_TOKENS: "32000",
    CREWON_AUTO_COMPACT_AT_TOKENS: "20000",
    CREWON_NATIVE_WORKSPACE_READ_ENABLED: "0",
    ...bootstrap.environment,
  };
  const children = new Set<ChildProcess>(),
    output = new WeakMap<ChildProcess, { stdout: string; stderr: string }>();
  const auditPath = join(directory, "network-audit.jsonl"),
    auditEntry = join(directory, "network-audit.mjs");
  await writeFile(
    auditEntry,
    `import {appendFileSync} from 'node:fs'; const original=globalThis.fetch; globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);appendFileSync(${JSON.stringify(auditPath)},JSON.stringify({origin:url.origin,pathname:url.pathname})+'\\n',{mode:0o600});return original(input,init);};`,
    { mode: 0o600 },
  );
  const entry = (role: "release" | "worker" | "control") =>
    options.packagedRuntimeDirectory
      ? join(
          options.packagedRuntimeDirectory,
          role === "release"
            ? "runtime-release.mjs"
            : role === "worker"
              ? "runtime-worker.mjs"
              : "control-api.mjs",
        )
      : join(
          repository,
          role === "control"
            ? "apps/control-api/src/main.ts"
            : `apps/runtime-worker/src/${role === "release" ? "release-main" : "main"}.ts`,
        );
  const start = (
    role: "release" | "worker" | "control",
    changes: NodeJS.ProcessEnv,
  ) => {
    const path = entry(role),
      child = spawn(
        process.execPath,
        [
          "--import",
          auditEntry,
          ...(options.diagnosticImport === undefined
            ? []
            : ["--import", options.diagnosticImport]),
          ...(path.endsWith(".ts") ? ["--experimental-strip-types"] : []),
          path,
        ],
        {
          cwd: repository,
          env: { ...environment, ...changes },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    observeRuntimeChildClose(child);
    children.add(child);
    const logs = { stdout: "", stderr: "" };
    output.set(child, logs);
    child.stdout.on("data", (chunk: Buffer) => {
      logs.stdout += chunk.toString();
      if (logs.stdout.length > 1024 * 1024) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      logs.stderr += chunk.toString();
      if (logs.stderr.length > 1024 * 1024) child.kill("SIGTERM");
    });
    child.stdin.end();
    return child;
  };
  let owner: ReturnType<typeof prepareNativeDesktopInstalledPluginRuntime> =
    null;
  t.after(async () => {
    owner?.withdraw();
    for (const child of children) await terminateRuntimeChild(child);
    await owner?.close();
    await store.close();
    await bootstrap!.cleanup();
    const makeOwnedDirectoriesWritable = async (
      path: string,
    ): Promise<void> => {
      await chmod(path, 0o700);
      for (const item of await readdir(path, { withFileTypes: true }))
        if (item.isDirectory() && !item.isSymbolicLink())
          await makeOwnedDirectoriesWritable(join(path, item.name));
    };
    await makeOwnedDirectoriesWritable(directory);
    await rm(directory, { recursive: true, force: true });
  });
  const runRelease = async (changes: NodeJS.ProcessEnv = {}) => {
    const child = start("release", changes);
    const result = await waitForRuntimeChildTerminalBefore(child, 20000);
    assert.ok(result, `release timed out: ${output.get(child)?.stderr}`);
    assert.equal(result.code, 0, output.get(child)?.stderr);
    return output.get(child)!.stdout;
  };
  const waitForControl = async (child: ChildProcess) => {
    const deadline = Date.now() + 20000;
    const expected = `CrewON Control API listening on 127.0.0.1:${port}`;
    while (!output.get(child)!.stdout.includes(expected)) {
      assert.equal(child.exitCode, null, output.get(child)!.stderr);
      assert.equal(child.signalCode, null, output.get(child)!.stderr);
      assert.ok(Date.now() < deadline, output.get(child)!.stderr);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  await runRelease();
  const originalDefaultVersion = await store.loadAgentVersion({
    tenantId: actor.tenantId,
    agentVersionId: environment.CREWON_AGENT_VERSION_ID!,
  });
  assert.ok(originalDefaultVersion);
  owner = prepareNativeDesktopInstalledPluginRuntime({
    dataDirectory,
    bootstrap,
    provider,
    sharedEnvironment: environment,
    workerEnvironment: environment,
    signal: new AbortController().signal,
  });
  assert.ok(owner);
  const prepareProjectBridge = async (
    entry: DesktopInstalledPluginExpectedCatalogEntry,
  ) => {
    assert.ok(projectSource);
    assert.ok(bootstrap);
    assert.ok(owner);
    const approval = composeDesktopLocalComfyProjectExecutionApproval({
      approval: parseDesktopPluginApproval(
        JSON.parse(await readFile(approvalPath, "utf8")),
      ),
      source: {
        descriptor: projectSource.descriptor,
        packageDigest: projectSource.identity.packageDigest,
        contributionId: "workbench",
      },
      target: {
        descriptor: installed.descriptor,
        contributionId: "studio",
        entry,
      },
    });
    await owner.close();
    await bootstrap.cleanup();
    await writeFile(approvalPath, JSON.stringify(approval), { mode: 0o600 });
    bootstrap = await prepareDesktopPluginBootstrap({
      dataDirectory,
      actor,
      sessionEntropy: randomBytes(32).toString("hex"),
    });
    assert.ok(bootstrap);
    assert.deepEqual(bootstrap.scope, scope);
    Object.assign(environment, bootstrap.environment);
    owner = prepareNativeDesktopInstalledPluginRuntime({
      dataDirectory,
      bootstrap,
      provider,
      sharedEnvironment: environment,
      workerEnvironment: environment,
      signal: new AbortController().signal,
    });
    assert.ok(owner);
    return owner;
  };
  return {
    directory,
    dataDirectory,
    databasePath,
    workspaceAuthority,
    workspaceRoots,
    firstWorkspace,
    secondWorkspace,
    store,
    bootstrap,
    scope,
    identity,
    configuration,
    originalDefaultVersion,
    environment,
    get owner() {
      assert.ok(owner);
      return owner;
    },
    projectSource,
    prepareProjectBridge,
    port,
    sessionToken,
    start,
    runRelease,
    waitForControl,
    logs: (child: ChildProcess) => output.get(child)!,
    audit: async () => {
      try {
        return (await readFile(auditPath, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(
            (line) => JSON.parse(line) as { origin: string; pathname: string },
          );
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return [];
        throw error;
      }
    },
  };
}
