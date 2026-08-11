import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";

import type { CrewonRemoteMcpBearerSink } from "@crewon/mcp-runtime";

import type {
  RemoteMcpBindingIdentity,
  RemoteMcpCompositionDependencies,
} from "./remote-mcp-composition.ts";
import type {
  RuntimeNativeCredentialBinding,
  RuntimeNativeCredentialBindingAuthority,
  RuntimeNativeCredentialBindings,
} from "./runtime-native-bootstrap.ts";
import { createRuntimeNativeRemoteMcpOwner } from "./runtime-native-remote-mcp.ts";

test("production execute and reconcile acquire isolated leases that release their copies", async () => {
  const fixture = credentials([{ credentialBindingId: "credential-1", bearerToken: "secret-1" }]);
  const owner = createRuntimeNativeRemoteMcpOwner({
    credentials: fixture.owner,
    expectedAuthority: authority(),
    manifestBindings: [identity()],
  });
  const dependencies = production(owner.dependencies);
  const port = dependencies.credentialLeaseFactory(identity());
  const observed: string[] = [];
  const sink: CrewonRemoteMcpBearerSink = { applyBearer: (token) => observed.push(token) };
  const execute = await port.acquire(acquire("execute"));
  await execute.apply(sink);
  await execute.release();
  assert.throws(() => execute.apply(sink), /runtime_native_remote_mcp_invalid/u);
  const reconcile = await port.acquire(acquire("reconcile"));
  await reconcile.apply(sink);
  await reconcile.release();

  assert.deepEqual(observed, ["secret-1", "secret-1"]);
  assert.equal(fixture.consumeCount, 1);
  owner.destroy();
  await assert.rejects(Promise.resolve().then(() => port.acquire(acquire("cancel"))), /runtime_native_remote_mcp_invalid/u);
});

test("aborted acquisition and owner destruction fail closed without inspecting secrets", async () => {
  const fixture = credentials([{ credentialBindingId: "credential-1", bearerToken: "secret-sentinel" }]);
  const owner = createRuntimeNativeRemoteMcpOwner({
    credentials: fixture.owner,
    expectedAuthority: authority(),
    manifestBindings: [identity()],
  });
  assert.equal(inspect(owner), "RuntimeNativeRemoteMcpOwner([REDACTED])");
  const controller = new AbortController();
  controller.abort();
  const port = production(owner.dependencies).credentialLeaseFactory(identity());
  await assert.rejects(Promise.resolve().then(() => port.acquire(acquire("execute", controller.signal))), /runtime_native_remote_mcp_invalid/u);
  owner.destroy();
  owner.destroy();
  await assert.rejects(Promise.resolve().then(() => port.acquire(acquire("execute"))), /runtime_native_remote_mcp_invalid/u);
});

test("rejects authority mismatch and missing or extra manifest credentials", () => {
  for (const input of [
    {
      credentials: credentials([{ credentialBindingId: "credential-1", bearerToken: "secret" }], {
        ...authority(), tenantId: "other-tenant",
      }).owner,
      manifestBindings: [identity()],
    },
    {
      credentials: credentials([{ credentialBindingId: "missing", bearerToken: "secret" }]).owner,
      manifestBindings: [identity()],
    },
    {
      credentials: credentials([
        { credentialBindingId: "credential-1", bearerToken: "secret" },
        { credentialBindingId: "extra", bearerToken: "extra-secret" },
      ]).owner,
      manifestBindings: [identity()],
    },
  ]) {
    assert.throws(
      () => createRuntimeNativeRemoteMcpOwner({ ...input, expectedAuthority: authority() }),
      /runtime_native_remote_mcp_invalid/u,
    );
  }
});

