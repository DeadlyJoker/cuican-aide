import assert from "node:assert/strict";
import test from "node:test";

import {
  parseExtensionRecoveryReleaseRequest,
  prepareExtensionRecoveryRelease,
  type ExtensionRecoveryReleaseRequest,
} from "./extension-recovery-release.ts";
import type { RuntimeEnvironment } from "./runtime-environment-values.ts";

const provider = Object.freeze({
  providerId: "openai",
  endpoint: "https://api.openai.com/v1",
  responsesEndpoint: "https://api.openai.com/v1/responses",
  credentialRequired: true,
});
const base = Object.freeze({
  CREWON_EXTENSION_RECOVERY_ATTEMPT_ID: "a".repeat(64),
  CREWON_EXTENSION_RECOVERY_PROVIDER_JSON: JSON.stringify(provider),
  CREWON_EXTENSION_BUILD_ARCHIVE_DATA_ROOT: "/native/data",
  CREWON_EXTENSIONS_ENABLED: "1",
  CREWON_CONTROL_SECURITY_MODE: "standalone",
  CREWON_PRINCIPAL_ID: "principal-1",
  CREWON_ACTOR_ID: "actor-1",
  CREWON_TENANT_ID: "tenant-1",
  CREWON_SPACE_ID: "space-1",
  CREWON_CONTROL_DB_PATH: "/native/data/control.sqlite",
  CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH: "/native/data/base.json",
  CREWON_EXTENSION_RUNTIME_BINDINGS_PATH: "/operator/plugins.json",
  CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH: "/operator/assets.json",
  CREWON_MODEL_ID: "model-old",
  CREWON_RESPONSES_ENDPOINT: "https://api.openai.com/v1/responses",
});

function request(
  overrides: RuntimeEnvironment = {},
): ExtensionRecoveryReleaseRequest {
  const value = parseExtensionRecoveryReleaseRequest({ ...base, ...overrides });
  assert.notEqual(value, null);
  if (value === null) throw new Error("fixture_request_missing");
  return value;
}

function withProvider(value: unknown): RuntimeEnvironment {
  return { CREWON_EXTENSION_RECOVERY_PROVIDER_JSON: JSON.stringify(value) };
}

test("absent Native opt-in returns null without accessing other configuration or secrets", () => {
  const read: string[] = [];
  const environment = new Proxy<Record<string, string | undefined>>(
    {},
    {
      get(_target, name) {
        assert.equal(typeof name, "string");
        read.push(String(name));
        if (
          name === "CREWON_EXTENSION_RECOVERY_ATTEMPT_ID" ||
          name === "CREWON_EXTENSION_RECOVERY_PROVIDER_JSON"
        )
          return undefined;
        throw new Error("unexpected_environment_read");
      },
    },
  );
  assert.equal(parseExtensionRecoveryReleaseRequest(environment), null);
  assert.deepEqual(read, [
    "CREWON_EXTENSION_RECOVERY_ATTEMPT_ID",
    "CREWON_EXTENSION_RECOVERY_PROVIDER_JSON",
  ]);
});

test("preparing an absent request does not read release inputs or open storage", async () => {
  const input = new Proxy(
    { request: null },
    {
      get(_target, name) {
        if (name === "request") return null;
        throw new Error("unexpected_preparation_read");
      },
    },
  ) as Parameters<typeof prepareExtensionRecoveryRelease>[0];
  assert.equal(await prepareExtensionRecoveryRelease(input), null);
});

test("requires a paired attempt and provider and an exact lowercase SHA-256 attempt", () => {
  for (const overrides of [
    { CREWON_EXTENSION_RECOVERY_ATTEMPT_ID: undefined },
    { CREWON_EXTENSION_RECOVERY_PROVIDER_JSON: undefined },
    ...[
      "",
      "a".repeat(63),
      "a".repeat(65),
      "A".repeat(64),
      "g".repeat(64),
      ` ${"a".repeat(64)}`,
      `sha256:${"a".repeat(64)}`,
    ].map((value) => ({
      CREWON_EXTENSION_RECOVERY_ATTEMPT_ID: value,
    })),
    { CREWON_EXTENSION_RECOVERY_PROVIDER_JSON: "{" },
    { CREWON_EXTENSION_RECOVERY_PROVIDER_JSON: " ".repeat(8193) },
  ]) {
    assert.throws(
      () => request(overrides),
      /extension_recovery_request_invalid/u,
    );
  }
});

