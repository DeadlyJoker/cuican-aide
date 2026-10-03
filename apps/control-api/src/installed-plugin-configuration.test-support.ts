import type { TestContext } from "node:test";
import { PostgresDomainStore } from "@crewon/store";
import { InstalledPluginConfigurationMetadata } from "./installed-plugin-configuration-metadata.ts";
import {
  businessPackageFixture,
  businessManifest,
} from "../../runtime-worker/src/installed-plugin-business.test-support.ts";
import {
  fixture,
  installationRecipe,
  selectionRecipe,
} from "../../../packages/store/src/plugin-installation-store.test-support.ts";
import {
  actor,
  scope,
  identityFixture,
  request,
  digester,
} from "./installed-plugin-task.test-support.ts";
import { parseInstalledPluginConfigurationConfig } from "./installed-plugin-configuration-environment.ts";
import { createInstalledPluginConfigurationRuntime } from "./installed-plugin-configuration-composition.ts";
export { actor, scope, request, digester, businessManifest };
export const environment = {
  FIXTURE_SERVICE_TOKEN: "fixture-configuration-service-token-000000",
};
export const configDocument = {
  schemaVersion: "crewon.installed-plugin-control-configuration.v1",
  installRoot: "/fixture-installed-root",
  profileAuthority: {
    url: "https://fixture-authority.example/profile",
    serviceTokenEnvironmentVariable: "FIXTURE_SERVICE_TOKEN",
  },
  packageAuthority: {
    url: "https://fixture-authority.example/package",
    serviceTokenEnvironmentVariable: "FIXTURE_SERVICE_TOKEN",
  },
  timeoutMs: 1000,
  maximumPackages: 8,
};
export const saveCommand = {
  pluginId: businessManifest.pluginId,
  pluginVersion: businessManifest.version,
  expectedRevision: 0,
  idempotencyKey: "first-installed-configuration",
  parameters: { organization: "An explicitly named test organization" },
  credentialBindings: [],
};
export async function metadataFixture(
  t: TestContext,
  backend: "sqlite" | "postgres" = "sqlite",
) {
  const storage = await fixture(t, backend);
  const artifact = await businessPackageFixture(t);
  const installed = await storage.first.store.recordInstalledPackage(
    installationRecipe("install-real-metadata", {
      scope,
      actor,
      pluginId: artifact.installed.descriptor.pluginId,
      version: artifact.installed.descriptor.version,
      publisherId: artifact.installed.descriptor.publisherId,
      packageDigest: artifact.installed.packageDigest,
    }),
  );
  const state = {
    allowed: true,
    reads: 0,
    onRead: null as (() => Promise<void>) | null,
  };
  const metadata = new InstalledPluginConfigurationMetadata({
    installRoot: artifact.input.installRoot,
    installations: storage.first.store,
    maximumPackages: 8,
    authorizeRead: async () => {
      state.reads++;
      await state.onRead?.();
      return state.allowed ? "allow" : "deny";
    },
  });
  t.after(() => metadata.close());
  const prepare = (version = businessManifest.version) =>
    metadata.prepare(
      {
        actor,
        scope,
        request: {
          kind: "registration",
          pluginId: businessManifest.pluginId,
          pluginVersion: version,
        },
      },
      { signal: new AbortController().signal },
    );
  return {
    storage,
    artifact,
    installed,
    state,
    metadata,
    prepare,
    uninstall: async () =>
      storage.second.store.commitSelection(
        selectionRecipe(installed.selection, "actual-uninstall", {
          actor,
          state: "uninstalled",
        }),
      ),
  };
}
export async function configurationFixture(t: TestContext) {
  const f = await metadataFixture(t, "postgres");
  if (!(f.storage.first.parent instanceof PostgresDomainStore))
    throw new Error("actual_pg_required");
  const identity = identityFixture();
  const requests = { packages: 0, profiles: 0, other: 0 };
  const runtime = await createInstalledPluginConfigurationRuntime(
    parseInstalledPluginConfigurationConfig(
      { ...configDocument, installRoot: f.artifact.input.installRoot },
      environment,
    ),
    {
      store: f.storage.first.parent,
      identity: identity.identity,
      authorization: { authorize: async () => ({ outcome: "allow" }) },
      clock: { now: () => "2026-10-03T00:00:00.000Z" },
      digester,
      fetch: async (url, input) => {
        if (
          input?.headers &&
          new Headers(input.headers).get("authorization") !==
            `Bearer ${environment.FIXTURE_SERVICE_TOKEN}`
        )
          throw new Error("actual_fixture_service_token_required");
        if (String(url).endsWith("/profile")) {
          requests.profiles++;
          return Response.json(scope);
        }
        if (String(url).endsWith("/package")) {
          requests.packages++;
          const body = JSON.parse(String(input?.body));
          if (body.purpose !== "read")
            throw new Error("metadata_must_only_read");
          return Response.json({ outcome: f.state.allowed ? "allow" : "deny" });
        }
        requests.other++;
        throw new Error("no_peer_quote_model_or_supplier_in_metadata_fixture");
      },
    },
  );
  t.after(() => runtime.close());
  const run = <T>(work: () => Promise<T>) =>
    runtime.requests.run(
      { request, actor, preparation: "configuration" },
      work,
    );
  return { ...f, runtime, requests, identity, run };
}
