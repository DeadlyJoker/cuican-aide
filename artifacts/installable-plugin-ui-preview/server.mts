import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  ApplicationError,
  PluginInstallationApplicationService,
  PluginUiApplicationService,
  type ActorContext,
  type PluginUiJsonValue,
} from "../../packages/application/src/index.ts";
import { parsePluginSelection } from "../../packages/domain/src/index.ts";
import {
  LocalPluginInstallationHost,
  LocalPluginUiPackageReader,
  PluginNodeHost,
  verifyLocalPluginPackage,
} from "../../packages/plugin-host/src/index.ts";
import { SqliteRunStore } from "../../packages/store/src/index.ts";
import { buildIndependentUiPackages } from "./build-fixture.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(join(repository, "apps/crewon-ui/package.json"));
const { createServer } = await import(require.resolve("vite"));
const { default: react } = await import(
  require.resolve("@vitejs/plugin-react")
);
const { default: tailwindcss } = await import(
  require.resolve("@tailwindcss/vite")
);
const root = await mkdtemp(join(tmpdir(), "crewon-independent-ui-browser-"));
const installRoot = join(root, "installed");
const ownedCleanup: (() => void | Promise<void>)[] = [];
const events: unknown[] = [];
const installed: { version: string; packageDigest: string }[] = [];
let developmentRemoved = false;
let server: Awaited<ReturnType<typeof createServer>> | undefined;
let serverClosed = true;
let readSelection: () => unknown = () => null;
let initializing = true;
let exitRequested = false;
let stopping: Promise<void> | undefined;
const shutdownRequested = new Error("fixture_shutdown_requested");
const fault = process.env.CREWON_PLUGIN_UI_FIXTURE_FAULT;