test("recovery opt-in requires enabled plugins and standalone authority", () => {
  for (const enabled of [undefined, "0", "", "true", " 1"])
    assert.throws(
      () => request({ CREWON_EXTENSIONS_ENABLED: enabled }),
      /extension_recovery_request_invalid/u,
    );
  for (const security of ["production", "shared", "", " standalone"])
    assert.throws(
      () => request({ CREWON_CONTROL_SECURITY_MODE: security }),
      /extension_recovery_request_invalid/u,
    );
  assert.equal(
    request({ CREWON_CONTROL_SECURITY_MODE: undefined }).owner.tenantId,
    "tenant-1",
  );
});

test("provider binding requires exactly four typed public fields", () => {
  for (const value of [
    null,
    [],
    "openai",
    { ...provider, extra: "unexpected" },
    { ...provider, apiKey: "forbidden" },
    { ...provider, providerId: "UpperCase" },
    { ...provider, providerId: "" },
    { ...provider, credentialRequired: "true" },
    ...Object.keys(provider).map((missing) =>
      Object.fromEntries(
        Object.entries(provider).filter(([key]) => key !== missing),
      ),
    ),
  ])
    assert.throws(() => request(withProvider(value)));
  assert.deepEqual(request().providerBinding, provider);
});

test("provider URLs are canonicalized and Responses URL must be the provider's canonical child", () => {
  const value = request(
    withProvider({
      ...provider,
      endpoint: "https://API.OPENAI.COM:443/v1/",
    }),
  );
  assert.equal(value.providerBinding.endpoint, "https://api.openai.com/v1/");
  assert.equal(
    value.providerBinding.responsesEndpoint,
    "https://api.openai.com/v1/responses",
  );
  for (const responsesEndpoint of [
    "https://api.other.example/v1/responses",
    "https://api.openai.com/responses",
    "https://api.openai.com/v1/responses/",
  ])
    assert.throws(() =>
      request(withProvider({ ...provider, responsesEndpoint })),
    );
  for (const responsesEndpoint of [
    "https://API.OPENAI.COM/v1/responses",
    "https://api.openai.com:443/v1/responses",
  ])
    assert.deepEqual(
      request(withProvider({ ...provider, responsesEndpoint })).providerBinding,
      provider,
    );
});

test("provider URLs reject credentials, query, fragment, and insecure public origins", () => {
  for (const endpoint of [
    "https://user:password@api.openai.com/v1",
    "https://api.openai.com/v1?token=forbidden",
    "https://api.openai.com/v1#fragment",
    "http://public.example/v1",
    "file:///v1",
    " https://api.openai.com/v1",
    "https://api.openai.com/\u200bv1",
  ]) {
    assert.throws(() => request(withProvider({ ...provider, endpoint })));
  }
  for (const responsesEndpoint of [
    "https://user:password@api.openai.com/v1/responses",
    "https://api.openai.com/v1/responses?token=forbidden",
    "https://api.openai.com/v1/responses#fragment",
  ])
    assert.throws(() =>
      request(withProvider({ ...provider, responsesEndpoint })),
    );
  assert.deepEqual(
    request(
      withProvider({
        providerId: "local-model",
        endpoint: "http://127.0.0.1:8123/v1/",
        responsesEndpoint: "http://127.0.0.1:8123/v1/responses",
        credentialRequired: false,
      }),
    ).providerBinding,
    {
      providerId: "local-model",
      endpoint: "http://127.0.0.1:8123/v1/",
      responsesEndpoint: "http://127.0.0.1:8123/v1/responses",
      credentialRequired: false,
    },
  );
});

