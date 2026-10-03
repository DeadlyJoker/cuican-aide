import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createExtensionConfiguration,
  extensionCanonicalJson,
  parseExtensionManifest,
  type ExtensionActivation,
  type ExtensionConfiguration,
  type ExtensionExecutionTarget,
} from "@crewon/domain";
import { extensionManifestFixture } from "../../domain/src/extension-manifest.test-support.ts";
import { ApplicationError } from "./application-error.ts";
import type {
  AuthorizationAction,
  AuthorizationPort,
} from "./authorization-port.ts";
import {
  ExtensionConfigurationApplicationService,
  type SaveExtensionConfigurationCommand,
  type SetExtensionActivationCommand,
} from "./extension-configuration-application-service.ts";
import { ExtensionReadApplicationService } from "./extension-read-application-service.ts";
import type {
  ExtensionCatalogPort,
  ExtensionCatalogPreparation,
  ExtensionHostPort,
  ExtensionReadiness,
} from "./extension-host-port.ts";
import type {
  ExtensionMutationReceipt,
  ExtensionStore,
  SaveExtensionActivationInput,
  SaveExtensionConfigurationInput,
} from "./extension-store-port.ts";

const actor = {
  principalId: "preparation-principal",
  actorId: "preparation-actor",
  tenantId: "preparation-tenant",
  spaceId: "preparation-space",
};
const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
const manifest = parseExtensionManifest({
  ...extensionManifestFixture("example.preparation"),
  credentialSlots: [],
});
const registration = {
  manifest,
  manifestDigest: digester.sha256(extensionCanonicalJson(manifest)),
  implementationDigest: digester.sha256("application-only-static-metadata"),
};
const target: ExtensionExecutionTarget = {
  executionAuthority: "crewonKernel",
  agentVersionId: "preparation-agent",
  agentVersionContentDigest: digester.sha256("agent"),
  materializationDigest: digester.sha256("materialization"),
  authorityId: "preparation-authority",
  runtimeGeneration: "preparation-generation",
  policySnapshotId: "preparation-policy",
  workspaceBindingId: null,
};
const saveCommand: SaveExtensionConfigurationCommand = {
  pluginId: manifest.pluginId,
  pluginVersion: manifest.version,
  expectedRevision: 0,
  idempotencyKey: "first-configuration",
  parameters: { format: "mp4" },
  credentialBindings: [],
};
const enableCommand: SetExtensionActivationCommand = {
  pluginId: manifest.pluginId,
  configurationRevision: 1,
  expectedRevision: 0,
  idempotencyKey: "first-activation",
  state: "enabled",
  agentVersionId: target.agentVersionId,
};
const at = "2026-10-03T00:00:00.000Z";
function storedConfiguration() {
  return createExtensionConfiguration(
    {
      schemaVersion: "crewon.extension-configuration.v0",
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      pluginId: manifest.pluginId,
      pluginVersion: manifest.version,
      revision: 1,
      manifestDigest: registration.manifestDigest,
      implementationDigest: registration.implementationDigest,
      parameters: saveCommand.parameters,
      credentialBindings: [],
      createdByActorId: actor.actorId,
      createdAt: at,
    },
    digester,
  );
}
function gate() {
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  return {
    reached,
    release,
    async wait() {
      entered();
      await waiting;
    },
  };
}

/** Typed Application-only doubles. These tests prove call ordering, not SQL atomicity,
 * installed byte authority, a deployed Worker, supplier execution or paid-task admission. */
