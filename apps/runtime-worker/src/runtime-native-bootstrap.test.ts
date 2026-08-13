import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";

import {
  installRuntimeNativeBootstrap,
  takeRuntimeNativeBootstrap,
} from "./runtime-native-bootstrap.ts";

test("accepts one exact in-memory native bootstrap and clears it on take", () => {
  installRuntimeNativeBootstrap({
    schemaVersion: "crewon.worker-native-bootstrap.v1",
    provider: {
      credentialKind: "keychain",
      endpoint: "https://api.example.com/v1",
      environmentVariable: null,
      providerId: "gateway",
      runtimeBindingId: "desktop-supervisor:generation-1",
    },
    apiKey: "worker-only-secret",
    probe: { port: 3211, token: "worker-private-token" },
  });
  assert.deepEqual(takeRuntimeNativeBootstrap(), {
    provider: {
      credentialKind: "keychain",
      endpoint: "https://api.example.com/v1",
      environmentVariable: null,
      providerId: "gateway",
      runtimeBindingId: "desktop-supervisor:generation-1",
    },
    apiKey: "worker-only-secret",
    probe: { port: 3211, token: "worker-private-token" },
    workspace: null,
    credentialBindings: null,
  });
  assert.equal(takeRuntimeNativeBootstrap(), null);
});

test("rejects authority injection and a second unread bootstrap", () => {
  assert.throws(
    () =>
      installRuntimeNativeBootstrap({
        schemaVersion: "crewon.worker-native-bootstrap.v1",
        provider: null,
        apiKey: null,
        probe: { port: 3211, token: "worker-private-token" },
        runtimeBindingId: "renderer-authority",
      }),
    /runtime_native_bootstrap_invalid/u,
  );
  installRuntimeNativeBootstrap({
    schemaVersion: "crewon.worker-native-bootstrap.v1",
    provider: null,
    apiKey: null,
    probe: { port: 3211, token: "worker-private-token" },
  });
  assert.throws(
    () =>
      installRuntimeNativeBootstrap({
        schemaVersion: "crewon.worker-native-bootstrap.v1",
        provider: null,
        apiKey: null,
        probe: { port: 3211, token: "worker-private-token" },
      }),
    /runtime_native_bootstrap_invalid/u,
  );
  assert.deepEqual(takeRuntimeNativeBootstrap(), {
    provider: null,
    apiKey: null,
    probe: { port: 3211, token: "worker-private-token" },
    workspace: null,
    credentialBindings: null,
  });
});

test("rejects secret and binding cross-shapes", () => {
  assert.throws(
    () =>
      installRuntimeNativeBootstrap({
        schemaVersion: "crewon.worker-native-bootstrap.v1",
        provider: {
          credentialKind: "none",
          endpoint: "http://127.0.0.1:11434/v1",
          environmentVariable: null,
          providerId: "local",
          runtimeBindingId: "desktop-supervisor:generation-2",
        },
        apiKey: "must-not-be-present",
        probe: { port: 3211, token: "worker-private-token" },
      }),
    /runtime_native_bootstrap_invalid/u,
  );
});

test("preserves the exact authority endpoint after structural validation", () => {
  installRuntimeNativeBootstrap({
    schemaVersion: "crewon.worker-native-bootstrap.v1",
    provider: {
      credentialKind: "none",
      endpoint: "http://127.0.0.1:11434/v1/",
      environmentVariable: null,
      providerId: "local",
      runtimeBindingId: "desktop-supervisor:generation-3",
    },
    apiKey: null,
    probe: { port: 3211, token: "worker-private-token" },
  });
  assert.equal(
    takeRuntimeNativeBootstrap()?.provider?.endpoint,
    "http://127.0.0.1:11434/v1/",
  );
});

test("accepts one all-or-none Workspace v2 bootstrap and redacts every secret Debug view", () => {
  const value = workspaceBootstrap();
  installRuntimeNativeBootstrap(value);
  const bootstrap = takeRuntimeNativeBootstrap();
  assert.ok(
    bootstrap?.workspace !== null && bootstrap?.workspace !== undefined,
  );
  assert.deepEqual(bootstrap.workspace.authority, {
    tenantId: "tenant-1",
    spaceId: "space-1",
    workspaceBindingId: "workspace-1",
    incarnationId: "incarnation-1",
    deviceBindingId: "device-binding-1",
    deviceId: "device-1",
    runtimeBindingId: "runtime-generation-1",
    policySnapshotId: "policy-1",
  });
  for (const inspected of [
    inspect(bootstrap),
    inspect(bootstrap.workspace),
    inspect(bootstrap.workspace.privateServer),
    inspect(bootstrap.workspace.signing),
  ]) {
    assert.equal(inspected, "RuntimeNativeBootstrap([REDACTED])");
    assert.doesNotMatch(inspected, /secret|PRIVATE KEY|CERTIFICATE/u);
  }
});

test("accepts exact v3 private credential bindings and destroys them after one consumption", () => {
  const value = workspaceBootstrap() as Record<string, any>;
  value.schemaVersion = "crewon.worker-native-bootstrap.v3";
  value.credentialBindings = privateCredentialBindings();
  installRuntimeNativeBootstrap(value);
  const bootstrap = takeRuntimeNativeBootstrap();
  const credentials = bootstrap?.credentialBindings;
  assert.ok(credentials !== null && credentials !== undefined);
  assert.deepEqual(credentials.authority, {
    tenantId: "tenant-1",
    workspaceBindingId: "workspace-1",
    runtimeBindingId: "runtime-generation-1",
    agentVersionId: "agent-version-1",
  });
  let captured: readonly Readonly<Record<string, string>>[] = [];
  credentials.consume(credentials.authority, (bindings) => {
    captured = bindings.map((binding) => ({ ...binding }));
  });
  assert.deepEqual(captured, [
    { credentialBindingId: "credential-1", bearerToken: "private+/token==" },
  ]);
  assert.throws(
    () => credentials.consume(credentials.authority, () => undefined),
    /invalid/u,
  );
  assert.equal(inspect(credentials), "RuntimeNativeBootstrap([REDACTED])");
});