test("two production servers may share one selected credential while history stays unprivileged", async () => {
  const second = {
    ...identity(),
    serverBindingId: "server-2",
    endpoint: "https://second.example/mutations",
  };
  const historical = {
    ...identity(),
    agentVersionId: "historical-version",
    credentialBindingId: "historical-credential",
  };
  const fixture = credentials([
    { credentialBindingId: "credential-1", bearerToken: "shared-secret" },
  ]);
  const owner = createRuntimeNativeRemoteMcpOwner({
    credentials: fixture.owner,
    expectedAuthority: authority(),
    manifestBindings: [identity(), second, historical],
  });
  const dependencies = production(owner.dependencies);
  const observed: string[] = [];
  for (const boundIdentity of [identity(), second]) {
    const lease = await dependencies
      .credentialLeaseFactory(boundIdentity)
      .acquire(acquire("execute"));
    await lease.apply({ applyBearer: (token) => observed.push(token) });
    await lease.release();
  }
  assert.deepEqual(observed, ["shared-secret", "shared-secret"]);
  assert.throws(
    () => dependencies.credentialLeaseFactory(historical),
    /runtime_native_remote_mcp_invalid/u,
  );
  owner.destroy();
});

test("rejects cross tenant, version, runtime shape, endpoint, and server policy drift", async () => {
  for (const manifest of [
    { ...identity(), tenantId: "other-tenant" },
    { ...identity(), agentVersionId: "other-version" },
    { ...identity(), mode: "standaloneLoopback" as const },
  ]) {
    assert.throws(
      () => createRuntimeNativeRemoteMcpOwner({
        credentials: credentials([{ credentialBindingId: "credential-1", bearerToken: "secret" }]).owner,
        expectedAuthority: authority(),
        manifestBindings: [manifest],
      }),
      /runtime_native_remote_mcp_invalid/u,
    );
  }

  const owner = createRuntimeNativeRemoteMcpOwner({
    credentials: credentials([{ credentialBindingId: "credential-1", bearerToken: "secret" }]).owner,
    expectedAuthority: authority(),
    manifestBindings: [identity()],
  });
  const policy = production(owner.dependencies).tenantEgressFactory(identity()).policy;
  for (const changed of [
    { tenantId: "other-tenant" },
    { scopeId: "other-server" },
    { endpoint: new URL("https://other.example/mutations") },
  ]) {
    await assert.rejects(
      Promise.resolve().then(() => policy.authorize({
        tenantId: "tenant-1",
        scopeId: "server-1",
        endpoint: new URL(identity().endpoint),
        addresses: [{ address: "8.8.8.8", family: 4 }],
        ...changed,
      })),
      /remote_mcp_network_binding_mismatch/u,
    );
  }
  assert.deepEqual(await policy.authorize({
    tenantId: "tenant-1",
    scopeId: "server-1",
    endpoint: new URL(identity().endpoint),
    addresses: [{ address: "127.0.0.1", family: 4 }],
  }), { approvedAddresses: ["127.0.0.1"] });
  owner.destroy();
});

function credentials(
  bindings: readonly RuntimeNativeCredentialBinding[],
  actualAuthority: RuntimeNativeCredentialBindingAuthority = authority(),
) {
  let consumeCount = 0;
  let available = true;
  return {
    get consumeCount() { return consumeCount; },
    owner: {
      authority: actualAuthority,
      consume(expected, consumer) {
        if (!available || JSON.stringify(expected) !== JSON.stringify(actualAuthority)) {
          throw new Error("runtime_native_bootstrap_invalid");
        }
        available = false;
        consumeCount += 1;
        consumer(bindings);
      },
      destroy() { available = false; },
    } satisfies RuntimeNativeCredentialBindings,
  };
}

function authority(): RuntimeNativeCredentialBindingAuthority {
  return {
    tenantId: "tenant-1",
    workspaceBindingId: "workspace-1",
    runtimeBindingId: "runtime-1",
    agentVersionId: "agent-version-1",
  };
}

function identity(): RemoteMcpBindingIdentity {
  return {
    mode: "production",
    tenantId: "tenant-1",
    agentVersionId: "agent-version-1",
    contentDigest: `sha256:${"a".repeat(64)}`,
    materializationDigest: `sha256:${"b".repeat(64)}`,
    serverBindingId: "server-1",
    credentialBindingId: "credential-1",
    endpoint: "https://mcp.example/mutations",
  };
}

function acquire(phase: "execute" | "reconcile" | "cancel", signal = new AbortController().signal) {
  return { phase, providerExecutionId: "execution-1", toolName: "tool-1", signal };
}

function production(dependencies: RemoteMcpCompositionDependencies) {
  assert.equal(dependencies.mode, "production");
  return dependencies as Extract<typeof dependencies, { mode: "production" }>;
}