function fixture(
  options: { legacy?: boolean; configured?: boolean; ready?: boolean } = {},
) {
  const state = {
    metadataPrepared: options.legacy === true,
    preparations: [] as ExtensionCatalogPreparation[],
    permissions: [] as Parameters<AuthorizationPort["authorize"]>[0][],
    denied: new Set<AuthorizationAction>(),
    events: [] as string[],
    resolves: 0,
    validations: 0,
    evaluations: 0,
    configurationLoads: 0,
    configuration: options.configured
      ? storedConfiguration()
      : (null as ExtensionConfiguration | null),
    activation: null as ExtensionActivation | null,
    configurationWrites: [] as SaveExtensionConfigurationInput[],
    activationWrites: [] as SaveExtensionActivationInput[],
    onPrepare: null as null | (() => Promise<void>),
    onValidate: null as null | (() => Promise<void>),
    onEvaluate: null as null | (() => Promise<void>),
    readiness: options.ready
      ? { outcome: "ready" as const, target }
      : ({
          outcome: "unavailable" as const,
          reasonCode: "extension_runtime_unavailable" as const,
        } as ExtensionReadiness),
  };
  const savedConfigurations = new Map<
    string,
    { digest: string; value: ExtensionConfiguration }
  >();
  const savedActivations = new Map<
    string,
    { digest: string; value: ExtensionActivation }
  >();
  const receiptKey = (receipt: ExtensionMutationReceipt) =>
    JSON.stringify([receipt.actorId, receipt.idempotencyKey]);
  const replay = <T>(
    saved: { digest: string; value: T } | undefined,
    receipt: ExtensionMutationReceipt,
  ): T | null => {
    if (saved === undefined) return null;
    if (saved.digest !== receipt.requestDigest)
      throw new ApplicationError("conflict", "fixture_receipt_conflict");
    return saved.value;
  };
  const unused = async (): Promise<never> =>
    assert.fail("unrelated execution/store port must not be called");
  const store: ExtensionStore = {
    async loadExtensionConfiguration(input) {
      state.events.push("configuration:load");
      state.configurationLoads++;
      return state.configuration?.revision === input.revision
        ? state.configuration
        : null;
    },
    async loadLatestExtensionConfiguration() {
      state.configurationLoads++;
      return state.configuration;
    },
    async loadExtensionConfigurationReceipt({ receipt }) {
      state.events.push("configuration:receipt");
      return replay(savedConfigurations.get(receiptKey(receipt)), receipt);
    },
    async saveExtensionConfiguration(input) {
      state.events.push("configuration:write");
      state.configurationWrites.push(input);
      state.configuration = input.configuration;
      savedConfigurations.set(receiptKey(input.receipt), {
        digest: input.receipt.requestDigest,
        value: input.configuration,
      });
      return { disposition: "created", configuration: input.configuration };
    },
    async loadExtensionActivation() {
      return state.activation;
    },
    async loadExtensionActivationReceipt({ receipt }) {
      state.events.push("activation:receipt");
      return replay(savedActivations.get(receiptKey(receipt)), receipt);
    },
    async saveExtensionActivation(input) {
      state.events.push("activation:write");
      state.activationWrites.push(input);
      state.activation = input.activation;
      savedActivations.set(receiptKey(input.receipt), {
        digest: input.receipt.requestDigest,
        value: input.activation,
      });
      return { disposition: "updated", activation: input.activation };
    },
    commitExtensionRun: unused,
    commitExtensionTurn: unused,
    loadExtensionTurnReceipt: unused,
    loadExtensionRunReceipt: unused,
    loadExtensionRunBinding: unused,
  };
  const catalog: ExtensionCatalogPort = {
    ...(options.legacy
      ? {}
      : {
          async prepare(input: ExtensionCatalogPreparation) {
            state.events.push("metadata:prepare");
            state.preparations.push(structuredClone(input));
            await state.onPrepare?.();
            state.metadataPrepared = true;
          },
        }),
    list: () => (state.metadataPrepared ? [registration] : []),
    resolve(input) {
      state.events.push("metadata:resolve");
      state.resolves++;
      return state.metadataPrepared &&
        input.pluginId === manifest.pluginId &&
        input.pluginVersion === manifest.version
        ? registration
        : null;
    },
  };
  const host: ExtensionHostPort = {
    async validateConfiguration(input) {
      state.events.push("configuration:validate");
      state.validations++;
      assert.deepEqual(input.actor, actor);
      assert.deepEqual(input.registration, registration);
      await state.onValidate?.();
    },
    async evaluate(input) {
      state.events.push("runtime:evaluate");
      state.evaluations++;
      assert.deepEqual(input.actor, actor);
      assert.equal(input.agentVersionId, target.agentVersionId);
      await state.onEvaluate?.();
      return state.readiness;
    },
  };
  const authorization: AuthorizationPort = {
    async authorize(input) {
      state.events.push(`authorize:${input.action}`);
      state.permissions.push(structuredClone(input));
      return state.denied.has(input.action)
        ? { outcome: "deny", reasonCode: "fixture_revoked" }
        : { outcome: "allow" };
    },
  };
  const dependencies = {
    store,
    catalog,
    host,
    authorization,
    digester,
    clock: { now: () => at },
  };
  const service = new ExtensionConfigurationApplicationService(dependencies);
  const read = new ExtensionReadApplicationService({
    runs: { loadRunInSpace: unused },
    agentVersions: {
      loadAgentVersion: unused,
      loadAgentVersionDeployment: unused,
    },
    extensions: store,
    operations: {
      listExternalOperations: unused,
      loadExternalOperation: unused,
    },
    catalog,
    host,
    authorization,
    digester,
  });
  return { state, service, read, dependencies };
}

