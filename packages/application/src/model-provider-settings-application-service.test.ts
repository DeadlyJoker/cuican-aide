import assert from "node:assert/strict";
import test from "node:test";

import { ApplicationError } from "./application-error.ts";
import type { AuthorizationPort } from "./authorization-port.ts";
import { ModelProviderSettingsApplicationService } from "./model-provider-settings-application-service.ts";
import type {
  AbortModelProviderSettingsInput,
  ExpireModelProviderSettingsInput,
  FinalizeModelProviderSettingsInput,
  ModelProviderSettingsCatalog,
  ModelProviderSettingsState,
  ModelProviderSettingsStore,
  PendingModelProviderSettings,
  PrepareModelProviderSettingsInput,
} from "./model-provider-settings-store-port.ts";
import { RunStoreError } from "./run-store-port.ts";

const actor = {
  principalId: "principal-1",
  actorId: "actor-1",
  tenantId: "tenant-1",
  spaceId: "space-1",
} as const;
const coordination = {
  operationId: "operation-1",
  coordinatorBinding: "desktop-supervisor:generation-7",
  ttlMs: 300_000,
} as const;

test("authorizes two-phase Provider settings without exposing a secret", async () => {
  const store = new FakeStore();
  const requests: Parameters<AuthorizationPort["authorize"]>[0][] = [];
  const service = createService(store, {
    authorize: async (request) => {
      requests.push(structuredClone(request));
      return { outcome: "allow" };
    },
  });

  assert.deepEqual(await service.get(actor), {
    catalog: emptyCatalog(),
    pending: null,
  });
  const prepared = await service.prepare(
    actor,
    {
      expectedRevision: 0,
      activeProviderId: "gateway",
      bindings: [binding()],
    },
    coordination,
    "prepare-key",
  );
  assert.deepEqual(prepared.pending, {
    tenantId: "tenant-1",
    operationId: "operation-1",
    coordinatorBinding: "desktop-supervisor:generation-7",
    baseRevision: 0,
    activeProviderId: "gateway",
    runtimeBindingId: "desktop-supervisor:generation-7",
    bindings: [binding()],
    preparedAt: "2026-08-09T01:00:00.000Z",
    expiresAt: "2026-08-09T01:05:00.000Z",
  });
  assert.deepEqual(
    requests.map(({ action, resource }) => ({ action, resource })),
    ["read", "write"].map((action) => ({
      action: `modelProviderSettings:${action}`,
      resource: {
        kind: "modelProviderSettings",
        tenantId: "tenant-1",
        spaceId: "space-1",
      },
    })),
  );
  assert.equal(store.prepareInput?.idempotencyKey, "prepare-key");
  assert.equal(store.prepareInput?.fingerprint, `sha256:${"a".repeat(64)}`);
  assert.equal(JSON.stringify(store.prepareInput).includes("secret"), false);
});

test("probe fails closed while a Provider switch is pending", async () => {
  const store = new FakeStore();
  store.state = {
    catalog: committedCatalog(),
    pending: pending(),
  };
  const service = createService(store, allowAll);

  await assert.rejects(
    service.authorizeProbe(actor),
    applicationError("conflict", "model_provider_settings_switch_pending"),
  );
});

test("rejects secret injection, unsafe endpoints, and arbitrary coordination", async () => {
  const store = new FakeStore();
  const service = createService(store, allowAll);
  for (const invalid of [
    { ...binding(), endpoint: "http://provider.example/v1" },
    { ...binding(), environmentVariable: "SECRET_TOKEN" },
    { ...binding(), environmentVariable: "x".repeat(129) },
    { ...binding(), environmentVariable: "SECRET\nTOKEN" },
    { ...binding(), apiKey: "secret" },
    { ...binding(), token: "secret" },
    { ...binding(), tenantId: "tenant-2" },
    { ...binding(), metadata: { secret: "secret" } },
  ]) {
    await assert.rejects(
      service.prepare(
        actor,
        {
          expectedRevision: 0,
          activeProviderId: "gateway",
          bindings: [invalid],
        },
        coordination,
        "prepare-invalid",
      ),
      applicationError("validation", "model_provider_settings_invalid"),
    );
  }
  await assert.rejects(
    service.prepare(
      actor,
      {
        expectedRevision: 0,
        activeProviderId: "gateway",
        bindings: [binding()],
      },
      { ...coordination, browserAuthority: "secret" } as never,
      "prepare-injected",
    ),
    applicationError("validation", "model_provider_settings_invalid"),
  );
  assert.equal(store.prepareInput, null);
});

test("maps denied authorization and pending Store conflicts", async () => {
  const denied = createService(new FakeStore(), {
    authorize: async () => ({ outcome: "deny", reasonCode: "policy" }),
  });
  await assert.rejects(
    denied.get(actor),
    applicationError("authorization", "authorization_denied"),
  );

  const store = new FakeStore();
  store.error = new RunStoreError("model_provider_settings_pending");
  await assert.rejects(
    createService(store, allowAll).prepare(
      actor,
      {
        expectedRevision: 0,
        activeProviderId: "gateway",
        bindings: [binding()],
      },
      coordination,
      "prepare-conflict",
    ),
    applicationError("conflict", "model_provider_settings_pending"),
  );
});

