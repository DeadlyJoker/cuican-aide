import assert from "node:assert/strict";
import test from "node:test";
import {
  createExtensionConfiguration,
  type WorkflowSchemaValue,
} from "@crewon/domain";
import {
  extensionHostFixture,
  hostActor,
  hostDigester,
  hostSignal,
} from "./extension-host.test-support.ts";
import {
  RuntimeExtensionHostError,
  RuntimeExtensionHostService,
} from "./extensions/extension-host-service.ts";

test("host readiness actually constructs and leases the persisted exact kernel and bundled tools", async (t) => {
  const f = await extensionHostFixture(t);
  assert.equal(f.controls.toolsConstructed, 0);
  const response = await f.service.handle(f.request, hostSignal());
  assert.equal(response.operation, "readiness");
  if (response.operation !== "readiness") throw new Error("wrong operation");
  assert.deepEqual(response.result, { outcome: "ready", target: f.target });
  assert.equal(f.controls.toolsConstructed, 1);
  assert.equal(f.controls.acquired, 1);
  assert.equal(f.controls.released, 1);
  await f.service.handle(f.request, hostSignal());
  assert.equal(f.controls.toolsConstructed, 1, "reuse the real resident owner");
  assert.equal(f.controls.released, 2);
});

test("catalog and semantic configuration validation perform no runtime, model, DNS or provider work", async (t) => {
  const f = await extensionHostFixture(t);
  const catalog = await f.service.handle(
    { protocol: f.request.protocol, operation: "catalog", actor: hostActor },
    hostSignal(),
  );
  assert.equal(catalog.operation, "catalog");
  if (catalog.operation !== "catalog") throw new Error("wrong operation");
  assert.deepEqual(catalog.registrations, [f.registration]);
  const { agentVersionId: _, ...request } = f.request;
  const configured = await f.service.handle(
    { ...request, operation: "validateConfiguration" },
    hostSignal(),
  );
  assert.equal(configured.operation, "validateConfiguration");
  assert.equal(f.controls.toolsConstructed, 0);
  assert.equal(f.controls.acquired, 0);
  const invalidParameters: Record<string, WorkflowSchemaValue>[] = [
    { baseUrl: "http://comfy.example/" },
    { baseUrl: "https://comfy.example/", apiKey: "forged" },
  ];
  for (const parameters of invalidParameters) {
    const configuration = createExtensionConfiguration(
      { ...f.configuration, parameters },
      hostDigester,
    );
    await assert.rejects(
      f.service.handle(
        { ...request, configuration, operation: "validateConfiguration" },
        hostSignal(),
      ),
    );
  }
});

test("published deployment metadata and a matching catalog cannot substitute for an installed tool owner", async (t) => {
  const f = await extensionHostFixture(t);
  f.controls.omitProof = true;
  const result = await f.service.handle(f.request, hostSignal());
  assert.equal(result.operation, "readiness");
  if (result.operation !== "readiness") throw new Error("wrong operation");
  assert.deepEqual(result.result, {
    outcome: "unavailable",
    reasonCode: "extension_implementation_unavailable",
  });
  assert.equal(f.controls.released, 1);
});

test("current full identity and policy are checked before I/O and again after actual assembly", async (t) => {
  const f = await extensionHostFixture(t);
  for (const patch of [
    { principalId: "other" },
    { actorId: "other" },
    { tenantId: "other" },
    { spaceId: "other" },
  ]) {
    await assert.rejects(
      f.service.handle(
        { ...f.request, actor: { ...hostActor, ...patch } },
        hostSignal(),
      ),
      (error: unknown) =>
        error instanceof RuntimeExtensionHostError &&
        error.code === "extension_host_identity_invalid",
    );
  }
  f.controls.actor = null;
  await assert.rejects(f.service.handle(f.request, hostSignal()));
  f.controls.actor = hostActor;
  f.controls.allowed = false;
  await assert.rejects(
    f.service.handle(f.request, hostSignal()),
    (error: unknown) =>
      error instanceof RuntimeExtensionHostError &&
      error.code === "extension_host_authorization_denied",
  );
  assert.equal(f.controls.acquired, 0);
  f.controls.allowed = true;
  f.controls.afterAcquire = () => {
    f.controls.actor = { ...hostActor, principalId: "revoked-principal" };
  };
  await assert.rejects(
    f.service.handle(f.request, hostSignal()),
    (error: unknown) =>
      error instanceof RuntimeExtensionHostError &&
      error.code === "extension_host_identity_invalid",
  );
  assert.equal(f.controls.released, 1);
  f.controls.actor = hostActor;
  f.controls.afterAcquire = () => {
    f.controls.allowed = false;
  };
  await assert.rejects(f.service.handle(f.request, hostSignal()));
  assert.equal(f.controls.released, 2);
});