test("old configuration and activation receipts and configuration GETs do not prepare metadata", async () => {
  const f = fixture({ legacy: true, ready: true });
  const saved = await f.service.saveConfiguration(actor, saveCommand);
  const enabled = await f.service.setActivation(actor, enableCommand);
  const service = new ExtensionConfigurationApplicationService({
    ...f.dependencies,
    catalog: {
      ...f.dependencies.catalog,
      prepare: async () =>
        assert.fail("a saved receipt or GET must not prepare metadata"),
    },
  });
  const counts = {
    resolves: f.state.resolves,
    validations: f.state.validations,
    evaluations: f.state.evaluations,
    loads: f.state.configurationLoads,
  };
  const replayed = await service.saveConfiguration(actor, saveCommand);
  assert.equal(replayed.disposition, "replayed");
  assert.deepEqual(replayed.configuration, saved.configuration);
  const activation = await service.setActivation(actor, enableCommand);
  assert.equal(activation.disposition, "replayed");
  assert.deepEqual(activation.activation, enabled.activation);
  assert.equal(
    f.state.configurationLoads,
    counts.loads,
    "activation replay does not load its configuration again",
  );
  assert.deepEqual(
    await service.getConfiguration(actor, {
      pluginId: manifest.pluginId,
      revision: 1,
    }),
    saved.configuration,
  );
  assert.deepEqual(
    await service.getConfiguration(actor, {
      pluginId: manifest.pluginId,
      revision: null,
    }),
    saved.configuration,
  );
  assert.deepEqual(
    await service.getActivation(actor, manifest.pluginId),
    enabled.activation,
  );
  assert.equal(f.state.resolves, counts.resolves);
  assert.equal(f.state.validations, counts.validations);
  assert.equal(f.state.evaluations, counts.evaluations);
  assert.equal(f.state.configurationWrites.length, 1);
  assert.equal(f.state.activationWrites.length, 1);
});

test("a first configuration prepares the requested metadata, validates its schema, and saves real declaration digests", async () => {
  const f = fixture();
  assert.equal(f.dependencies.catalog.resolve(saveCommand), null);
  f.state.events.length = 0;
  const result = await f.service.saveConfiguration(actor, saveCommand);
  assert.equal(result.disposition, "created");
  assert.deepEqual(result.configuration, storedConfiguration());
  assert.deepEqual(f.state.preparations, [
    {
      actor,
      request: {
        kind: "registration",
        pluginId: manifest.pluginId,
        pluginVersion: manifest.version,
      },
    },
  ]);
  assert.equal(f.state.configurationWrites.length, 1);
  assert.deepEqual(
    f.state.permissions.map(({ action }) => action),
    ["extension:configure", "extension:configure", "extension:configure"],
  );
  assert.deepEqual(f.state.events, [
    "authorize:extension:configure",
    "configuration:receipt",
    "metadata:prepare",
    "authorize:extension:configure",
    "metadata:resolve",
    "configuration:validate",
    "authorize:extension:configure",
    "configuration:write",
  ]);
  assert.equal(f.state.evaluations, 0);
  const invalid = fixture();
  await assert.rejects(
    invalid.service.saveConfiguration(actor, {
      ...saveCommand,
      parameters: { format: "gif" },
    }),
    { category: "validation", code: "extension_configuration_invalid" },
  );
  assert.equal(invalid.state.preparations.length, 1);
  assert.equal(invalid.state.validations, 0);
  assert.equal(invalid.state.configurationWrites.length, 0);
});

for (const stage of ["prepare", "validate"] as const) {
  test(
    `configure withdrawal during ${stage} leaves no configuration write`,
    { timeout: 5000 },
    async (t) => {
      const f = fixture();
      const pending = gate();
      t.after(pending.release);
      if (stage === "prepare") f.state.onPrepare = pending.wait;
      else f.state.onValidate = pending.wait;
      const saving = f.service.saveConfiguration(actor, saveCommand);
      await pending.reached;
      f.state.denied.add("extension:configure");
      pending.release();
      await assert.rejects(saving, {
        category: "authorization",
        code: "authorization_denied",
      });
      assert.equal(f.state.configurationWrites.length, 0);
      assert.equal(f.state.configuration, null);
      assert.equal(f.state.validations, stage === "prepare" ? 0 : 1);
      assert.equal(f.state.permissions.length, stage === "prepare" ? 2 : 3);
    },
  );
}

