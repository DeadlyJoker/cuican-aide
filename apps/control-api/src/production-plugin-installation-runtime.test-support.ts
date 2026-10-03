import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import { PostgresDomainStore } from "@crewon/store";
import { verifyLocalPluginPackage } from "@crewon/plugin-host";
import {
  PLUGIN_PACKAGE_HOST_API,
  PLUGIN_PACKAGE_SCHEMA_VERSION,
  type PluginPackageDescriptor,
} from "@crewon/contracts/plugins";
import type { ActorContext } from "@crewon/application";
import type { PluginProfileScope } from "@crewon/domain";
import type {
  ProductionPluginInstallationConfiguration,
  ProductionPluginInstallationSource,
} from "./production-plugin-installation-environment.ts";
import { createProductionPluginSourceRegistry } from "./production-plugin-source-registry.ts";
import {
  createProductionPluginInstallationRuntime,
  type ProductionPluginInstallationRuntime,
} from "./production-plugin-installation-runtime.ts";

export const managementActor: ActorContext = Object.freeze({
  tenantId: "tenant-management",
  spaceId: "space-management",
  actorId: "actor-management",
  principalId: "principal-management",
});
export const managementScope = Object.freeze({
  tenantId: managementActor.tenantId,
  spaceId: managementActor.spaceId,
  profileId: "profile-management",
});
export const postgresOptions = { skip: !process.env.CREWON_TEST_POSTGRES_URL };
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export async function until(
  predicate: () => Promise<boolean> | boolean,
): Promise<void> {
  const end = Date.now() + 5000;
  while (!(await predicate())) {
    assert.ok(Date.now() < end, "real lifecycle condition did not complete");
    await setTimeout(5);
  }
}