test("requires all four explicit owner values without deriving a principal from actor", () => {
  const fields = [
    "CREWON_PRINCIPAL_ID",
    "CREWON_ACTOR_ID",
    "CREWON_TENANT_ID",
    "CREWON_SPACE_ID",
  ] as const;
  for (const field of fields)
    for (const value of [undefined, "", " ", "owner\n", "x".repeat(513)])
      assert.throws(() => request({ [field]: value }));
  assert.deepEqual(request().owner, {
    principalId: "principal-1",
    actorId: "actor-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
  });
});

test("recovery paths are absolute, bounded, and free of whitespace and control characters", () => {
  const fields = [
    "CREWON_EXTENSION_BUILD_ARCHIVE_DATA_ROOT",
    "CREWON_CONTROL_DB_PATH",
    "CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH",
    "CREWON_EXTENSION_RUNTIME_BINDINGS_PATH",
    "CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH",
  ] as const;
  for (const field of fields)
    for (const value of [
      "",
      "relative/file.json",
      " /native/file.json",
      "/native/file.json ",
      "/native/file\n.json",
      "/native/\u200bfile.json",
      "/native/\u2028file.json",
      `/${"图".repeat(1366)}`,
    ])
      assert.throws(
        () => request({ [field]: value }),
        /extension_recovery_request_invalid/u,
      );
  assert.throws(
    () => request({ CREWON_EXTENSION_BUILD_ARCHIVE_DATA_ROOT: undefined }),
    /extension_recovery_request_invalid/u,
  );
  assert.equal(
    request({ CREWON_EXTENSION_BUILD_ARCHIVE_DATA_ROOT: "/本机/恢复目录" })
      .dataRoot,
    "/本机/恢复目录",
  );
});

test("plugin paths are paired while absent DB or base paths remain explicit null", () => {
  for (const field of [
    "CREWON_EXTENSION_RUNTIME_BINDINGS_PATH",
    "CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH",
  ])
    assert.throws(
      () => request({ [field]: undefined }),
      /extension_recovery_request_invalid/u,
    );
  const value = request({
    CREWON_CONTROL_DB_PATH: undefined,
    CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH: undefined,
    CREWON_EXTENSION_RUNTIME_BINDINGS_PATH: undefined,
    CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH: undefined,
  });
  assert.equal(value.databasePath, null);
  assert.equal(value.baseBindingsPath, null);
  assert.equal(value.runtimeBindingsPath, null);
  assert.equal(value.agentVersionAssetsPath, null);
});

test("Postgres is captured for the later eligibility gate without retaining its credentials", () => {
  const postgres =
    "postgres://private-user:private-password@localhost/database";
  const value = request({ CREWON_CONTROL_DATABASE_URL: postgres });
  assert.equal(value.postgres, true);
  assert.equal(value.bootstrap.outcome, "eligible");
  assert.equal(JSON.stringify(value).includes(postgres), false);
  assert.equal(JSON.stringify(value).includes("private-password"), false);
  for (const url of [undefined, "", " \t"])
    assert.equal(request({ CREWON_CONTROL_DATABASE_URL: url }).postgres, false);
});

test("model credentials are captured only as an availability boolean", () => {
  const canary = "native-request-key-canary";
  const value = request({ CREWON_MODEL_API_KEY: canary });
  assert.equal(value.modelCredentialAvailable, true);
  assert.equal(JSON.stringify(value).includes(canary), false);
  for (const key of [undefined, "", " \t\n"])
    assert.equal(
      request({ CREWON_MODEL_API_KEY: key }).modelCredentialAvailable,
      false,
    );
});