test("enabled activation prepares the saved version but unavailable execution remains unavailable without writing", async () => {
  const f = fixture({ configured: true });
  await assert.rejects(f.service.setActivation(actor, enableCommand), {
    category: "conflict",
    code: "extension_runtime_unavailable",
  });
  assert.deepEqual(f.state.preparations, [
    {
      actor,
      request: {
        kind: "registration",
        pluginId: manifest.pluginId,
        pluginVersion: manifest.version,
      },
    },
  ]);
  assert.ok(
    f.state.events.indexOf("configuration:load") <
      f.state.events.indexOf("metadata:prepare"),
  );
  assert.equal(f.state.evaluations, 1);
  assert.equal(f.state.activationWrites.length, 0);
  assert.equal(f.state.activation, null);
});

test(
  "activation withdrawal while readiness waits prevents persistence of an otherwise ready target",
  { timeout: 5000 },
  async (t) => {
    const f = fixture({ configured: true, ready: true });
    const pending = gate();
    t.after(pending.release);
    f.state.onEvaluate = pending.wait;
    const activating = f.service.setActivation(actor, enableCommand);
    await pending.reached;
    f.state.denied.add("extension:activate");
    pending.release();
    await assert.rejects(activating, {
      category: "authorization",
      code: "authorization_denied",
    });
    assert.equal(f.state.activationWrites.length, 0);
    assert.deepEqual(
      f.state.permissions.map(({ action }) => action),
      ["extension:activate", "extension:activate"],
    );
  },
);

test("disabled and revoked activation keep metadata and readiness entirely lazy", async () => {
  for (const state of ["disabled", "revoked"] as const) {
    const f = fixture({ configured: true });
    f.state.onPrepare = async () =>
      assert.fail("withdrawal must not read metadata");
    f.state.onEvaluate = async () =>
      assert.fail("withdrawal must not evaluate execution");
    const result = await f.service.setActivation(actor, {
      ...enableCommand,
      state,
      agentVersionId: null,
    });
    assert.equal(result.activation.state, state);
    assert.equal(result.activation.target, null);
    assert.equal(f.state.preparations.length, 0);
    assert.equal(f.state.resolves, 0);
    assert.equal(f.state.evaluations, 0);
    assert.equal(f.state.activationWrites.length, 1);
  }
});

test("legacy catalogs retain their original configuration and activation authorization counts", async () => {
  const f = fixture({ legacy: true, ready: true });
  assert.equal(Object.hasOwn(f.dependencies.catalog, "prepare"), false);
  await f.service.saveConfiguration(actor, saveCommand);
  assert.deepEqual(
    f.state.permissions.map(({ action }) => action),
    ["extension:configure"],
  );
  f.state.permissions.length = 0;
  const activated = await f.service.setActivation(actor, enableCommand);
  assert.deepEqual(activated.activation.target, target);
  assert.deepEqual(
    f.state.permissions.map(({ action }) => action),
    ["extension:activate"],
  );
  assert.equal(f.state.preparations.length, 0);
});

test("catalog and runtime reads prepare the precise actor and saved version without manufacturing readiness", async () => {
  const f = fixture({ configured: true });
  const catalog = await f.read.getCatalog(actor);
  assert.equal(catalog.extensions[0]?.pluginVersion, manifest.version);
  assert.deepEqual(f.state.preparations, [
    { actor, request: { kind: "catalog" } },
  ]);
  f.state.preparations.length = 0;
  f.state.events.length = 0;
  const runtime = await f.read.getRuntime(actor, {
    pluginId: manifest.pluginId,
    agentVersionId: target.agentVersionId,
    configurationRevision: 1,
  });
  assert.deepEqual(f.state.preparations, [
    {
      actor,
      request: {
        kind: "registration",
        pluginId: manifest.pluginId,
        pluginVersion: manifest.version,
      },
    },
  ]);
  assert.ok(
    f.state.events.indexOf("configuration:load") <
      f.state.events.indexOf("metadata:prepare"),
  );
  assert.deepEqual(runtime.readiness, {
    outcome: "unavailable",
    reasonCode: "extension_runtime_unavailable",
  });
  assert.equal(f.state.configurationWrites.length, 0);
  assert.equal(f.state.activationWrites.length, 0);
});

test("legacy catalog and runtime reads keep existing permission calls and skip preparation", async () => {
  const f = fixture({ legacy: true, configured: true });
  await f.read.getCatalog(actor);
  assert.deepEqual(
    f.state.permissions.map(({ action }) => action),
    ["extension:read", "extension:read"],
  );
  f.state.permissions.length = 0;
  await f.read.getRuntime(actor, {
    pluginId: manifest.pluginId,
    agentVersionId: target.agentVersionId,
    configurationRevision: 1,
  });
  assert.deepEqual(
    f.state.permissions.map(({ action }) => action),
    [
      "extension:read",
      "agentVersion:read",
      "extension:read",
      "agentVersion:read",
    ],
  );
  assert.equal(f.state.preparations.length, 0);
});
