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
    inspect(bootstrap.workspace.gateway),
    inspect(bootstrap.workspace.gateway.tls),
  ]) {
    assert.equal(inspected, "RuntimeNativeBootstrap([REDACTED])");
    assert.doesNotMatch(inspected, /secret|PRIVATE KEY|CERTIFICATE/u);
  }
});

test("rejects partial Workspace secrets, extra keys, unsafe endpoint, and invalid caps", () => {
  for (const mutate of [
    (value: Record<string, any>) => delete value.workspace.gateway.tls.keyPem,
    (value: Record<string, any>) => (value.workspace.signing.extra = true),
    (value: Record<string, any>) =>
      (value.workspace.gateway.endpoint = "https://gateway.example/device/v1"),
    (value: Record<string, any>) => (value.workspace.privateServer.port = -1),
    (value: Record<string, any>) => (value.workspace.gateway.deadlineMs = 999),
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
  const certificate =
    "-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----";
  return {
    schemaVersion: "crewon.worker-native-bootstrap.v2",
    provider: null,
    apiKey: null,
    probe: { port: 3211, token: "worker-private-token" },
    workspace: {
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
      gateway: {
        endpoint: "https://gateway.example/",
        deadlineMs: 35_000,
        tls: {
          keyPem: privateKey,
          certificatePem: certificate,
          caCertificatePem: certificate,
          servername: "gateway.example",
        },
      },
    },
  };
}
