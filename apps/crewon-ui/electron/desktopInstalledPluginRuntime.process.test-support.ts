import assert from "node:assert/strict";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { SqliteRunStore } from "@crewon/store";
import { parsePluginProfileScope } from "@crewon/domain";
import { verifyLocalPluginPackage } from "../../../packages/plugin-host/src/local-plugin-package-verifier.ts";
import {
  TEST_CA_CERT,
  TEST_SERVER_CERT,
  TEST_SERVER_KEY,
} from "../../device-gateway/src/mtls-test-certificates.test-support.ts";
import {
  DESKTOP_PLUGIN_APPROVAL_FILE,
  DESKTOP_PLUGIN_APPROVAL_SCHEMA,
} from "./desktopPluginBootstrap.ts";
import { DESKTOP_RUNTIME_OWNER as actor } from "./desktopExtensionRuntime.ts";
import { loadDesktopInstalledPluginRuntimeConfiguration } from "./desktopInstalledPluginRuntimeConfiguration.ts";
import {
  RuntimeSupervisor,
  type ControlRuntimeSession,
} from "./runtimeSupervisor.ts";

const repository = new URL("../../../", import.meta.url).pathname;
const tokenName = "NATIVE_INSTALLED_AUTHORITY_TOKEN";
const authorityToken = "native-process-metadata-authority-" + "a".repeat(32);
const modelKey = "named-native-process-model-key-never-used";
type Source = Readonly<{
  sourceId: string;
  directory: string;
  pluginId: string;
  publisherId: string;
  version: string;
  packageDigest: string;
}>;
type ChildObservation = Readonly<{
  pid: number;
  entry: string;
  environment: NodeJS.ProcessEnv;
  nativeBootstrap: boolean;
  authorityTokenPresent: boolean;
  installed: boolean;
  peer: boolean;
  preparation: boolean;
}>;

/** Actual source Supervisor children; HTTPS decisions require current private Native
 * profile/approval and installed SQLite facts. This named authority never grants payment. */