async function removeOwnedTree(directory: string) {
  await chmod(directory, 0o700);
  for (const item of await readdir(directory, { withFileTypes: true }))
    if (item.isDirectory()) await removeOwnedTree(join(directory, item.name));
  await rm(directory, { recursive: true, force: true });
}
function checkpoint() {
  if (exitRequested) throw shutdownRequested;
}
function stop(): Promise<void> {
  return (stopping ??= cleanup());
}
function finish() {
  exitRequested = true;
  // Initialization owns its in-flight writes. Its next checkpoint starts cleanup only after
  // that operation settles, so a signal cannot remove a directory still being built or installed.
  if (initializing) return;
  void stop().then(
    () => process.exit(0),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
async function cleanup() {
  const failures: string[] = [];
  let finalSelection: unknown = null;
  try {
    finalSelection = readSelection();
  } catch (error) {
    failures.push(String(error));
  }
  for (const action of [...ownedCleanup].reverse()) {
    try {
      await action();
    } catch (error) {
      failures.push(String(error));
    }
  }
  try {
    await mkdir(join(repository, "output/extensions/independent-ui"), {
      recursive: true,
    });
    await writeFile(
      join(
        repository,
        "output/extensions/independent-ui/browser-server-evidence.json",
      ),
      JSON.stringify(
        {
          fixture: true,
          developmentRemoved,
          installed,
          events,
          selected: finalSelection,
          cleanupFailures: failures,
          ownedServerClosed: serverClosed,
          ownedRoot: root,
        },
        null,
        2,
      ),
    );
  } finally {
    if (failures.length === 0) await removeOwnedTree(root);
  }
  if (failures.length)
    throw new Error(`fixture_cleanup_failed:${failures.join(",")}`);
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, finish);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (value: string) => {
  if (value.trim() === "stop") finish();
});

try {
  await chmod(root, 0o700);
  checkpoint();
  await mkdir(installRoot, { mode: 0o700 });
  checkpoint();
  const parent = new SqliteRunStore(join(root, "control.sqlite"));
  ownedCleanup.push(() => parent.close());
  const store = parent.pluginInstallationStore();
  await store.migrate();
  checkpoint();
  // Internal deterministic lifecycle probes; no public CLI or production fault configuration.
  if (fault === "after-store-migrate")
    throw new Error("fixture_initialization_fault");
  if (fault === "pause-after-store-migrate") {
    console.log(
      JSON.stringify({
        fixture: true,
        phase: "initialization-gate",
        ownedRoot: root,
        pid: process.pid,
      }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    checkpoint();
  }
  const observer = new DatabaseSync(join(root, "control.sqlite"));
  ownedCleanup.push(() => observer.close());
  const nodeHost = new PluginNodeHost({ services: [] });
  ownedCleanup.push(() => nodeHost.close());
  const actor: ActorContext = Object.freeze({
    tenantId: "fixture-tenant",
    spaceId: "fixture-space",
    principalId: "fixture-user",
    actorId: "fixture-actor",
  });
  const scope = Object.freeze({
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    profileId: "fixture-profile",
  });
  const cookie = randomBytes(32).toString("hex");
  const sources = new Map<string, string>();
  const policy = { allowed: true, epoch: "fixture-epoch-1" };
  const profiles = {
    resolve: async (who: ActorContext) => {
      assert.deepEqual(who, actor);
      return scope;
    },
  };
  const clock = { now: () => new Date().toISOString() };
  const digester = {
    sha256: (value: string) =>
      `sha256:${createHash("sha256").update(value).digest("hex")}`,
  };
  const current = () => {
    const row = observer
      .prepare(
        "SELECT record_json FROM plugin_profile_selections WHERE tenant_id=? AND space_id=? AND profile_id=? AND plugin_id=?",
      )
      .get(scope.tenantId, scope.spaceId, scope.profileId, "example.ui-story");
    return row
      ? parsePluginSelection(JSON.parse(String(row.record_json)))
      : null;
  };
  readSelection = current;
  const local = new LocalPluginInstallationHost({
    profile: scope,
    installRoot,
    nodeHost,
    resolveSource: async ({ sourceId }) => {
      const directory = sources.get(sourceId);
      if (!directory)
        throw new ApplicationError("notFound", "fixture_source_unknown");
      return directory;
    },
    authorizeInstallation: async ({ candidate }) =>
      candidate.descriptor.pluginId === "example.ui-story" &&
      candidate.descriptor.publisherId === "example.publisher"
        ? "allow"
        : "deny",
    authorizeActivation: async ({ candidate }) =>
      candidate.descriptor.pluginId === "example.ui-story" ? "allow" : "deny",
    validateCompatibility: async ({ package: pkg }) => {
      if (pkg && pkg.pluginId !== "example.ui-story")
        throw new ApplicationError("conflict", "fixture_not_compatible");
    },
    authorizeCommit: ({ selection }) =>
      JSON.stringify(current()) === JSON.stringify(selection)
        ? "allow"
        : "deny",
  });
  ownedCleanup.push(() => local.drain());
  const installation = new PluginInstallationApplicationService({
    store,
    profiles,
    host: local,
    clock,
    digester,
    authorization: {
      authorize: async ({ actor: who }) =>
        JSON.stringify(who) === JSON.stringify(actor)
          ? { outcome: "allow" }
          : { outcome: "deny", reasonCode: "fixture_actor_denied" },
    },
  });
  const packages = new LocalPluginUiPackageReader({
    profile: scope,
    installRoot,
    authorizePublication: async ({ descriptor }) =>
      descriptor.files
        .filter((file) => file.path.startsWith("ui/"))
        .map((file) => file.path),
  });
  const ui = new PluginUiApplicationService({
    store,
    profiles,
    packages,
    clock,
    ids: { nextId: () => randomBytes(32).toString("hex") },
    authorization: {
      authorize: async ({ actor: who }) =>
        policy.allowed && JSON.stringify(who) === JSON.stringify(actor)
          ? { outcome: "allow", authorityEpoch: policy.epoch }
          : { outcome: "deny", reasonCode: "fixture_ui_revoked" },
    },
    actions: {
      invoke: async (input): Promise<PluginUiJsonValue> => {
        if (
          input.action !== "counter.increment" ||
          JSON.stringify(input.input) !== '{"delta":1}'
        )
          throw new ApplicationError(
            "authorization",
            "fixture_action_not_allowed",
          );
        const lease = nodeHost.acquire({
          pluginId: input.package.pluginId,
          packageDigest: input.package.packageDigest,
          purpose: "newOperation",
          authorizeBorrow: () => {
            const selected = current();
            return policy.allowed &&
              policy.epoch === input.authorityEpoch &&
              selected?.state === "enabled" &&
              selected.revision === input.lease.selectionRevision &&
              selected.selectedPackageDigest === input.package.packageDigest
              ? "allow"
              : "deny";
          },
        });
        try {
          const output = lease
            .getService<{
              increment(): { version: string; count: number };
            }>("example.ui-counter", "1")
            .increment();
          events.push({
            event: "action",
            ...output,
            packageDigest: input.package.packageDigest,
          });
          return output;
        } finally {
          lease.release();
        }
      },
    },
  });

  const external = await buildIndependentUiPackages(root);
  checkpoint();
  for (const pkg of external.packages) {
    const verified = await verifyLocalPluginPackage({
      directory: pkg.directory,
    });
    checkpoint();
    const sourceId = `source-${pkg.version}`;
    sources.set(sourceId, pkg.directory);
    const outcome = await installation.install(actor, {
      sourceId,
      expectedPluginId: "example.ui-story",
      expectedPackageDigest: verified.packageDigest,
      expectedSelectionRevision: installed.length === 0 ? null : 1,
      idempotencyKey: `install-${pkg.version}`,
    });
    installed.push({
      version: pkg.version,
      packageDigest: outcome.package.packageDigest,
    });
    checkpoint();
  }
  await external.removeDevelopment();
  developmentRemoved = true;
  sources.clear();
  checkpoint();
  await installation.select(actor, {
    pluginId: "example.ui-story",
    state: "enabled",
    selectedPackageDigest: installed[0]!.packageDigest,
    expectedSelectionRevision: 1,
    idempotencyKey: "initial-enable",
  });
  checkpoint();
  const script = `/@fs${repository}artifacts/installable-plugin-ui-preview/preview.tsx`;
  server = await createServer({
    configFile: false,
    root: join(repository, "apps/crewon-ui"),
    envDir: join(repository, "output/extensions/empty-preview-env"),
    resolve: {
      alias: {
        "@": join(repository, "apps/crewon-ui/src"),
        "@crewon/contracts/plugins": require.resolve(
          "@crewon/contracts/plugins",
        ),
      },
      dedupe: ["react", "react-dom"],
    },
    optimizeDeps: {
      entries: [
        join(repository, "artifacts/installable-plugin-ui-preview/preview.tsx"),
      ],
    },
    server: {
      host: "127.0.0.1",
      port: 5720,
      strictPort: true,
      fs: { allow: [repository] },
    },
    plugins: [
      tailwindcss(),
      react(),
      {
        name: "installed-ui-fixture",
        configureServer(instance: {
          middlewares: {
            use: (
              handler: (
                request: IncomingMessage,
                response: ServerResponse,
                next: () => void,
              ) => Promise<void>,
            ) => void;
          };
          transformIndexHtml: (path: string, html: string) => Promise<string>;
        }) {
          instance.middlewares.use(async (request, response, next) => {
            const url = new URL(request.url ?? "/", "http://127.0.0.1:5720");
            if (url.pathname === "/") {
              response.setHeader(
                "Set-Cookie",
                `fixture_ui_session=${cookie}; HttpOnly; SameSite=Strict; Path=/`,
              );
              response.setHeader("Content-Type", "text/html; charset=utf-8");
              response.end(
                await instance.transformIndexHtml(
                  "/",
                  `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>CrewON · 独立插件加载验证</title></head><body><div id="root"></div><script type="module" src="${script}"></script></body></html>`,
                ),
              );
              return;
            }
            if (!url.pathname.startsWith("/fixture-ui/")) return next();
            try {
              if (
                !(request.headers.cookie ?? "")
                  .split(";")
                  .some(
                    (part: string) =>
                      part.trim() === `fixture_ui_session=${cookie}`,
                  )
              )
                throw new ApplicationError(
                  "authorization",
                  "fixture_session_required",
                );
              if (
                ["x-crewon-actor", "x-actor-id", "x-tenant-id"].some(
                  (header) => request.headers[header],
                )
              )
                throw new ApplicationError(
                  "authorization",
                  "fixture_actor_header_forbidden",
                );
              if (
                request.method !== "GET" &&
                (request.method !== "POST" ||
                  request.headers.origin !== "http://127.0.0.1:5720")
              )
                throw new ApplicationError(
                  "authorization",
                  "fixture_origin_required",
                );
              if (url.pathname.startsWith("/fixture-ui/assets/")) {
                const parts = url.pathname
                  .slice("/fixture-ui/assets/".length)
                  .split("/");
                const mountRef = parts.shift()!;
                const path = parts.map(decodeURIComponent).join("/");
                const asset = await ui.readAsset(actor, { mountRef, path });
                events.push({
                  event: "asset",
                  path,
                  mountRef,
                  byteLength: asset.bytes.length,
                  sha256: createHash("sha256")
                    .update(asset.bytes)
                    .digest("hex"),
                });
                response.setHeader("Content-Type", asset.contentType);
                response.setHeader("X-Content-Type-Options", "nosniff");
                response.setHeader("Cache-Control", "no-store");
                response.end(Buffer.from(asset.bytes));
                return;
              }
              let bytes = 0;
              const body: Buffer[] = [];
              for await (const chunk of request) {
                bytes += chunk.length;
                if (bytes > 65536)
                  throw new ApplicationError(
                    "validation",
                    "fixture_body_limit",
                  );
                body.push(chunk);
              }
              const command = bytes
                ? JSON.parse(Buffer.concat(body).toString("utf8"))
                : {};
              let output: unknown;
              switch (url.pathname) {
                case "/fixture-ui/catalog":
                  output = await ui.catalog(actor, {
                    afterPluginId: null,
                    limit: 50,
                  });
                  break;
                case "/fixture-ui/open":
                  output = await ui.openMount(actor, command);
                  events.push({
                    event: "open",
                    mountRef: (output as { mountRef: string }).mountRef,
                  });
                  break;
                case "/fixture-ui/validate":
                  output = await ui.validateMount(actor, command);
                  break;
                case "/fixture-ui/invoke":
                  output = await ui.invoke(actor, command);
                  break;
                case "/fixture-ui/close":
                  await ui.closeMount(actor, command);
                  events.push({ event: "close", mountRef: command.mountRef });
                  output = null;
                  break;
                case "/fixture-ui/upgrade": {
                  const previous = current()!;
                  output = await installation.select(actor, {
                    pluginId: "example.ui-story",
                    state: "enabled",
                    selectedPackageDigest: installed[1]!.packageDigest,
                    expectedSelectionRevision: previous.revision,
                    idempotencyKey: `upgrade-${previous.revision}`,
                  });
                  break;
                }
                case "/fixture-ui/disable": {
                  const previous = current()!;
                  output = await installation.select(actor, {
                    pluginId: "example.ui-story",
                    state: "disabled",
                    selectedPackageDigest: previous.selectedPackageDigest,
                    expectedSelectionRevision: previous.revision,
                    idempotencyKey: `disable-${previous.revision}`,
                  });
                  break;
                }
                case "/fixture-ui/revoke":
                  policy.allowed = false;
                  policy.epoch = "fixture-epoch-2";
                  output = null;
                  break;
                case "/fixture-ui/evidence":
                  output = {
                    developmentRemoved,
                    installed,
                    events,
                    selected: current(),
                    fixture: true,
                  };
                  break;
                default:
                  throw new ApplicationError(
                    "notFound",
                    "fixture_route_unknown",
                  );
              }
              response.setHeader("Content-Type", "application/json");
              response.setHeader("Cache-Control", "no-store");
              response.end(JSON.stringify(output));
            } catch (error) {
              response.statusCode =
                error instanceof ApplicationError
                  ? error.category === "authorization"
                    ? 403
                    : error.category === "notFound"
                      ? 404
                      : 409
                  : 500;
              response.setHeader("Content-Type", "application/json");
              response.end(
                JSON.stringify({
                  error:
                    error instanceof Error ? error.message : "fixture_failed",
                }),
              );
            }
          });
        },
      },
    ],
  });
  serverClosed = false;
  const ownedServer = server;
  ownedCleanup.push(async () => {
    await ownedServer.close();
    serverClosed = true;
  });
  checkpoint();
  await server.listen();
  checkpoint();
  initializing = false;
  console.log(
    JSON.stringify({
      url: "http://127.0.0.1:5720/",
      fixture: true,
      developmentRemoved,
      installed,
      ownedRoot: root,
      pid: process.pid,
    }),
  );
} catch (error) {
  initializing = false;
  await stop();
  if (error === shutdownRequested) process.exit(0);
  throw error;
}
