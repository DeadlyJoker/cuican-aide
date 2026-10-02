import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import {
  ApplicationError,
  PluginInstallationApplicationService,
  PluginUiApplicationService,
  type ActorContext,
  type PluginUiAuthorizationAction,
} from "@crewon/application";
import { parsePluginSelection } from "@crewon/domain";
import {
  LocalPluginInstallationHost,
  LocalPluginUiPackageReader,
  PluginNodeHost,
  verifyLocalPluginPackage,
} from "@crewon/plugin-host";
import { SqliteRunStore } from "@crewon/store";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import { errorResponse } from "./control-api-errors.ts";
import { registerPluginControlRoutes } from "./plugin-control-route.ts";
import { StandaloneIdentity } from "./standalone-adapters.ts";
import {
  AuthorityPluginHostProfile,
  DynamicPluginInstallationAuthorization,
  DynamicPluginUiAuthorization,
} from "./plugin-security-adapters.ts";

export const pluginRouteActor: ActorContext = Object.freeze({
  tenantId: "test-tenant",
  spaceId: "test-space",
  principalId: "test-principal",
  actorId: "test-actor",
});
export const pluginRouteScope = Object.freeze({
  tenantId: pluginRouteActor.tenantId,
  spaceId: pluginRouteActor.spaceId,
  profileId: "test-profile",
});
export const pluginRouteCredentials = Object.freeze({
  origin: "https://plugins.example.test",
  sessionToken: "plugin-route-test-session-" + "s".repeat(32),
  csrfToken: "plugin-route-test-csrf-" + "c".repeat(32),
});
export const pluginRouteHeaders = Object.freeze({
  "authorization": `Bearer ${pluginRouteCredentials.sessionToken}`,
  "origin": pluginRouteCredentials.origin,
  "x-csrf-token": pluginRouteCredentials.csrfToken,
});