export async function nativeInstalledProcessFixture(packageDirectory?: string) {
  assert.match(process.version, /^v24\./u);
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "crewon-native-installed-runtime-")),
  );
  const ownedRoot = await lstat(directory);
  assert.ok(ownedRoot.isDirectory() && ownedRoot.uid === process.getuid?.());
  const dataDirectory = join(directory, "runtime");
  await mkdir(dataDirectory, { mode: 0o700 });
  const databasePath = join(dataDirectory, "control.sqlite");
  const auditPath = join(directory, "children.jsonl");
  const nodePath = join(directory, "plugin-node-imports.jsonl");
  const observerPath = join(directory, "observe-runtime.mjs");
  const caPath = join(directory, "authority-ca.pem");
  await writeFile(caPath, TEST_CA_CERT, { mode: 0o600 });
  await writeFile(
    observerPath,
    observer(auditPath, nodePath, join(dataDirectory, "plugins")),
    { mode: 0o600 },
  );
  const previousEnvironment = { ...process.env };
  const sources: Source[] = [];
  if (packageDirectory !== undefined) {
    const original = await verifyLocalPluginPackage({
      directory: await realpath(packageDirectory),
    });
    assert.equal(original.descriptor.pluginId, "example.professional");
    assert.equal(original.descriptor.version, "1.0.0");
    const approvedDirectory = join(directory, "approved-professional");
    await cp(packageDirectory, approvedDirectory, { recursive: true });
    const installed = await verifyLocalPluginPackage({
      directory: approvedDirectory,
    });
    assert.equal(installed.packageDigest, original.packageDigest);
    sources.push({
      sourceId: "native-runtime-professional-v1",
      directory: approvedDirectory,
      pluginId: installed.descriptor.pluginId,
      publisherId: installed.descriptor.publisherId,
      version: installed.descriptor.version,
      packageDigest: installed.packageDigest,
    });
    assert.ok(installed.descriptor.entrypoints.ui);
    await writeFile(
      join(dataDirectory, DESKTOP_PLUGIN_APPROVAL_FILE),
      JSON.stringify({
        schemaVersion: DESKTOP_PLUGIN_APPROVAL_SCHEMA,
        sources,
        publications: [
          {
            pluginId: installed.descriptor.pluginId,
            publisherId: installed.descriptor.publisherId,
            packageDigest: installed.packageDigest,
            publicAssets: [installed.descriptor.entrypoints.ui.path],
          },
        ],
      }),
      { mode: 0o600 },
    );
  }
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const failures: unknown[] = [];
  const pending = new Set<Promise<void>>();
  let closing: Promise<void> | null = null;
  let denyPackages = false;
  let supplierRequests = 0;
  let modelRequests = 0;
  const server = createServer(
    { key: TEST_SERVER_KEY, cert: TEST_SERVER_CERT, minVersion: "TLSv1.3" },
    (request, response) => {
      const work = Promise.resolve()
        .then(async () => {
          const path = request.url!;
          if (path.startsWith("/supplier/")) {
            supplierRequests++;
            response.writeHead(500).end();
            return;
          }
          if (path.startsWith("/v1/")) {
            modelRequests++;
            response.writeHead(500).end();
            return;
          }
          assert.equal(request.method, "POST");
          assert.equal(
            request.headers.authorization,
            `Bearer ${authorityToken}`,
          );
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of request) {
            bytes += Buffer.byteLength(chunk);
            assert.ok(bytes <= 128 * 1024);
            chunks.push(Buffer.from(chunk));
          }
          const body = JSON.parse(
            Buffer.concat(chunks).toString("utf8"),
          ) as Record<string, unknown>;
          assert.ok(requests.length < 512);
          requests.push({ path, body });
          const profile = await currentProfile();
          let result: unknown;
          switch (path) {
            case "/actor": {
              assert.equal(
                body.schemaVersion,
                "crewon.plugin-execution-actor.v1",
              );
              const { principalId: _principal, ...owner } = actor;
              result =
                isDeepStrictEqual(body.owner, owner) && profile !== null
                  ? actor
                  : null;
              break;
            }
            case "/profile":
              assert.deepEqual(body.actor, actor);
              assert.ok(profile);
              result = profile;
              break;
            case "/package": {
              assert.equal(
                body.schemaVersion,
                "crewon.plugin-execution-package.v1",
              );
              const allowed =
                body.purpose === "read" &&
                !denyPackages &&
                profile !== null &&
                isDeepStrictEqual(body.scope, profile) &&
                (await installedApproved(body.identity, profile));
              result = { outcome: allowed ? "allow" : "deny" };
              break;
            }
            case "/policy": {
              assert.deepEqual(body.actor, actor);
              const resource = body.resource as Record<string, unknown>;
              let allowed =
                profile !== null &&
                resource.tenantId === actor.tenantId &&
                resource.spaceId === actor.spaceId;
              if (body.action === "extension:read")
                allowed &&= sources.some(
                  (source) => source.pluginId === resource.pluginId,
                );
              else if (body.action === "agentVersion:read") {
                const store = new SqliteRunStore(databasePath);
                try {
                  allowed &&=
                    (await store.loadAgentVersion({
                      tenantId: actor.tenantId,
                      agentVersionId: String(resource.agentVersionId),
                    })) !== null;
                } finally {
                  await store.close();
                }
              } else allowed = false;
              result = allowed
                ? { outcome: "allow" }
                : {
                    outcome: "deny",
                    reasonCode: "native_metadata_only_no_execution",
                  };
              break;
            }
            default:
              throw new Error("native_metadata_authority_unknown_route");
          }
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify(result));
        })
        .catch((error: unknown) => {
          failures.push(error);
          if (!response.headersSent) response.writeHead(500).end();
          else response.destroy();
        })
        .finally(() => pending.delete(work));
      pending.add(work);
    },
  );
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  for (const key of Object.keys(process.env))
    if (key.startsWith("CREWON_") || key === "AICUICAN_API_KEY")
      delete process.env[key];
  process.env.NODE_OPTIONS = `--import=${pathToFileURL(observerPath).href}`;
  process.env.NODE_EXTRA_CA_CERTS = caPath;
  process.env[tokenName] = authorityToken;
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `https://localhost:${address.port}`;
  const provider = {
    providerId: "named-native-responses-provider",
    endpoint: `${origin}/v1`,
    modelId: "named-native-process-model",
    apiKey: modelKey,
  };
  const supervisors = new Set<RuntimeSupervisor>();
  const logs: string[] = [];
  function supervisor(configured: boolean, installed = true) {
    const output = () =>
      new Writable({
        write(chunk, _encoding, done) {
          logs.push(String(chunk));
          done();
        },
      });
    const runtime = new RuntimeSupervisor({
      dataDirectory,
      repositoryRoot: repository,
      paths: {
        source: true,
        control: join(repository, "apps/control-api/src/main.ts"),
        release: join(repository, "apps/runtime-worker/src/release-main.ts"),
        worker: join(repository, "apps/runtime-worker/src/main.ts"),
        modelCatalog: "/unused/model-catalog",
        workspaceMcp: "/unused/workspace-mcp",
      },
      provider: () => (configured ? provider : null),
      providerModelCatalog: async () => [provider.modelId],
      agentPlatformApiKeyForOrigin: () => null,
      workspaceRoot: () => null,
      ...(installed
        ? {
            installedRuntime: {
              configuration: () =>
                loadDesktopInstalledPluginRuntimeConfiguration(dataDirectory),
              deadlineMs: 10_000,
            },
          }
        : {}),
      logOutputs: { stdout: output(), stderr: output() },
    });
    supervisors.add(runtime);
    return runtime;
  }
  async function currentProfile() {
    try {
      const value = JSON.parse(
        await readFile(join(dataDirectory, "plugin-profile.json"), "utf8"),
      );
      assert.equal(value.schemaVersion, "crewon.desktop-plugin-profile.v1");
      assert.deepEqual(value.actor, actor);
      const scope = parsePluginProfileScope(value.scope);
      assert.equal(scope.tenantId, actor.tenantId);
      assert.equal(scope.spaceId, actor.spaceId);
      return scope;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    }
  }
  async function installedApproved(
    identity: unknown,
    scope: NonNullable<Awaited<ReturnType<typeof currentProfile>>>,
  ) {
    const approval = JSON.parse(
      await readFile(join(dataDirectory, DESKTOP_PLUGIN_APPROVAL_FILE), "utf8"),
    );
    assert.equal(approval.schemaVersion, DESKTOP_PLUGIN_APPROVAL_SCHEMA);
    const source = (approval.sources as Source[]).find(
      ({ sourceId: _id, directory: _directory, ...tuple }) =>
        isDeepStrictEqual(tuple, identity),
    );
    if (!source) return false;
    const store = new SqliteRunStore(databasePath);
    try {
      const selection = await store
        .pluginInstallationStore()
        .loadSelection({ scope, pluginId: source.pluginId });
      const pkg = await store
        .pluginInstallationStore()
        .loadPackage({ scope, packageDigest: source.packageDigest });
      return (
        selection !== null &&
        selection.state === "disabled" &&
        selection.selectedPackageDigest === source.packageDigest &&
        pkg !== null &&
        pkg.pluginId === source.pluginId &&
        pkg.publisherId === source.publisherId &&
        pkg.version === source.version
      );
    } finally {
      await store.close();
    }
  }
  async function observations(): Promise<ChildObservation[]> {
    try {
      return (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return [];
      throw error;
    }
  }
  return {
    directory,
    dataDirectory,
    databasePath,
    provider,
    sources,
    supervisor,
    requests,
    logs,
    currentProfile,
    observations,
    modelRequests: () => modelRequests,
    supplierRequests: () => supplierRequests,
    denyPackages: () => {
      denyPackages = true;
    },
    workerConfiguration(
      releaseDocumentPath: string,
      scope: NonNullable<Awaited<ReturnType<typeof currentProfile>>>,
    ) {
      const endpoint = (path: string) => ({
        url: `${origin}/${path}`,
        serviceTokenEnvironmentVariable: tokenName,
      });
      return {
        schemaVersion: "crewon.installed-plugin-worker.v1",
        installRoot: join(dataDirectory, "plugins"),
        releaseDocumentPath,
        actorAuthority: endpoint("actor"),
        profileAuthority: endpoint("profile"),
        packageAuthority: endpoint("package"),
        policyAuthority: endpoint("policy"),
        networkAuthority: null,
        historicalScope: scope,
        timeoutMs: 5000,
      };
    },
    async releaseEnvironment() {
      const release = (await observations()).find((row) =>
        row.entry.endsWith("/runtime-worker/src/release-main.ts"),
      );
      assert.ok(
        release,
        "an actual original release child must supply the source environment",
      );
      return { ...release.environment, CREWON_MODEL_API_KEY: modelKey };
    },
    async assertNoNodeImports() {
      await assert.rejects(readFile(nodePath), { code: "ENOENT" });
    },
    async close() {
      if (closing) return closing;
      closing = (async () => {
        const errors: unknown[] = [];
        let childrenClosed = false;
        try {
          for (const runtime of supervisors) {
            try {
              await runtime.stop();
            } catch (error) {
              errors.push(error);
            }
          }
          server.closeAllConnections();
          try {
            await new Promise<void>((accept, reject) =>
              server.close((error) => (error ? reject(error) : accept())),
            );
          } catch (error) {
            errors.push(error);
          }
          await Promise.allSettled([...pending]);
          errors.push(...failures);
          const children = await observations();
          childrenClosed = true;
          for (const row of children) {
            try {
              assert.throws(() => process.kill(row.pid, 0), { code: "ESRCH" });
            } catch (error) {
              childrenClosed = false;
              errors.push(error);
            }
          }
        } catch (error) {
          errors.push(error);
        } finally {
          for (const key of Object.keys(process.env))
            if (!(key in previousEnvironment)) delete process.env[key];
          Object.assign(process.env, previousEnvironment);
          if (childrenClosed) {
            try {
              const current = await lstat(directory);
              assert.ok(current.isDirectory() && !current.isSymbolicLink());
              assert.equal(current.dev, ownedRoot.dev);
              assert.equal(current.ino, ownedRoot.ino);
              assert.equal(current.uid, ownedRoot.uid);
              await makeOwnedDirectoriesWritable(directory, directory);
              await rm(directory, { recursive: true, force: true });
            } catch (error) {
              errors.push(error);
            }
          }
        }
        if (errors.length)
          throw new AggregateError(
            errors,
            `native_process_cleanup_failed:${directory}`,
          );
      })();
      return closing;
    },
  };
}