/** Explicit HTTPS authority fixture plus actual PG, installer, copied stable public SDK and native ESM. */
export async function managementFixture(t: TestContext) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "crewon-production-management-")),
  );
  await chmod(root, 0o700);
  const installRoot = join(root, "installed");
  await mkdir(installRoot, { mode: 0o700 });
  const eventsPath = join(root, "node-events.txt");
  const schema = `management_${randomUUID().replaceAll("-", "")}`;
  const connectionString = process.env.CREWON_TEST_POSTGRES_URL!;
  const observer = new Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 5000,
  });
  let parent: PostgresDomainStore | undefined;
  const runtimes: ProductionPluginInstallationRuntime[] = [];
  t.after(async () => {
    for (const runtime of runtimes) await runtime.close().catch(() => {});
    await parent?.close();
    await observer.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await observer.end();
    await removeOwnedTree(root);
  });
  parent = await PostgresDomainStore.open({
    connectionString,
    schema,
    maxPoolSize: 4,
  });
  const ledger = parent.pluginInstallationStore();
  await ledger.migrate();
  const sources: ProductionPluginInstallationSource[] = [];
  const state = {
    epoch: "management_epoch_1",
    scope: managementScope as PluginProfileScope,
    deny: new Set<string>(),
    policyCalls: [] as Record<string, unknown>[],
    profileCalls: 0,
    beforePolicy: null as
      | ((
          payload: Record<string, unknown>,
          signal: AbortSignal,
        ) => Promise<void>)
      | null,
    reply: null as ((payload: Record<string, unknown>) => unknown) | null,
  };
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const destination = new URL(String(url));
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    assert.equal(destination.protocol, "https:");
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.deepEqual(payload.actor, managementActor);
    if (destination.pathname === "/profile") {
      state.profileCalls++;
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        `Bearer ${"p".repeat(32)}`,
      );
      return Response.json(state.scope);
    }
    assert.equal(destination.pathname, "/policy");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      `Bearer ${"s".repeat(32)}`,
    );
    state.policyCalls.push(payload);
    await state.beforePolicy?.(payload, init!.signal as AbortSignal);
    if (state.reply !== null) return Response.json(state.reply(payload));
    return Response.json(
      state.deny.has(String(payload.action))
        ? { outcome: "deny", reasonCode: "management_test_denied" }
        : { outcome: "allow", authorityEpoch: state.epoch },
    );
  };
  async function source(
    version = "1.0.0",
    options: Readonly<{
      pluginId?: string;
      business?: boolean;
      uiOnly?: boolean;
      requires?: PluginPackageDescriptor["requires"];
      provides?: PluginPackageDescriptor["provides"];
      cleanupFails?: boolean;
    }> = {},
  ) {
    const pluginId = options.pluginId ?? "test.management";
    const sourceId = `source_${sources.length}`;
    const directory = join(root, sourceId);
    await mkdir(directory, { mode: 0o700 });
    const files: PluginPackageDescriptor["files"][number][] = [];
    async function file(path: string, content: string | Buffer) {
      const bytes = Buffer.from(content);
      await writeFile(join(directory, path), bytes);
      files.push({
        path,
        byteLength: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    if (!options.uiOnly) {
      // Stable public distribution is copied, never built or packed by this consumer fixture.
      const sdkRoot = fileURLToPath(
        new URL("../../../packages/plugin-sdk/dist/", import.meta.url),
      );
      await cp(sdkRoot, join(directory, "sdk"), { recursive: true });
      async function inventory(path = "sdk") {
        for (const entry of await readdir(join(directory, path), {
          withFileTypes: true,
        })) {
          const relative = `${path}/${entry.name}`;
          if (entry.isDirectory()) await inventory(relative);
          else {
            const bytes = await readFile(join(directory, relative));
            files.push({
              path: relative,
              byteLength: bytes.length,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            });
          }
        }
      }
      await inventory();
      await file(
        "node.mjs",
        `import {definePlugin} from './sdk/node.js';import {appendFile} from 'node:fs/promises';
export default definePlugin({apiVersion:'crewon.plugin-host.v1',pluginId:${JSON.stringify(pluginId)},async setup(context){
await appendFile(${JSON.stringify(eventsPath)},'setup:${pluginId}:${version}\\n');
for(const provision of ${JSON.stringify(options.provides ?? [{ service: pluginId, apiVersion: "1" }])}){
const registration=context.services.provide(provision.service,provision.apiVersion,{invoke(){throw new Error('fixture_execution_unavailable')}});
context.onDispose(()=>registration.dispose());}
context.onDispose(async()=>{await appendFile(${JSON.stringify(eventsPath)},'cleanup:${pluginId}:${version}\\n');${options.cleanupFails ? "throw new Error('actual_fixture_cleanup_failed');" : ""}});
}});`,
      );
    } else
      await file(
        "ui.mjs",
        "export default {apiVersion:'crewon.plugin-ui.v1',mount(){throw new Error('not mounted by management')}};",
      );
    if (options.business) {
      const manifest = JSON.parse(
        await readFile(
          new URL(
            "../../../examples/plugins/professional-report/business.json",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      manifest.pluginId = pluginId;
      manifest.version = version;
      await file("business.json", JSON.stringify(manifest));
    }
    const descriptor: PluginPackageDescriptor = {
      schemaVersion: PLUGIN_PACKAGE_SCHEMA_VERSION,
      hostApi: PLUGIN_PACKAGE_HOST_API,
      pluginId,
      publisherId: "test.publisher",
      version,
      title: "Management installed package",
      description:
        "Real management fixture; execution and price are intentionally unavailable.",
      entrypoints: {
        node: options.uiOnly ? null : "node.mjs",
        ui: options.uiOnly ? { path: "ui.mjs", mode: "trustedModule" } : null,
      },
      businessManifestPath: options.business ? "business.json" : null,
      requires: options.requires ?? [],
      provides: options.uiOnly
        ? []
        : (options.provides ?? [{ service: pluginId, apiVersion: "1" }]),
      contributions: [],
      files: files.sort((a, b) => (a.path < b.path ? -1 : 1)),
    };
    await writeFile(
      join(directory, "crewon.plugin.json"),
      JSON.stringify(descriptor),
    );
    const actual = await verifyLocalPluginPackage({ directory });
    const approved = {
      sourceId,
      directory,
      pluginId,
      publisherId: descriptor.publisherId,
      version,
      packageDigest: actual.packageDigest,
    };
    sources.push(approved);
    return approved;
  }
  function configuration(): ProductionPluginInstallationConfiguration {
    return {
      installRoot,
      sources: [...sources],
      profileAuthority: {
        url: "https://management.example/profile",
        serviceToken: "p".repeat(32),
      },
      policyAuthority: {
        url: "https://management.example/policy",
        serviceToken: "s".repeat(32),
      },
      timeoutMs: 2000,
    };
  }
  async function open(
    options: Readonly<{
      approvedSources?: readonly ProductionPluginInstallationSource[];
    }> = {},
  ) {
    const config = {
      ...configuration(),
      ...(options.approvedSources === undefined
        ? {}
        : { sources: options.approvedSources }),
    };
    const registry = await createProductionPluginSourceRegistry(config);
    const runtime = createProductionPluginInstallationRuntime(
      { configuration: config, registry },
      {
        ledger,
        clock: { now: () => "2026-10-03T04:00:00.000Z" },
        digester: {
          sha256: (value) =>
            `sha256:${createHash("sha256").update(value).digest("hex")}`,
        },
        fetch,
      },
    );
    runtimes.push(runtime);
    return runtime;
  }
  const install = (
    runtime: ProductionPluginInstallationRuntime,
    pkg: ProductionPluginInstallationSource,
    expectedSelectionRevision: number | null = null,
    idempotencyKey = `install_${randomUUID()}`,
  ) =>
    runtime.service.install(managementActor, {
      sourceId: pkg.sourceId,
      expectedPluginId: pkg.pluginId,
      expectedPackageDigest: pkg.packageDigest,
      expectedSelectionRevision,
      idempotencyKey,
    });
  const select = (
    runtime: ProductionPluginInstallationRuntime,
    pkg: ProductionPluginInstallationSource,
    revision: number,
    state: "enabled" | "disabled" | "uninstalled" = "enabled",
    idempotencyKey = `select_${randomUUID()}`,
  ) =>
    runtime.service.select(managementActor, {
      pluginId: pkg.pluginId,
      state,
      selectedPackageDigest: state === "uninstalled" ? null : pkg.packageDigest,
      expectedSelectionRevision: revision,
      idempotencyKey,
    });
  const events = async () =>
    (await readFile(eventsPath, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean);
  const selection = async (pluginId: string) =>
    (
      await observer.query<{ record_json: unknown }>(
        `SELECT record_json FROM "${schema}".plugin_profile_selections WHERE plugin_id=$1`,
        [pluginId],
      )
    ).rows[0]?.record_json;
  const ownerPids = async () =>
    (
      await observer.query<{ pid: number }>(
        `SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid=((hashtextextended($1,0)>>32)&4294967295)::oid AND objid=(hashtextextended($1,0)&4294967295)::oid AND objsubid=1`,
        [
          JSON.stringify([
            "plugin-installation-profile-owner.v1",
            schema,
            state.scope.tenantId,
            state.scope.spaceId,
            state.scope.profileId,
          ]),
        ],
      )
    ).rows.map((row) => row.pid);
  return {
    root,
    installRoot,
    ledger,
    observer,
    parent,
    schema,
    state,
    source,
    open,
    install,
    select,
    events,
    selection,
    ownerPids,
    fetch,
    configuration,
  };
}

async function removeOwnedTree(path: string): Promise<void> {
  await chmod(path, 0o700);
  for (const entry of await readdir(path, { withFileTypes: true }))
    if (entry.isDirectory()) await removeOwnedTree(join(path, entry.name));
  await rm(path, { recursive: true, force: true });
}
