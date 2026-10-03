/** Actual production HTTP and PG fixture for the original Web settings route. No Worker or funding. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, X509Certificate } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest, createServer as httpServer } from "node:http";
import { createServer, type Server } from "node:https";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PostgresDomainStore } from "@crewon/store";
import { Pool } from "pg";
import {
  TEST_CA_CERT,
  TEST_SERVER_CERT,
  TEST_SERVER_KEY,
} from "../../device-gateway/src/mtls-test-certificates.test-support.ts";
import {
  businessManifest,
  businessPackageFixture,
} from "../../runtime-worker/src/installed-plugin-business.test-support.ts";
import { installationRecipe } from "../../../packages/store/src/plugin-installation-store.test-support.ts";
import { trackDesktopTestChildren } from "../../crewon-ui/electron/desktopPluginTestChildren.test-support.ts";

const repository = fileURLToPath(new URL("../../..", import.meta.url));
const uiRoot = join(repository, "apps/crewon-ui");
const uiRequire = createRequire(join(uiRoot, "package.json"));
export const configurationUiActor = Object.freeze({
  tenantId: "named-ui-configuration-tenant",
  spaceId: "named-ui-configuration-space",
  principalId: "named-ui-configuration-person",
  actorId: "named-ui-configuration-actor",
});
export const configurationUiScope = Object.freeze({
  tenantId: configurationUiActor.tenantId,
  spaceId: configurationUiActor.spaceId,
  profileId: "named-ui-configuration-profile",
});
const authorityToken = "named-configuration-authority-" + "a".repeat(40);
const accessToken = "named-configuration-access-" + "b".repeat(40);
const bffToken = "named-configuration-bff-" + "c".repeat(40);
const cookieName = "crewon_test_session";
const cookieValue = "approved-named-configuration-browser";
const issuer = "https://named-configuration-identity.example";
type Child = Readonly<{
  child: ChildProcess;
  completion: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output(): string;
  finished(): boolean;
}>;

export async function configurationUiBrowserFixture(
  t: TestContext,
  connectionString: string,
) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "crewon-configuration-ui-browser-")),
  );
  const schema = "configuration_ui_" + randomUUID().replaceAll("-", "");
  const evidenceDirectory = process.env
    .CREWON_CONFIGURATION_UI_EVIDENCE_DIRECTORY
    ? await realpath(process.env.CREWON_CONFIGURATION_UI_EVIDENCE_DIRECTORY)
    : join(directory, "evidence");
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  const packageCleanups: Array<() => Promise<void> | void> = [];
  const packageContext = {
    after: (cleanup: () => Promise<void> | void) =>
      packageCleanups.push(cleanup),
  } as unknown as TestContext;
  const children: Child[] = [];
  const admin = new Pool({ connectionString, max: 1 });
  let store: PostgresDomainStore | null = null;
  let server: Server | null = null;
  let closed = false;
  const failures: unknown[] = [];
  const state = {
    identityAllowed: true,
    packagesAllowed: true,
    configurationAllowed: true,
    authorityRequests: [] as { path: string; action: string | null }[],
    browserRequests: [] as { method: string; path: string; status: number }[],
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    const errors: unknown[] = [];
    for (const child of [...children].reverse())
      try {
        await stop(child);
      } catch (error) {
        errors.push(error);
      }
    try {
      server?.closeAllConnections();
      if (server)
        await new Promise<void>((accept, reject) =>
          server!.close((error) => (error ? reject(error) : accept())),
        );
      await store?.close();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } catch (error) {
      errors.push(error);
    } finally {
      await admin.end();
      for (const cleanup of packageCleanups.reverse())
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      await rm(directory, { recursive: true, force: true });
    }
    if (errors.length)
      throw new AggregateError(
        errors,
        "configuration_ui_fixture_cleanup_failed",
      );
  };
  t.after(close);

  const artifact = await businessPackageFixture(packageContext);
  const installRoot = await realpath(artifact.input.installRoot);
  const approvedDirectory = join(directory, "approved-business-delivery");
  await cp(artifact.installed.directory, approvedDirectory, {
    recursive: true,
  });
  await chmod(approvedDirectory, 0o700);
  store = await PostgresDomainStore.open({
    connectionString,
    schema,
    maxPoolSize: 2,
  });
  const ledger = store.pluginInstallationStore();
  await ledger.migrate();
  const installed = await ledger.recordInstalledPackage(
    installationRecipe("named-browser-package-install", {
      actor: configurationUiActor,
      scope: configurationUiScope,
      pluginId: artifact.installed.descriptor.pluginId,
      publisherId: artifact.installed.descriptor.publisherId,
      version: artifact.installed.descriptor.version,
      packageDigest: artifact.installed.packageDigest,
    }),
  );
  assert.equal(installed.selection.state, "disabled");

  // Build only the named test composition. CSS is the exact final production UI build.
  const esbuild = await import(uiRequire.resolve("esbuild"));
  const browserDirectory = join(directory, "browser");
  await mkdir(browserDirectory, { mode: 0o700 });
  await esbuild.build({
    absWorkingDir: uiRoot,
    entryPoints: [
      join(
        uiRoot,
        "src/components/app/InstalledPluginConfigurationUi.test-support.tsx",
      ),
    ],
    outfile: join(browserDirectory, "browser.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    alias: { "@": join(uiRoot, "src") },
    loader: { ".css": "empty", ".svg": "file", ".png": "file" },
    nodePaths: [join(repository, "node_modules")],
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  const staticFiles = new Map<string, { bytes: Buffer; contentType: string }>();
  const distDirectory = join(uiRoot, "dist");
  const distIndex = await readFile(join(distDirectory, "index.html"), "utf8");
  const styles = [...distIndex.matchAll(/href="([^"?#]+\.css)"/gu)].map(
    (match) => {
      const asset = new URL(
        match[1]!,
        "https://configuration-fixture.invalid/",
      );
      assert.equal(asset.origin, "https://configuration-fixture.invalid");
      return asset.pathname;
    },
  );
  assert.ok(styles.length > 0, "final production UI CSS build is required");
  const csp = /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/u.exec(
    distIndex,
  )?.[0];
  assert.ok(csp, "the original production UI CSP is required");
  async function collect(root: string, prefix: string) {
    const walk = async (current: string) => {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        assert.ok(!entry.isSymbolicLink());
        const path = join(current, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) {
          if (!/\.(?:js|css|svg|png|woff2?)$/u.test(entry.name)) continue;
          assert.ok(staticFiles.size < 512);
          const bytes = await readFile(path);
          assert.ok(bytes.byteLength <= 32 * 1024 * 1024);
          staticFiles.set(prefix + relative(root, path).replaceAll("\\", "/"), {
            bytes,
            contentType: mime(path),
          });
        }
      }
    };
    await walk(root);
  }
  await collect(distDirectory, "/");
  await collect(browserDirectory, "/proof/");
  // Vite loads this actual route's CSS when its lazy chunk is imported. This
  // named composition imports the same route eagerly, so include that unchanged
  // production artifact after the original index styles, in the same order.
  const settingsStyles = [...staticFiles.keys()].filter((path) =>
    /^\/assets\/CommandSettingsRoute-[^/]+\.css$/u.test(path),
  );
  assert.equal(
    settingsStyles.length,
    1,
    "final settings route CSS is required",
  );
  styles.push(settingsStyles[0]!);
  for (const path of styles) assert.ok(staticFiles.has(path), path);
  const html = Buffer.from(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${csp}${styles.map((path) => `<link rel="stylesheet" href="${path}">`).join("")}</head><body><div id="root"></div><script type="module" src="/proof/browser.js"></script></body></html>`,
  );
  let bffTarget: string | null = null;
  server = createServer(
    { key: TEST_SERVER_KEY, cert: TEST_SERVER_CERT, minVersion: "TLSv1.3" },
    (request, response) => {
      const path = new URL(request.url!, "https://localhost").pathname;
      if (path.startsWith("/authority/")) {
        void (async () => {
          assert.equal(request.method, "POST");
          assert.equal(
            request.headers.authorization,
            `Bearer ${authorityToken}`,
          );
          let size = 0;
          const chunks: Buffer[] = [];
          for await (const value of request) {
            size += Buffer.byteLength(value);
            assert.ok(size <= 128 * 1024);
            chunks.push(Buffer.from(value));
          }
          const text = Buffer.concat(chunks).toString("utf8");
          const body = text ? JSON.parse(text) : {};
          state.authorityRequests.push({
            path,
            action: typeof body.action === "string" ? body.action : null,
          });
          let value: unknown;
          switch (path) {
            case "/authority/session":
              assert.equal(
                request.headers.cookie,
                `${cookieName}=${cookieValue}`,
              );
              if (!state.identityAllowed) response.statusCode = 401;
              value = state.identityAllowed
                ? {
                    controlAccessToken: accessToken,
                    sessionId: "named-configuration-session-" + "s".repeat(32),
                    expiresAt: new Date(Date.now() + 300_000).toISOString(),
                  }
                : {};
              break;
            case "/authority/verify":
              assert.deepEqual(body, { accessToken });
              if (!state.identityAllowed) response.statusCode = 401;
              value = state.identityAllowed
                ? {
                    ...configurationUiActor,
                    issuer,
                    audience: "crewon-control",
                    issuedAt: new Date(Date.now() - 1000).toISOString(),
                    expiresAt: new Date(Date.now() + 300_000).toISOString(),
                  }
                : {};
              break;
            case "/authority/profile":
              assert.deepEqual(body, { actor: configurationUiActor });
              value = configurationUiScope;
              break;
            case "/authority/package":
              assert.deepEqual(body, {
                schemaVersion: "crewon.plugin-execution-package.v1",
                identity: {
                  pluginId: artifact.installed.descriptor.pluginId,
                  publisherId: artifact.installed.descriptor.publisherId,
                  version: artifact.installed.descriptor.version,
                  packageDigest: artifact.installed.packageDigest,
                },
                scope: configurationUiScope,
                purpose: "read",
              });
              value = { outcome: state.packagesAllowed ? "allow" : "deny" };
              break;
            case "/authority/policy":
              assert.deepEqual(body.actor, configurationUiActor);
              value =
                body.action === "extension:configure" &&
                !state.configurationAllowed
                  ? {
                      outcome: "deny",
                      reasonCode: "named_configuration_withdrawn",
                    }
                  : { outcome: "allow" };
              break;
            case "/authority/installation-policy":
              assert.deepEqual(body.actor, configurationUiActor);
              assert.ok(String(body.action).startsWith("pluginInstallation:"));
              value = {
                outcome: "allow",
                authorityEpoch: "named-browser-installation-epoch-1",
              };
              break;
            default:
              throw new Error("configuration_browser_unexpected_authority");
          }
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify(value));
        })().catch((error: unknown) => {
          failures.push(error);
          response.writeHead(500).end('{"fixture":"failed"}');
        });
      } else if (
        path === "/control-api/session" ||
        path.startsWith("/api/v1/")
      ) {
        if (bffTarget === null) return void response.writeHead(503).end();
        const upstream = httpRequest(
          new URL(request.url!, bffTarget),
          { method: request.method, headers: request.headers },
          (answer) => {
            state.browserRequests.push({
              method: request.method!,
              path,
              status: answer.statusCode!,
            });
            response.writeHead(answer.statusCode!, answer.headers);
            answer.pipe(response);
          },
        );
        upstream.on("error", () => response.destroy());
        request.once("aborted", () => upstream.destroy());
        response.once("close", () => upstream.destroy());
        request.pipe(upstream);
      } else {
        const asset =
          path === "/"
            ? { bytes: html, contentType: "text/html; charset=utf-8" }
            : staticFiles.get(path);
        if (!asset) return void response.writeHead(404).end();
        response.writeHead(200, {
          "content-type": asset.contentType,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        response.end(asset.bytes);
      }
    },
  );
  await new Promise<void>((accept, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `https://localhost:${address.port}`;
  const controlPort = await freePort(),
    bffPort = await freePort();
  const endpoint = (name: string) => ({
    url: `${origin}/authority/${name}`,
    serviceTokenEnvironmentVariable: "NAMED_CONFIGURATION_AUTHORITY_TOKEN",
  });
  const metadataPath = join(directory, "metadata-configuration.json");
  const keyPath = join(directory, "artifact-encryption-key");
  const caPath = join(directory, "named-fixture-ca.pem");
  const importCounter = join(directory, "installed-node-imports.jsonl");
  const importHook = join(directory, "observe-installed-module-loads.mjs");
  await writeFile(
    metadataPath,
    JSON.stringify({
      schemaVersion: "crewon.installed-plugin-control-configuration.v1",
      installRoot,
      profileAuthority: endpoint("profile"),
      packageAuthority: endpoint("package"),
      timeoutMs: 10000,
      maximumPackages: 4,
    }),
    { mode: 0o600 },
  );
  await writeFile(keyPath, randomBytes(32), { mode: 0o600 });
  await writeFile(caPath, TEST_CA_CERT, { mode: 0o600 });
  await writeFile(importCounter, "", { mode: 0o600 });
  await writeFile(
    importHook,
    `import {registerHooks} from 'node:module';import {appendFileSync} from 'node:fs';const prefix=${JSON.stringify(pathToFileURL(installRoot).href + "/")};registerHooks({load(url,context,next){if(url.startsWith(prefix)&&/\\.m?js(?:\\?|$)/u.test(url))appendFileSync(${JSON.stringify(importCounter)},'installed-node-import\\n');return next(url,context);}});`,
    { mode: 0o600 },
  );
  const environment = cleanEnvironment();
  Object.assign(environment, {
    NODE_EXTRA_CA_CERTS: caPath,
    CREWON_CONTROL_SECURITY_MODE: "production",
    CREWON_CONTROL_DATABASE_URL: connectionString,
    CREWON_CONTROL_DATABASE_SCHEMA: schema,
    CREWON_CONTROL_PORT: String(controlPort),
    CREWON_CONTROL_BFF_TOKEN: bffToken,
    CREWON_BFF_ALLOWED_ORIGINS: origin,
    CREWON_BFF_ALLOWED_REMOTE_ADDRESSES: "127.0.0.1",
    CREWON_IDENTITY_VERIFY_URL: `${origin}/authority/verify`,
    CREWON_IDENTITY_SERVICE_TOKEN: authorityToken,
    CREWON_IDENTITY_EXPECTED_ISSUER: issuer,
    CREWON_IDENTITY_EXPECTED_AUDIENCE: "crewon-control",
    CREWON_IDENTITY_CACHE_TTL_MS: "0",
    CREWON_POLICY_DECISION_URL: `${origin}/authority/policy`,
    CREWON_POLICY_SERVICE_TOKEN: authorityToken,
    CREWON_ARTIFACT_RETENTION: "off",
    CREWON_ARTIFACT_ROOT: join(directory, "artifacts"),
    CREWON_ARTIFACT_DB_PATH: join(directory, "artifacts.sqlite"),
    CREWON_ARTIFACT_ENCRYPTION_KEY_PATH: keyPath,
    CREWON_ARTIFACT_ENCRYPTION_KEY_ID: "named-ui-configuration-key",
    CREWON_OUTBOX_RETENTION_MS: "off",
    CREWON_INSTALLED_PLUGIN_CONFIGURATION_CONFIG_PATH: metadataPath,
    NAMED_CONFIGURATION_AUTHORITY_TOKEN: authorityToken,
    CREWON_PLUGIN_INSTALLATION_ENABLED: "1",
    CREWON_PLUGIN_INSTALLATION_INSTALL_ROOT: installRoot,
    CREWON_PLUGIN_INSTALLATION_SOURCES_JSON: JSON.stringify([
      {
        sourceId: "named-business-ui-source",
        directory: approvedDirectory,
        pluginId: artifact.installed.descriptor.pluginId,
        publisherId: artifact.installed.descriptor.publisherId,
        version: artifact.installed.descriptor.version,
        packageDigest: artifact.installed.packageDigest,
      },
    ]),
    CREWON_PLUGIN_INSTALLATION_PROFILE_AUTHORITY_URL: `${origin}/authority/profile`,
    CREWON_PLUGIN_INSTALLATION_PROFILE_AUTHORITY_TOKEN: authorityToken,
    CREWON_PLUGIN_INSTALLATION_POLICY_AUTHORITY_URL: `${origin}/authority/installation-policy`,
    CREWON_PLUGIN_INSTALLATION_POLICY_AUTHORITY_TOKEN: authorityToken,
    CREWON_PLUGIN_INSTALLATION_AUTHORITY_TIMEOUT_MS: "10000",
  });
  const start = (entry: "control-api" | "web-bff", env = environment) => {
    const owned = child(
      process.execPath,
      [
        "--experimental-strip-types",
        ...(entry === "control-api" ? ["--import", importHook] : []),
        join(repository, `apps/${entry}/src/main.ts`),
      ],
      env,
    );
    children.push(owned);
    return owned;
  };
  let control = start("control-api");
  await ready(control, "CrewON Control API listening");
  const bff = start("web-bff", {
    ...environment,
    CREWON_WEB_PUBLIC_ORIGIN: origin,
    CREWON_CONTROL_TARGET: `http://127.0.0.1:${controlPort}`,
    CREWON_CONTROL_CSRF_TOKEN:
      "named-configuration-control-csrf-" + "c".repeat(40),
    CREWON_WEB_CSRF_SECRET:
      "named-configuration-browser-csrf-" + "s".repeat(40),
    CREWON_IDENTITY_SESSION_URL: `${origin}/authority/session`,
    CREWON_WEB_BFF_PORT: String(bffPort),
  });
  await ready(bff, "CrewON Web BFF listening");
  bffTarget = `http://127.0.0.1:${bffPort}`;
  const launcher = join(directory, "browser-launcher.mjs");
  await esbuild.build({
    entryPoints: [
      join(
        uiRoot,
        "electron/installedPluginConfigurationUi.browser-driver.test-support.ts",
      ),
    ],
    outfile: launcher,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    external: ["electron"],
    logLevel: "silent",
  });
  const runBrowser = async (phase: "write" | "read", value: string) => {
    const path = join(directory, "browser-" + phase + ".json");
    await writeFile(
      path,
      JSON.stringify({
        origin,
        cookieName,
        cookieValue,
        certificateFingerprint: new X509Certificate(TEST_SERVER_CERT)
          .fingerprint256,
        phase,
        value,
        pluginId: businessManifest.pluginId,
        evidenceDirectory,
        userData: join(directory, "browser-profile-" + phase),
      }),
      { mode: 0o600 },
    );
    const owned = child(String(uiRequire("electron")), [launcher, path], {
      ...cleanEnvironment(),
      NODE_EXTRA_CA_CERTS: caPath,
    });
    children.push(owned);
    const descendants = trackDesktopTestChildren(owned.child);
    try {
      const result = await terminal(owned, 90_000);
      assert.equal(result.code, 0, owned.output());
      assert.equal(result.signal, null);
      const proof = /CREWON_CONFIGURATION_UI_PROOF:(.+)/u.exec(owned.output());
      assert.ok(proof, owned.output());
      assert.deepEqual(failures, []);
      return JSON.parse(proof[1]!);
    } finally {
      if (!owned.finished()) owned.child.kill("SIGKILL");
      await owned.completion;
      assert.deepEqual(
        await descendants.close(),
        [],
        "the actual browser must physically retire its owned Chromium children",
      );
    }
  };
  return {
    origin,
    schema,
    store,
    installed,
    state,
    evidenceDirectory,
    runBrowser,
    restartControl: async () => {
      await stop(control);
      control = start("control-api");
      await ready(control, "CrewON Control API listening");
    },
    configuration: () =>
      store!.extensionStore().loadLatestExtensionConfiguration({
        tenantId: configurationUiActor.tenantId,
        spaceId: configurationUiActor.spaceId,
        pluginId: businessManifest.pluginId,
      }),
    absence: async () => {
      const names = new Set(
        (
          await admin.query(
            "SELECT table_name FROM information_schema.tables WHERE table_schema=$1",
            [schema],
          )
        ).rows.map((row) => String(row.table_name)),
      );
      const executionRows: Record<string, number> = {};
      for (const table of [
        "runs",
        "agent_versions",
        "agent_version_deployments",
        "agent_version_release_bundles",
        "agent_version_release_activations",
        "active_agent_version_releases",
        "external_operations",
        "extension_run_bindings",
        "extension_external_operations",
      ])
        executionRows[table] = names.has(table)
          ? Number(
              (
                await admin.query(
                  `SELECT count(*) AS count FROM "${schema}"."${table}"`,
                )
              ).rows[0]!.count,
            )
          : 0;
      return {
        creditTables: [...names].filter((name) =>
          /credit|admission/u.test(name),
        ),
        executionRows,
        installedNodeImports: await readFile(importCounter, "utf8"),
      };
    },
    close,
  };
}

function child(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Child {
  const process = spawn(command, [...args], {
    cwd: repository,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "",
    finished = false;
  process.stdout!.on("data", (value: Buffer) => {
    output += value.toString("utf8");
    if (output.length > 256 * 1024) process.kill("SIGKILL");
  });
  process.stderr!.on("data", (value: Buffer) => {
    output += value.toString("utf8");
    if (output.length > 256 * 1024) process.kill("SIGKILL");
  });
  const completion = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((accept, reject) => {
    process.once("error", reject);
    process.once("close", (code, signal) => {
      finished = true;
      accept({ code, signal });
    });
  });
  return {
    child: process,
    completion,
    output: () => output,
    finished: () => finished,
  };
}
async function terminal(owned: Child, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      owned.completion,
      new Promise<never>((_accept, reject) => {
        timer = setTimeout(() => {
          owned.child.kill("SIGKILL");
          reject(
            new Error(
              "configuration_browser_process_timeout:" + owned.output(),
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function stop(owned: Child): Promise<void> {
  if (!owned.finished()) owned.child.kill("SIGTERM");
  const result = await terminal(owned, 15_000);
  assert.equal(result.code, 0, owned.output());
  assert.equal(result.signal, null);
}
async function ready(owned: Child, line: string): Promise<void> {
  const until = Date.now() + 30_000;
  while (!owned.output().includes(line)) {
    assert.ok(!owned.finished(), owned.output());
    assert.ok(Date.now() < until, line + ":" + owned.output());
    await new Promise((accept) => setTimeout(accept, 20));
  }
}
async function freePort(): Promise<number> {
  const socket = httpServer();
  await new Promise<void>((accept) => socket.listen(0, "127.0.0.1", accept));
  const address = socket.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((accept) => socket.close(() => accept()));
  return port;
}
function cleanEnvironment(): NodeJS.ProcessEnv {
  const result = { ...process.env };
  for (const name of Object.keys(result))
    if (
      name.startsWith("CREWON_") ||
      name === "ELECTRON_RUN_AS_NODE" ||
      name === "NODE_OPTIONS" ||
      name === "NODE_EXTRA_CA_CERTS" ||
      name === "AICUICAN_API_KEY"
    )
      delete result[name];
  return result;
}
function mime(path: string): string {
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".woff2")) return "font/woff2";
  return "font/woff";
}