test("substituted code/configuration/version/deployment routes and provider authority fail closed", async (t) => {
  const f = await extensionHostFixture(t);
  const changed = createExtensionConfiguration(
    {
      ...f.configuration,
      revision: 2,
      parameters: { baseUrl: "https://changed.example/" },
    },
    hostDigester,
  );
  const response = await f.service.handle(
    { ...f.request, configuration: changed },
    hostSignal(),
  );
  assert.equal(response.operation, "readiness");
  if (response.operation !== "readiness") throw new Error("wrong operation");
  assert.equal(response.result.outcome, "unavailable");
  for (const patch of [
    { implementationDigest: `sha256:${"d".repeat(64)}` },
    { pluginVersion: "0.2.0" },
    { pluginId: "other.plugin" },
  ])
    await assert.rejects(
      f.service.handle(
        { ...f.request, registration: { ...f.request.registration, ...patch } },
        hostSignal(),
      ),
    );
  const missing = await f.service.handle(
    { ...f.request, agentVersionId: "missing" },
    hostSignal(),
  );
  assert.equal(missing.operation, "readiness");
  if (missing.operation !== "readiness") throw new Error("wrong operation");
  assert.equal(missing.result.outcome, "unavailable");
  const base = {
    resolveActor: async () => hostActor,
    authorization: f.authorization,
    registration: () => f.registration,
  };
  const deployment = await f.store.loadAgentVersionDeployment({
    tenantId: hostActor.tenantId,
    agentVersionId: f.version.agentVersionId,
  });
  assert.ok(deployment);
  for (const patch of [
    { authorityId: "other" },
    { materializationDigest: `sha256:${"d".repeat(64)}` },
    { workspaceBindingId: "other" },
  ]) {
    const service: RuntimeExtensionHostService =
      new RuntimeExtensionHostService({
        ...base,
        runtimeResolver: f.resolver,
        deployments: {
          loadAgentVersionDeployment: async () => ({ ...deployment, ...patch }),
        },
      });
    const value = await service.handle(f.request, hostSignal());
    assert.equal(value.operation, "readiness");
    if (value.operation !== "readiness") throw new Error("wrong operation");
    assert.equal(value.result.outcome, "unavailable");
  }
  const lease = await f.resolver.acquire({
    tenantId: hostActor.tenantId,
    agentVersionId: f.version.agentVersionId,
  });
  assert.ok(lease);
  const provider = new RuntimeExtensionHostService({
    ...base,
    deployments: f.store,
    runtimeResolver: {
      acquire: async () => ({
        resource: { ...lease.resource, executionAuthority: "providerAgent" },
        release: () => {},
      }),
    },
  });
  const value = await provider.handle(f.request, hostSignal());
  if (value.operation !== "readiness") throw new Error("wrong operation");
  assert.deepEqual(value.result, {
    outcome: "unavailable",
    reasonCode: "extension_execution_authority_unsupported",
  });
  lease.release();
});

test("cancellation releases the true late lease and never returns a ready target", async (t) => {
  const f = await extensionHostFixture(t);
  const controller = new AbortController();
  const reason = new Error("cancelled");
  f.controls.afterAcquire = () => controller.abort(reason);
  await assert.rejects(
    f.service.handle(f.request, controller.signal),
    (error: unknown) => error === reason,
  );
  assert.equal(f.controls.released, 1);
});