test("rejects credential extras, duplicate ids, empty values, and cross-binding authority", () => {
  for (const mutate of [
    (value: Record<string, any>) => (value.credentialBindings.extra = true),
    (value: Record<string, any>) =>
      value.credentialBindings.bindings.push({
        ...value.credentialBindings.bindings[0],
      }),
    (value: Record<string, any>) =>
      (value.credentialBindings.bindings[0].bearerToken = ""),
    (value: Record<string, any>) =>
      (value.credentialBindings.authority.runtimeBindingId =
        "other-valid-runtime"),
  ]) {
    const value = workspaceBootstrap() as Record<string, any>;
    value.schemaVersion = "crewon.worker-native-bootstrap.v3";
    value.credentialBindings = privateCredentialBindings();
    mutate(value);
    assert.throws(
      () => installRuntimeNativeBootstrap(value),
      /runtime_native_bootstrap_invalid/u,
    );
  }
});

test("requires the complete expected authority before credential consumption", () => {
  const value = workspaceBootstrap() as Record<string, any>;
  value.schemaVersion = "crewon.worker-native-bootstrap.v3";
  value.credentialBindings = privateCredentialBindings();
  installRuntimeNativeBootstrap(value);
  const credentials = takeRuntimeNativeBootstrap()?.credentialBindings;
  assert.ok(credentials !== null && credentials !== undefined);
  assert.throws(
    () =>
      credentials.consume(
        { ...credentials.authority, agentVersionId: "other-valid-version" },
        () => undefined,
      ),
    /runtime_native_bootstrap_invalid/u,
  );
  credentials.destroy();
});

test("destroys parsed v3 credentials when later bootstrap validation fails", () => {
  for (const mutate of [
    (value: Record<string, any>) => (value.probe.port = 0),
    (value: Record<string, any>) =>
      (value.provider = {
        credentialKind: "none",
        endpoint: "file:///not-allowed",
        environmentVariable: null,
        providerId: "local",
        runtimeBindingId: "runtime-generation-1",
      }),
  ]) {
    const value = workspaceBootstrap() as Record<string, any>;
    value.schemaVersion = "crewon.worker-native-bootstrap.v3";
    value.credentialBindings = privateCredentialBindings();
    mutate(value);
    assert.throws(
      () => installRuntimeNativeBootstrap(value),
      /^Error: runtime_native_bootstrap_invalid$/u,
    );
    assert.equal(
      value.credentialBindings.bindings[0].bearerToken,
      "",
      "the parsed source must not retain a second bearer copy",
    );
    assert.equal(takeRuntimeNativeBootstrap(), null);
  }
});

test("rejects a second unread bootstrap before parsing its credentials", () => {
  installRuntimeNativeBootstrap({
    schemaVersion: "crewon.worker-native-bootstrap.v1",
    provider: null,
    apiKey: null,
    probe: { port: 3211, token: "worker-private-token" },
  });
  const rejected = workspaceBootstrap() as Record<string, any>;
  rejected.schemaVersion = "crewon.worker-native-bootstrap.v3";
  rejected.credentialBindings = privateCredentialBindings();
  assert.throws(
    () => installRuntimeNativeBootstrap(rejected),
    /^Error: runtime_native_bootstrap_invalid$/u,
  );
  assert.equal(
    rejected.credentialBindings.bindings[0].bearerToken,
    "private+/token==",
  );
  assert.ok(takeRuntimeNativeBootstrap() !== null);
});

test("rejects partial Workspace secrets, extra keys, and invalid caps", () => {
  for (const mutate of [
    (value: Record<string, any>) =>
      delete value.workspace.signing.privateKeyPem,
    (value: Record<string, any>) => (value.workspace.signing.extra = true),
    (value: Record<string, any>) => (value.workspace.privateServer.port = -1),
    (value: Record<string, any>) => (value.workspace.deadlineMs = 999),
  ]) {
    const value = workspaceBootstrap() as Record<string, any>;
    mutate(value);
    assert.throws(
      () => installRuntimeNativeBootstrap(value),
      /runtime_native_bootstrap_invalid/u,
    );
  }
});

function workspaceBootstrap() {
  const privateKey =
    "-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----";
  return {
    schemaVersion: "crewon.worker-native-bootstrap.v2",
    provider: null,
    apiKey: null,
    probe: { port: 3211, token: "worker-private-token" },
    workspace: {
      trustedLocalPath: process.cwd(),
      privateServer: {
        port: 0,
        token: "workspace-private-token-at-least-32-bytes",
      },
      authority: {
        tenantId: "tenant-1",
        spaceId: "space-1",
        workspaceBindingId: "workspace-1",
        incarnationId: "incarnation-1",
        deviceBindingId: "device-binding-1",
        deviceId: "device-1",
        runtimeBindingId: "runtime-generation-1",
        policySnapshotId: "policy-1",
      },
      signing: { keyId: "workspace-key-1", privateKeyPem: privateKey },
      deadlineMs: 35_000,
    },
  };
}

function privateCredentialBindings() {
  return {
    schemaVersion: "crewon.remote-mcp-private-credentials.v1",
    authority: {
      tenantId: "tenant-1",
      workspaceBindingId: "workspace-1",
      runtimeBindingId: "runtime-generation-1",
      agentVersionId: "agent-version-1",
    },
    bindings: [
      { credentialBindingId: "credential-1", bearerToken: "private+/token==" },
    ],
  };
}