/** Only private fixture directories become writable, after every actual child has closed.
 * Do not follow symlinks, chmod files, or touch independently retained delivery sources. */
async function makeOwnedDirectoriesWritable(
  root: string,
  path: string,
): Promise<void> {
  assert.ok(path === root || path.startsWith(root + "/"));
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) return;
  assert.equal(metadata.uid, process.getuid?.());
  await chmod(path, 0o700);
  for (const name of await readdir(path))
    await makeOwnedDirectoriesWritable(root, join(path, name));
}

/** A teardown failure must include, rather than replace, the original behavioral failure. */
export async function closeNativeProcessFixture(
  fixture: Readonly<{ close(): Promise<void> }>,
  failure?: Readonly<{ error: unknown }>,
): Promise<void> {
  try {
    await fixture.close();
  } catch (error) {
    throw new AggregateError(
      failure === undefined ? [error] : [failure.error, error],
      "native_process_test_and_cleanup_failed",
    );
  }
}

export async function nativeProcessHttp(
  session: ControlRuntimeSession,
  method: string,
  path: string,
  body?: unknown,
  key?: string,
) {
  return fetch(new URL(path, session.baseUrl), {
    method,
    headers: {
      "authorization": `Bearer ${session.sessionToken}`,
      "origin": session.origin,
      "x-csrf-token": session.csrfToken,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(key === undefined ? {} : { "idempotency-key": key }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export function nativeProcessFacts(databasePath: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tables = (
      database
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[]
    ).map(({ name }) => name);
    return {
      tables,
      counts: Object.fromEntries(
        tables
          .filter(
            (table) =>
              !table.endsWith("_schema_version") &&
              /^(?:threads$|thread_|runs$|run_|turn|agent_version|active_agent_version|plugin_(?:task|query_task)_admissions$|extension_(?:activations|run_bindings|external_operation))|credit|quote|charge/u.test(
                table,
              ),
          )
          .map((table) => {
            assert.match(table, /^[a-z0-9_]+$/u);
            return [
              table,
              Number(
                (
                  database
                    .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
                    .get() as { count: number }
                ).count,
              ),
            ];
          }),
      ),
    };
  } finally {
    database.close();
  }
}

export async function nativeBootstrapFiles(dataDirectory: string) {
  return (await readdir(dataDirectory)).filter((name) =>
    /^plugin-bootstrap-.+\.json$/u.test(name),
  );
}

function observer(audit: string, imports: string, installRoot: string) {
  return `import {appendFileSync} from 'node:fs';import {registerHooks} from 'node:module';
const env=process.env;const allowed=/^CREWON_(?:ACTOR_ID|PRINCIPAL_ID|TENANT_ID|SPACE_ID|AGENT_VERSION_ID|AUTHORITY_ID|RUNTIME_GENERATION|POLICY_SNAPSHOT_ID|DEV_AGENT_PROFILES_JSON|MODEL_(?:ADAPTER|ID|CATALOG_JSON|CONTEXT_WINDOW_TOKENS)|RESPONSES_(?:ENDPOINT|IDLE_TIMEOUT_MS|STREAM_MAX_RETRIES)|AUTO_COMPACT_AT_TOKENS|NATIVE_WORKSPACE_READ_ENABLED)$/;
appendFileSync(${JSON.stringify(audit)},JSON.stringify({pid:process.pid,entry:process.argv[1],environment:Object.fromEntries(Object.entries(env).filter(([k])=>allowed.test(k))),nativeBootstrap:!!env.CREWON_DESKTOP_PLUGIN_BOOTSTRAP_PATH,authorityTokenPresent:!!env.${tokenName},installed:!!env.CREWON_INSTALLED_PLUGIN_EXECUTION_CONFIG_PATH,peer:!!env.CREWON_INSTALLED_PLUGIN_PEER_TOKEN,preparation:!!env.CREWON_INSTALLED_PLUGIN_NATIVE_PREPARATION_PATH})+'\\n',{mode:0o600});
registerHooks({load(url,context,next){if(url.startsWith(${JSON.stringify(pathToFileURL(installRoot + "/").href)}))appendFileSync(${JSON.stringify(imports)},JSON.stringify({pid:process.pid,url})+'\\n',{mode:0o600});return next(url,context);}});`;
}
