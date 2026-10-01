import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionConfiguration } from "@crewon/domain";
import { InMemoryToolBroker } from "@crewon/tool-broker";
import { ConfiguredAgentVersionRuntimeFactory } from "./configured-agent-version-runtime-factory.ts";
import {
  extensionHostFixture,
  hostActor,
  hostDigester,
} from "./extension-host.test-support.ts";
import { comfyToolDefinitions } from "./extensions/comfyui-tool-catalog.ts";
import {
  parseRuntimeExtensionMaterialization,
  registerRuntimeExtensionMaterializations,
  readRuntimeExtensionMaterializations,
} from "./extensions/extension-runtime-proof.ts";

test("a real configured factory exposes the immutable proof from its constructed final tool owner", async (t) => {
  const f = await extensionHostFixture(t);
  const lease = await f.resolver.acquire({
    tenantId: hostActor.tenantId,
    agentVersionId: f.version.agentVersionId,
  });
  assert.ok(lease);
  assert.deepEqual(lease.resource.extensions, [f.proof]);
  assert.ok(Object.isFrozen(lease.resource.extensions));
  assert.ok(
    Object.isFrozen(lease.resource.extensions![0]!.configuration.parameters),
  );
  assert.equal(lease.resource.executionAuthority, "crewonKernel");
  lease.release();
});

test("unregistered metadata proves nothing and a registered owner cannot be rebound to another configuration", async (t) => {
  const f = await extensionHostFixture(t);
  const tools = new InMemoryToolBroker(comfyToolDefinitions());
  assert.equal(readRuntimeExtensionMaterializations(tools), null);
  registerRuntimeExtensionMaterializations(tools, [f.proof]);
  registerRuntimeExtensionMaterializations(tools, [structuredClone(f.proof)]);
  assert.deepEqual(readRuntimeExtensionMaterializations(tools), [f.proof]);
  const configuration = createExtensionConfiguration(
    { ...f.configuration, revision: 2 },
    hostDigester,
  );
  assert.throws(
    () =>
      registerRuntimeExtensionMaterializations(tools, [
        { ...f.proof, configuration },
      ]),
    /extension_runtime_materialization_invalid/u,
  );
  assert.throws(
    () =>
      registerRuntimeExtensionMaterializations(new InMemoryToolBroker(), [
        f.proof,
        f.proof,
      ]),
    /extension_runtime_materialization_invalid/u,
  );
});

test("materialization records reject altered code/configuration, credential slots and provider authority", async (t) => {
  const f = await extensionHostFixture(t);
  for (const changed of [
    {
      ...f.proof,
      target: { ...f.target, executionAuthority: "providerAgent" },
    },
    {
      ...f.proof,
      configuration: {
        ...f.configuration,
        contentDigest: `sha256:${"d".repeat(64)}`,
      },
    },
    {
      ...f.proof,
      registration: {
        ...f.registration,
        implementationDigest: `sha256:${"d".repeat(64)}`,
      },
    },
    {
      ...f.proof,
      registration: {
        ...f.registration,
        manifestDigest: `sha256:${"d".repeat(64)}`,
      },
    },
    {
      ...f.proof,
      configuration: createExtensionConfiguration(
        {
          ...f.configuration,
          credentialBindings: [
            { slotId: "unknown", credentialBindingId: "secret-ref" },
          ],
        },
        hostDigester,
      ),
    },
    { ...f.proof, approvalRequirement: "automatic" },
    { ...f.proof, unexpected: true },
  ])
    assert.throws(
      () => parseRuntimeExtensionMaterialization(changed as typeof f.proof),
      /extension_runtime_materialization_invalid/u,
    );
});

test("a factory rejects a proof for a different published version or materialized route", async (t) => {
  const f = await extensionHostFixture(t);
  for (const patch of [
    { authorityId: "other" },
    { materializationDigest: `sha256:${"d".repeat(64)}` },
    { agentVersionId: "other" },
    { agentVersionContentDigest: `sha256:${"d".repeat(64)}` },
    { runtimeGeneration: "other" },
    { policySnapshotId: "other" },
  ]) {
    const tools = new InMemoryToolBroker(comfyToolDefinitions());
    registerRuntimeExtensionMaterializations(tools, [
      { ...f.proof, target: { ...f.target, ...patch } },
    ]);
    const factory = new ConfiguredAgentVersionRuntimeFactory([
      {
        tenantId: hostActor.tenantId,
        agentVersionId: f.version.agentVersionId,
        contentDigest: f.version.contentDigest,
        authorityId: f.target.authorityId,
        materializationDigest: f.target.materializationDigest,
        workspaceBindingId: null,
        executionAuthority: "crewonKernel",
        createToolRuntime: () => tools,
        createTransport: () => ({
          ...f.version.model,
          async *stream(): AsyncGenerator<never> {
            throw new Error("unexpected_model_request");
          },
        }),
      },
    ]);
    await assert.rejects(
      factory.create({ tenantId: hostActor.tenantId, version: f.version }),
      /extension_runtime_materialization_mismatch/u,
    );
  }
});