test("maps stored authority corruption and unknown Store failures to internal", async () => {
  for (const code of [
    "model_provider_settings_stored_state_invalid",
    "model_provider_settings_future_failure",
  ]) {
    const store = new FakeStore();
    store.error = new RunStoreError(code);
    await assert.rejects(
      createService(store, allowAll).prepare(
        actor,
        {
          expectedRevision: 0,
          activeProviderId: "gateway",
          bindings: [binding()],
        },
        coordination,
        `prepare-${code}`,
      ),
      applicationError("internal", code),
    );
  }
});

test("maps query and probe authority corruption to internal", async () => {
  const store = new FakeStore();
  store.loadError = new RunStoreError(
    "model_provider_settings_stored_state_invalid",
  );
  const service = createService(store, allowAll);
  await assert.rejects(
    service.get(actor),
    applicationError(
      "internal",
      "model_provider_settings_stored_state_invalid",
    ),
  );
  await assert.rejects(
    service.authorizeProbe(actor),
    applicationError(
      "internal",
      "model_provider_settings_stored_state_invalid",
    ),
  );
});

test("scopes idempotency fingerprints to the server-derived actor audit", async () => {
  const store = new FakeStore();
  const service = createService(store, allowAll);
  const command = {
    expectedRevision: 0,
    activeProviderId: "gateway",
    bindings: [binding()],
  } as const;
  await service.prepare(actor, command, coordination, "shared-key");
  await assert.rejects(
    service.prepare(
      { ...actor, principalId: "principal-2", actorId: "actor-2" },
      command,
      coordination,
      "shared-key",
    ),
    applicationError(
      "conflict",
      "model_provider_settings_idempotency_conflict",
    ),
  );
});

function createService(
  store: ModelProviderSettingsStore,
  authorization: AuthorizationPort,
): ModelProviderSettingsApplicationService {
  return new ModelProviderSettingsApplicationService({
    store,
    authorization,
    digester: {
      sha256: (value) =>
        `sha256:${(value.includes('"actorId":"actor-2"') ? "b" : "a").repeat(64)}`,
    },
  });
}

const allowAll: AuthorizationPort = {
  authorize: async () => ({ outcome: "allow" }),
};

class FakeStore implements ModelProviderSettingsStore {
  state: ModelProviderSettingsState = { catalog: null, pending: null };
  prepareInput: PrepareModelProviderSettingsInput | null = null;
  error: Error | null = null;
  loadError: Error | null = null;
  readonly prepareFingerprints = new Map<string, string>();

  async loadModelProviderSettingsState() {
    if (this.loadError !== null) throw this.loadError;
    return structuredClone(this.state);
  }

  async prepareModelProviderSettings(input: PrepareModelProviderSettingsInput) {
    if (this.error !== null) throw this.error;
    const prior = this.prepareFingerprints.get(input.idempotencyKey);
    if (prior !== undefined && prior !== input.fingerprint) {
      throw new RunStoreError("model_provider_settings_idempotency_conflict");
    }
    this.prepareFingerprints.set(input.idempotencyKey, input.fingerprint);
    this.prepareInput = structuredClone(input);
    const value = pending();
    this.state = { ...this.state, pending: value };
    return { disposition: "prepared" as const, pending: value };
  }

  async finalizeModelProviderSettings(
    input: FinalizeModelProviderSettingsInput,
  ) {
    void input;
    const catalog = committedCatalog();
    this.state = { catalog, pending: null };
    return { disposition: "finalized" as const, catalog };
  }

  async abortModelProviderSettings(_input: AbortModelProviderSettingsInput) {
    this.state = { ...this.state, pending: null };
    return { disposition: "aborted" as const, catalog: this.state.catalog };
  }

  async expireModelProviderSettings(_input: ExpireModelProviderSettingsInput) {
    this.state = { ...this.state, pending: null };
    return { disposition: "expired" as const, catalog: this.state.catalog };
  }
}

function binding() {
  return {
    providerId: "gateway",
    displayName: "Gateway",
    endpoint: "https://provider.example/v1",
    credentialKind: "keychain" as const,
    environmentVariable: null,
  };
}

function pending(): PendingModelProviderSettings {
  return {
    tenantId: "tenant-1",
    operationId: "operation-1",
    coordinatorBinding: "desktop-supervisor:generation-7",
    baseRevision: 0,
    activeProviderId: "gateway",
    runtimeBindingId: "desktop-supervisor:generation-7",
    bindings: [binding()],
    preparedAt: "2026-08-09T01:00:00.000Z",
    expiresAt: "2026-08-09T01:05:00.000Z",
  };
}

function emptyCatalog(): ModelProviderSettingsCatalog {
  return {
    tenantId: "tenant-1",
    revision: 0,
    activeProviderId: null,
    runtimeBindingId: null,
    bindings: [],
    updatedAt: null,
  };
}

function committedCatalog(
  updatedAt = "2026-08-09T01:01:00.000Z",
): ModelProviderSettingsCatalog {
  return {
    tenantId: "tenant-1",
    revision: 1,
    activeProviderId: "gateway",
    runtimeBindingId: "desktop-supervisor:generation-7",
    bindings: [binding()],
    updatedAt,
  };
}

function applicationError(
  category: ApplicationError["category"],
  code: string,
) {
  return (error: unknown) =>
    error instanceof ApplicationError &&
    error.category === category &&
    error.code === code;
}