test("an explicit request snapshots effective nonsecret bootstrap and paths before environment mutation", () => {
  const environment: Record<string, string | undefined> = {
    ...base,
    CREWON_AGENT_INSTRUCTIONS: "Original instructions",
    CREWON_MODEL_CATALOG_JSON: '["model-old","model-next"]',
    CREWON_DEV_AGENT_PROFILES_JSON:
      '[{"agentVersionId":"profile-old","instructions":"Profile instructions"}]',
    CREWON_RESPONSES_WEBSOCKET_ENABLED: "true",
    CREWON_RESPONSES_WEBSOCKET_CONNECT_TIMEOUT_MS: "8765",
    CREWON_RESPONSES_WEBSOCKET_MAX_RETRIES: "1",
    CREWON_MODEL_CREDENTIAL_REQUIRED: "0",
    CREWON_MODEL_API_KEY: "native-request-key-canary",
  };
  for (const name of [
    "CREWON_CONTROL_SESSION_KEY",
    "CREWON_CONTROL_CSRF_SECRET",
    "CREWON_EXTENSION_PRIVATE_HOST_KEY",
    "CREWON_ARTIFACT_SIGNING_KEY",
  ])
    Object.defineProperty(environment, name, {
      enumerable: true,
      get() {
        throw new Error("secret_must_not_be_read");
      },
    });
  const value = parseExtensionRecoveryReleaseRequest(environment);
  assert.notEqual(value, null);
  if (value === null || value.bootstrap.outcome !== "eligible")
    throw new Error("fixture_bootstrap_ineligible");
  const saved = JSON.stringify(value);
  assert.equal(value.modelCredentialAvailable, true);
  assert.equal(saved.includes(environment.CREWON_MODEL_API_KEY!), false);
  environment.CREWON_MODEL_ID = "model-changed";
  environment.CREWON_RESPONSES_ENDPOINT = "https://new.example/v1/responses";
  environment.CREWON_MODEL_CREDENTIAL_REQUIRED = "1";
  environment.CREWON_MODEL_API_KEY = "";
  environment.CREWON_AGENT_INSTRUCTIONS = "Changed instructions";
  environment.CREWON_MODEL_CATALOG_JSON = '["changed"]';
  environment.CREWON_DEV_AGENT_PROFILES_JSON = "[]";
  environment.CREWON_ACTOR_ID = "actor-changed";
  environment.CREWON_CONTROL_DB_PATH = "/changed/db.sqlite";
  environment.CREWON_EXTENSION_RUNTIME_BINDINGS_PATH = "/changed/plugins.json";
  environment.CREWON_EXTENSION_RECOVERY_PROVIDER_JSON = "{}";
  assert.equal(JSON.stringify(value), saved);
  assert.equal(value.modelCredentialAvailable, true);
  assert.equal(value.bootstrap.inputs.model.modelId, "model-old");
  assert.equal(value.bootstrap.inputs.model.credentialRequired, false);
  assert.equal(
    value.bootstrap.inputs.agent.instructions,
    "Original instructions",
  );
  assert.deepEqual(value.bootstrap.inputs.modelCatalog, [
    "model-old",
    "model-next",
  ]);
  assert.deepEqual(value.bootstrap.inputs.profiles, [
    { agentVersionId: "profile-old", instructions: "Profile instructions" },
  ]);
  for (const item of [
    value,
    value.owner,
    value.providerBinding,
    value.bootstrap,
    value.bootstrap.inputs,
    value.bootstrap.inputs.model,
    value.bootstrap.inputs.model.websocket,
    value.bootstrap.inputs.agent,
    value.bootstrap.inputs.route,
    value.bootstrap.inputs.modelCatalog,
    value.bootstrap.inputs.profiles,
    value.bootstrap.inputs.profiles[0],
    value.bootstrap.inputs.tooling,
  ])
    assert.equal(Object.isFrozen(item), true);
  assert.equal(Reflect.set(value.owner, "actorId", "spoofed"), false);
  assert.equal(
    Reflect.set(value.bootstrap.inputs.model, "modelId", "changed"),
    false,
  );
});

test("unsupported optional tooling is an eligibility result rather than a request parse failure", () => {
  assert.deepEqual(
    request({ CREWON_MCP_STDIO_CONFIG_PATH: "/workspace/original-mcp.json" })
      .bootstrap,
    {
      outcome: "unsupported",
      reasonCode: "runtime_bootstrap_tooling_unsupported",
    },
  );
  assert.deepEqual(
    request({ CREWON_DESKTOP_WORKSPACE_ROOT: "/workspace/original" }).bootstrap,
    {
      outcome: "unsupported",
      reasonCode: "runtime_bootstrap_workspace_unsupported",
    },
  );
});
