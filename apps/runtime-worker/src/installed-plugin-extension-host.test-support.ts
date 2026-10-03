import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { createAgentVersionAsset } from "@crewon/agent-version";
import type { ActorContext } from "@crewon/application";
import {
  createExtensionConfiguration,
  type PluginProfileScope,
} from "@crewon/domain";
import { installLocalPluginPackage } from "@crewon/plugin-host";
import { SqliteRunStore } from "@crewon/store";
import { InMemoryAgentVersionRuntimeRegistry } from "./agent-version-runtime.ts";
import { StoreBackedAgentVersionRuntimeResolver } from "./store-backed-agent-version-runtime-resolver.ts";
import {
  factoryFixture,
  digester,
  pluginId,
  scope,
} from "./installed-plugin-agent-runtime-factory.test-support.ts";
import { createInstalledPluginAgentVersionRuntimeFactory } from "./plugins/installed-plugin-agent-runtime-factory.ts";
import { compileInstalledPluginAgentVersion } from "./plugins/installed-plugin-agent-version.ts";
import { loadInstalledPluginBusinessRegistration } from "./plugins/installed-plugin-business-registration.ts";
import {
  InstalledPluginExtensionHost,
  type InstalledPluginExtensionHostDependencies,
} from "./plugins/installed-plugin-extension-host.ts";

export { digester, pluginId, scope };
export const actor: ActorContext = {
  tenantId: scope.tenantId,
  spaceId: scope.spaceId,
  principalId: "principal-1",
  actorId: "actor-1",
};
const timestamp = "2026-10-03T00:00:00.000Z";

