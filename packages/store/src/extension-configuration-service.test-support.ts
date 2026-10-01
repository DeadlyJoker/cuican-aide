import type { TestContext } from "node:test";
import { extensionCanonicalJson, parseExtensionManifest } from "@crewon/domain";
import {
  ExtensionConfigurationApplicationService,
  type AuthorizationPort,
  type AuthorizationAction,
  type ExtensionHostPort,
  type ExtensionReadiness,
  type ExtensionStore,
  type SaveExtensionConfigurationCommand,
  type SetExtensionActivationCommand,
} from "@crewon/application";
import { extensionManifestFixture } from "../../domain/src/extension-manifest.test-support.ts";
import { extensionStoreDigester } from "./extension-store-records.ts";
import {
  extensionFixture,
  scope,
  target,
  timestamp,
  digest,
} from "./extension-store.test-support.ts";

export const actor = {
  principalId: "principal-1",
  actorId: "actor-1",
  tenantId: scope.tenantId,
  spaceId: scope.spaceId,
};
export const saveCommand: SaveExtensionConfigurationCommand = {
  pluginId: scope.pluginId,
  pluginVersion: "0.1.0",
  expectedRevision: 0,
  idempotencyKey: "save-1",
  parameters: { format: "mp4" },
  credentialBindings: [
    { slotId: "provider", credentialBindingId: "credential-1" },
  ],
};
export const activateCommand: SetExtensionActivationCommand = {
  pluginId: scope.pluginId,
  configurationRevision: 1,
  expectedRevision: 0,
  idempotencyKey: "activate-1",
  state: "enabled",
  agentVersionId: target.agentVersionId,
};

/** The host is synthetic here; these tests verify use-case/transaction behavior, not runtime readiness. */
export async function configurationServiceFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
) {
  const f = await extensionFixture(t, backend);
  const manifest = parseExtensionManifest(
    extensionManifestFixture(scope.pluginId),
  );
  const state: {
    denied: AuthorizationAction | null;
    authorizationError: Error | null;
    catalogAvailable: boolean;
    catalogDigest: string;
    implementationDigest: string;
    validationError: Error | null;
    readiness: ExtensionReadiness;
    authorizationGate: Promise<void> | null;
    permissions: Parameters<AuthorizationPort["authorize"]>[0][];
    validated: Parameters<ExtensionHostPort["validateConfiguration"]>[0][];
    evaluated: Parameters<ExtensionHostPort["evaluate"]>[0][];
  } = {
    denied: null,
    authorizationError: null,
    catalogAvailable: true,
    catalogDigest: extensionStoreDigester.sha256(
      extensionCanonicalJson(manifest),
    ),
    implementationDigest: digest,
    validationError: null,
    readiness: { outcome: "ready", target },
    authorizationGate: null,
    permissions: [],
    validated: [],
    evaluated: [],
  };
  const dependencies: Omit<
    ConstructorParameters<typeof ExtensionConfigurationApplicationService>[0],
    "store"
  > = {
    clock: { now: () => timestamp },
    digester: extensionStoreDigester,
    authorization: {
      async authorize(request) {
        state.permissions.push(structuredClone(request));
        await state.authorizationGate;
        if (state.authorizationError !== null) throw state.authorizationError;
        return request.action === state.denied
          ? { outcome: "deny", reasonCode: "test_denied" }
          : { outcome: "allow" };
      },
    },
    catalog: {
      list: () => [],
      resolve: (identity) =>
        state.catalogAvailable &&
        identity.pluginId === scope.pluginId &&
        identity.pluginVersion === manifest.version
          ? {
              manifest,
              manifestDigest: state.catalogDigest,
              implementationDigest: state.implementationDigest,
            }
          : null,
    },
    host: {
      async validateConfiguration(input) {
        state.validated.push(input);
        if (state.validationError !== null) throw state.validationError;
      },
      async evaluate(input) {
        state.evaluated.push(input);
        return state.readiness;
      },
    },
  };
  const createService = (store: ExtensionStore) =>
    new ExtensionConfigurationApplicationService({ store, ...dependencies });
  return {
    ...f,
    state,
    dependencies,
    service: createService(f.first.store),
    secondService: createService(f.second.store),
  };
}