/** Actual SQLite/files/Node services. All authority is explicit test policy, not a production account. */
export async function createPluginControlRouteFixture(
  t: TestContext,
  options: Readonly<{ identity?: ControlApiIdentityPort }> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "crewon-plugin-control-"));
  let parent: SqliteRunStore | undefined;
  let observer: DatabaseSync | undefined;
  let nodeHost: PluginNodeHost | undefined;
  let local: LocalPluginInstallationHost | undefined;
  let app: FastifyInstance | undefined;
  t.after(async () => {
    await app?.close();
    try {
      await local?.drain();
      await nodeHost?.close();
    } finally {
      observer?.close();
      await parent?.close();
      await removeOwnedTree(root);
    }
  });
  await chmod(root, 0o700);
  const installRoot = join(root, "installed");
  await mkdir(installRoot, { mode: 0o700 });
  const databasePath = join(root, "control.sqlite");
  parent = new SqliteRunStore(databasePath);
  const ledger = parent.pluginInstallationStore();
  await ledger.migrate();
  observer = new DatabaseSync(databasePath);
  const currentObserver = observer;
  const sources = new Map<string, string>();
  const expectedSources = new Map<string, string>();
  const events: string[] = [];
  const policy = {
    denyInstallation: false,
    denyUi: false,
    denyCommit: false,
    incompatible: false,
    epoch: "test-authority-v1",
    deniedUiActions: new Set<PluginUiAuthorizationAction>(),
    uiActions: [] as PluginUiAuthorizationAction[],
    beforePublication: null as (() => Promise<void>) | null,
  };
  const current = (pluginId: string) => {
    const row = currentObserver
      .prepare(
        "SELECT record_json FROM plugin_profile_selections WHERE tenant_id=? AND space_id=? AND profile_id=? AND plugin_id=?",
      )
      .get(
        pluginRouteScope.tenantId,
        pluginRouteScope.spaceId,
        pluginRouteScope.profileId,
        pluginId,
      );
    return row
      ? parsePluginSelection(JSON.parse(String(row.record_json)))
      : null;
  };
  nodeHost = new PluginNodeHost({
    services: [
      {
        service: "test.recorder",
        apiVersion: "1",
        value: { record: (event: string) => events.push(event) },
      },
    ],
  });
  const currentNodeHost = nodeHost;
  local = new LocalPluginInstallationHost({
    profile: pluginRouteScope,
    installRoot,
    nodeHost,
    resolveSource: async ({ sourceId }) => {
      const source = sources.get(sourceId);
      if (source === undefined)
        throw new ApplicationError("notFound", "test_plugin_source_unknown");
      return source;
    },
    authorizeInstallation: async ({ candidate }) =>
      !policy.denyInstallation &&
      candidate.descriptor.publisherId === "test.publisher" &&
      expectedSources.get(candidate.packageDigest) ===
        candidate.descriptor.pluginId
        ? "allow"
        : "deny",
    authorizeActivation: async () =>
      policy.denyInstallation ? "deny" : "allow",
    validateCompatibility: async () => {
      if (policy.incompatible)
        throw new ApplicationError("conflict", "test_plugin_incompatible");
    },
    authorizeCommit: ({ selection }) =>
      !policy.denyCommit &&
      JSON.stringify(current(selection.pluginId)) === JSON.stringify(selection)
        ? "allow"
        : "deny",
  });
  const profiles = new AuthorityPluginHostProfile({
    timeoutMs: 1_000,
    authority: {
      resolve: async ({ actor }) => {
        if (
          actor.tenantId !== pluginRouteScope.tenantId ||
          actor.spaceId !== pluginRouteScope.spaceId
        )
          throw new ApplicationError(
            "authorization",
            "test_plugin_profile_denied",
          );
        return pluginRouteScope;
      },
    },
  });
  let milliseconds = Date.parse("2026-10-03T00:00:00.000Z");
  const clock = { now: () => new Date(milliseconds).toISOString() };
  const installation = new PluginInstallationApplicationService({
    store: ledger,
    profiles,
    authorization: new DynamicPluginInstallationAuthorization({
      timeoutMs: 1_000,
      policy: {
        decide: async () =>
          policy.denyInstallation
            ? { outcome: "deny", reasonCode: "test_installation_denied" }
            : { outcome: "allow" },
      },
    }),
    host: local,
    clock,
    digester: { sha256: (value) => `sha256:${hash(Buffer.from(value))}` },
  });
  const packages = new LocalPluginUiPackageReader({
    profile: pluginRouteScope,
    installRoot,
    authorizePublication: async ({ descriptor }) => {
      await policy.beforePublication?.();
      if (descriptor.publisherId !== "test.publisher")
        throw new ApplicationError("authorization", "test_publisher_denied");
      return descriptor.files
        .filter((file) => file.path.startsWith("ui/"))
        .map((file) => file.path);
    },
  });
  const ui = new PluginUiApplicationService({
    store: ledger,
    profiles,
    packages,
    clock,
    authorization: new DynamicPluginUiAuthorization({
      timeoutMs: 1_000,
      policy: {
        decide: async ({ action }) => {
          const uiAction = action.slice(
            "pluginUi:".length,
          ) as PluginUiAuthorizationAction;
          policy.uiActions.push(uiAction);
          return policy.denyUi || policy.deniedUiActions.has(uiAction)
            ? { outcome: "deny", reasonCode: "test_ui_denied" }
            : { outcome: "allow", authorityEpoch: policy.epoch };
        },
      },
    }),
    ids: { nextId: () => randomBytes(32).toString("base64url") },
    actions: {
      invoke: async ({ selection, lease, authorityEpoch, action, input }) => {
        if (
          action !== "counter.increment" ||
          lease.contributionId !== "counter" ||
          JSON.stringify(input) !== '{"delta":1}'
        )
          throw new ApplicationError(
            "authorization",
            "test_ui_action_not_allowed",
          );
        const borrow = currentNodeHost.acquire({
          pluginId: selection.pluginId,
          packageDigest: selection.selectedPackageDigest!,
          purpose: "newOperation",
          authorizeBorrow: () =>
            !policy.denyUi &&
            policy.epoch === authorityEpoch &&
            JSON.stringify(current(selection.pluginId)) ===
              JSON.stringify(selection)
              ? "allow"
              : "deny",
        });
        try {
          const service = borrow.getService<{
            increment(): { count: number; version: string };
          }>(selection.pluginId, "1");
          return service.increment();
        } finally {
          borrow.release();
        }
      },
    },
  });
  app = Fastify({ bodyLimit: 64 * 1024, trustProxy: false });
  app.setErrorHandler((error, request, reply) => {
    const mapped = errorResponse(error, request.id);
    return reply.code(mapped.statusCode).send(mapped.body);
  });
  const identity =
    options.identity ??
    new StandaloneIdentity({
      actor: pluginRouteActor,
      sessionToken: pluginRouteCredentials.sessionToken,
      csrfToken: pluginRouteCredentials.csrfToken,
      allowedOrigins: [pluginRouteCredentials.origin],
    });
  registerPluginControlRoutes(app, {
    identity,
    pluginInstallation: installation,
    pluginUi: ui,
  });
  let sourceIndex = 0;
  async function createPackage(
    version: string,
    options: Readonly<{ pluginId?: string; nodeOnly?: boolean }> = {},
  ) {
    const pluginId = options.pluginId ?? "test.counter";
    const sourceId = `test-source-${++sourceIndex}`;
    const directory = join(root, sourceId);
    await mkdir(directory, { mode: 0o700 });
    const content: Record<string, string> = {
      "node.mjs": `export default {apiVersion:'crewon.plugin-host.v1',pluginId:${JSON.stringify(pluginId)},setup(ctx){
const recorder=ctx.services.get('test.recorder','1');recorder.record('setup:${version}');let count=0;
ctx.onDispose(()=>recorder.record('dispose:${version}'));
ctx.services.provide(${JSON.stringify(pluginId)},'1',{increment:()=>({count:++count,version:${JSON.stringify(version)}})});
}};`,
    };
    if (!options.nodeOnly) {
      await mkdir(join(directory, "ui"), { mode: 0o700 });
      content["ui/entry.mjs"] =
        "import {label} from './chunk.mjs';export default {apiVersion:'crewon.plugin-ui.v1',pluginId:" +
        JSON.stringify(pluginId) +
        ",mount(root){root.textContent=label;return {update(){},dispose(){root.replaceChildren();}}}};";
      content["ui/chunk.mjs"] =
        `export const label=${JSON.stringify(version)};`;
    }
    for (const [path, contentBytes] of Object.entries(content))
      await writeFile(join(directory, path), contentBytes);
    await writeFile(
      join(directory, "crewon.plugin.json"),
      JSON.stringify({
        schemaVersion: "crewon.plugin-package.v1",
        hostApi: "crewon.plugin-host.v1",
        pluginId,
        version,
        title: "Test counter",
        description: "HTTP transport fixture, without suppliers or billing.",
        publisherId: "test.publisher",
        entrypoints: {
          node: "node.mjs",
          ui: options.nodeOnly
            ? null
            : { path: "ui/entry.mjs", mode: "trustedModule" },
        },
        businessManifestPath: null,
        requires: [
          { service: "test.recorder", apiVersion: "1", optional: false },
        ],
        provides: [{ service: pluginId, apiVersion: "1" }],
        contributions: options.nodeOnly
          ? []
          : [
              {
                id: "counter",
                title: "Counter",
                kind: "module",
                slot: "main.content",
              },
            ],
        files: Object.entries(content).map(([path, source]) => ({
          path,
          byteLength: Buffer.byteLength(source),
          sha256: hash(Buffer.from(source)),
        })),
      }),
    );
    const verified = await verifyLocalPluginPackage({ directory });
    sources.set(sourceId, directory);
    expectedSources.set(verified.packageDigest, pluginId);
    return {
      sourceId,
      expectedPluginId: pluginId,
      expectedPackageDigest: verified.packageDigest,
      directory,
      content,
    };
  }
  return {
    app,
    root,
    databasePath,
    ledger,
    installation,
    ui,
    packages,
    local,
    nodeHost,
    policy,
    events,
    current,
    createPackage,
    advanceClock: (durationMs: number) => {
      milliseconds += durationMs;
    },
    removeDevelopmentSources: async () => {
      for (const source of sources.values())
        await rm(source, { recursive: true, force: true });
    },
  };
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
async function removeOwnedTree(directory: string): Promise<void> {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory()) await removeOwnedTree(join(directory, entry.name));
  await rm(directory, { recursive: true, force: true });
}