export function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Actual installed Node ESM, immutable registration, materializer and SQLite deployment. */
export async function hostFixture(
  t: TestContext,
  options: {
    registerFactory?: boolean;
    requiredServices?: readonly ("externalOperations" | "jsonHttp")[];
    disposeFails?: boolean;
    maximumPackages?: number;
    secondVersion?: boolean;
    selectionState?: "enabled" | "disabled";
  } = {},
) {
  const logs = await mkdtemp(join(tmpdir(), "crewon-installed-readiness-"));
  const path = join(logs, "events");
  const key = "readiness_" + randomUUID().replaceAll("-", "");
  const nodeState = {
    onSetup: null as (() => Promise<void>) | null,
    onDispose: null as (() => Promise<void>) | null,
    revokeFactory: null as (() => void) | null,
  };
  const globals = globalThis as unknown as Record<string, unknown>;
  globals[key] = nodeState;
  let closeOwned = async () => {};
  t.after(async () => {
    await closeOwned();
    delete globals[key];
    await rm(logs, { recursive: true, force: true });
  });
  const node = `import {appendFileSync} from 'node:fs';
const record=v=>appendFileSync(${JSON.stringify(path)},v+'\\n');record('import');
export default {apiVersion:'crewon.plugin-host.v1',pluginId:${JSON.stringify(pluginId)},
async setup(ctx){record('setup');await globalThis[${JSON.stringify(key)}].onSetup?.();
${options.registerFactory === false ? "" : `const registration=ctx.services.get('crewon.execution','1').register({${options.requiredServices === undefined ? "" : "requiredServices:" + JSON.stringify(options.requiredServices) + ","}create(){record('create');throw new Error('readiness must not create a business runtime')}});globalThis[${JSON.stringify(key)}].revokeFactory=()=>registration.dispose();`}
return {async dispose(){record('dispose');await globalThis[${JSON.stringify(key)}].onDispose?.();
${options.disposeFails ? "throw new Error('readiness fixture disposal failed');" : ""}}};}};`;
  const f = await factoryFixture(t, { node });
  const entries = [f.entry];
  if (options.secondVersion) {
    const source = join(f.directory, "second-source");
    await mkdir(source);
    const business = Buffer.from(
      JSON.stringify({ ...f.entry.registration.manifest, version: "2.0.0" }),
    );
    const descriptor = JSON.parse(
      await readFile(join(f.directory, "source", "crewon.plugin.json"), "utf8"),
    );
    await writeFile(join(source, "node.mjs"), node);
    await writeFile(join(source, "business.json"), business);
    await writeFile(
      join(source, "crewon.plugin.json"),
      JSON.stringify({
        ...descriptor,
        version: "2.0.0",
        files: [
          ["node.mjs", Buffer.from(node)],
          ["business.json", business],
        ].map(([path, bytes]) => ({
          path,
          byteLength: (bytes as Buffer).length,
          sha256: createHash("sha256")
            .update(bytes as Buffer)
            .digest("hex"),
        })),
      }),
    );
    const installed = await installLocalPluginPackage({
      directory: source,
      installRoot: f.installRoot,
      authorization: async () => ({ outcome: "allow" }),
    });
    const registration = await loadInstalledPluginBusinessRegistration({
      installRoot: f.installRoot,
      expectedPluginId: pluginId,
      expectedPublisherId: f.entry.registration.identity.publisherId,
      expectedVersion: "2.0.0",
      expectedPackageDigest: installed.packageDigest,
      signal: new AbortController().signal,
      authorizeRead: async () => (f.state.allowed ? "allow" : "deny"),
    });
    entries.push({
      ...f.entry,
      registration,
      configuration: createExtensionConfiguration(
        {
          ...f.entry.configuration,
          pluginVersion: "2.0.0",
          manifestDigest: registration.manifestDigest,
          implementationDigest: registration.implementationDigest,
        },
        digester,
      ),
      version: compileInstalledPluginAgentVersion({
        base: {
          executionAuthority: "crewonKernel",
          version: f.entry.base.version,
        },
        registration,
        agentVersionId: "enterprise-agent-v2",
        runtimeGeneration: "enterprise-generation-v2",
        policySnapshotId: "enterprise-policy-v2",
        digester,
      }),
    });
  }
  const store = new SqliteRunStore(join(f.directory, "control.sqlite"));
  const installations = store.pluginInstallationStore();
  await installations.migrate();
  await installations.recordInstalledPackage({
    scope,
    actor,
    package: {
      schemaVersion: "crewon.installed-plugin-package.v1",
      ...scope,
      ...f.entry.registration.identity,
      installedAt: timestamp,
      installedByPrincipalId: actor.principalId,
      installedByActorId: actor.actorId,
    },
    expectedSelectionRevision: null,
    receipt: {
      idempotencyKey: "install",
      requestDigest: digester.sha256("install"),
    },
  });
  async function select(
    state: "enabled" | "disabled",
    packageDigest = f.entry.registration.identity.packageDigest,
  ) {
    const selection = (await installations.loadSelection({ scope, pluginId }))!;
    return installations.commitSelection({
      scope,
      actor,
      expectedSelectionRevision: selection.revision,
      selection: {
        ...selection,
        selectedPackageDigest: packageDigest,
        state,
        revision: selection.revision + 1,
        updatedAt: timestamp,
        updatedByPrincipalId: actor.principalId,
        updatedByActorId: actor.actorId,
      },
      receipt: {
        idempotencyKey: `selection-${selection.revision}`,
        requestDigest: digester.sha256(
          `selection-${selection.revision}-${state}`,
        ),
      },
    });
  }
  if (options.selectionState !== "disabled") await select("enabled");
  if (entries[1] !== undefined)
    await installations.recordInstalledPackage({
      scope,
      actor,
      package: {
        schemaVersion: "crewon.installed-plugin-package.v1",
        ...scope,
        ...entries[1].registration.identity,
        installedAt: timestamp,
        installedByPrincipalId: actor.principalId,
        installedByActorId: actor.actorId,
      },
      expectedSelectionRevision: 2,
      receipt: {
        idempotencyKey: "install-second",
        requestDigest: digester.sha256("install-second"),
      },
    });
  const factory = createInstalledPluginAgentVersionRuntimeFactory({
    defaultAgentVersionId: f.entry.base.version.agentVersionId,
    entries,
  });
  await store.registerAgentVersion(
    createAgentVersionAsset({
      tenantId: scope.tenantId,
      version: f.entry.version,
      createdAt: timestamp,
    }),
  );
  if (entries[1] !== undefined)
    await store.registerAgentVersion(
      createAgentVersionAsset({
        tenantId: scope.tenantId,
        version: entries[1].version,
        createdAt: timestamp,
      }),
    );
  const releaseId = digester.sha256("readiness deployment");
  await store.activateAgentVersionRelease({
    bundle: {
      schemaVersion: "crewon.agent-version-release-bundle.v0",
      tenantId: scope.tenantId,
      releaseId,
      manifestDigest: releaseId,
      defaultAgentVersionId: f.entry.version.agentVersionId,
      deployments: factory.deploymentBindings(scope.tenantId),
    },
    activation: {
      schemaVersion: "crewon.agent-version-release-activation.v0",
      tenantId: scope.tenantId,
      releaseId,
      activationId: "readiness-activation",
      previousReleaseId: null,
      operator: {
        principalId: actor.principalId,
        actorId: actor.actorId,
        spaceId: actor.spaceId,
      },
      activatedAt: timestamp,
    },
    expectedActiveReleaseId: null,
  });
  const registry = new InMemoryAgentVersionRuntimeRegistry(digester);
  const resolver = new StoreBackedAgentVersionRuntimeResolver({
    store,
    registry,
    factory,
    digester,
  });
  const state = {
    actor: actor as ActorContext | null,
    profile: scope as PluginProfileScope | null,
    allowed: true,
    packageAllowed: true,
    packageChecks: 0,
    actions: [] as string[],
    onPolicy: null as ((action: string) => Promise<void>) | null,
    onPackage: null as (() => Promise<void>) | null,
  };
  const dependencies: InstalledPluginExtensionHostDependencies = {
    scope,
    installRoot: f.installRoot,
    registrations: entries.map((entry) => entry.registration),
    installations,
    authorization: {
      async authorize(input) {
        state.actions.push(input.action);
        await state.onPolicy?.(input.action);
        return state.allowed
          ? { outcome: "allow" }
          : { outcome: "deny", reasonCode: "fixture_denied" };
      },
    },
    resolveActor: async () => state.actor,
    resolveProfile: async () => state.profile,
    authorizePackage: async (input, signal) => {
      if (
        input.purpose !== "submit" ||
        input.scope.profileId !== scope.profileId
      )
        throw new Error("unexpected package authorization scope");
      signal.throwIfAborted();
      state.packageChecks++;
      await state.onPackage?.();
      return state.packageAllowed ? "allow" : "deny";
    },
    runtimeResolver: resolver,
    deployments: store,
    ...(options.maximumPackages === undefined
      ? {}
      : { maximumPackages: options.maximumPackages }),
  };
  const host = new InstalledPluginExtensionHost(dependencies);
  closeOwned = async () => {
    await host.close().catch((error) => {
      if (!options.disposeFails) throw error;
    });
    await resolver.close();
    await registry.close();
    await store.close();
  };
  const request = {
    actor,
    registration: {
      manifest: f.entry.registration.manifest,
      manifestDigest: f.entry.registration.manifestDigest,
      implementationDigest: f.entry.registration.implementationDigest,
    },
    configuration: f.entry.configuration,
    agentVersionId: f.entry.version.agentVersionId,
  };
  return {
    ...f,
    factoryState: f.state,
    host,
    store,
    installations,
    registry,
    resolver,
    factory,
    state,
    nodeState,
    dependencies,
    request,
    secondRequest:
      entries[1] === undefined
        ? null
        : {
            actor,
            registration: {
              manifest: entries[1].registration.manifest,
              manifestDigest: entries[1].registration.manifestDigest,
              implementationDigest:
                entries[1].registration.implementationDigest,
            },
            configuration: entries[1].configuration,
            agentVersionId: entries[1].version.agentVersionId,
          },
    entries,
    select,
    events: async () =>
      (await readFile(path, "utf8").catch(() => ""))
        .trim()
        .split("\n")
        .filter(Boolean),
  };
}
