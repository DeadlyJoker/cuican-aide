import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryToolBroker } from "@crewon/tool-broker";
import { RuntimeCreationCleanup } from "./runtime-creation-cleanup.ts";
import { ConfiguredAgentVersionRuntimeFactory } from "./configured-agent-version-runtime-factory.ts";
import {
  createAdmittedAgentRuntime,
  closeAdmittedAgentRuntime,
} from "./admitted-agent-runtime-creation.ts";
import { AgentRuntimeCapacity } from "./agent-runtime-capacity.ts";
import { version } from "./shared-agent-runtime-cache.test-support.ts";
import { deferred } from "./runtime-store-access.test-support.ts";

test("nested cleanup starts every disposer despite a synchronous throw and preserves uncertainty", async () => {
  let confirmations = 0;
  const scope = new RuntimeCreationCleanup({
    confirmReleased: () => {
      confirmations++;
    },
  });
  const finished = deferred();
  let secondStarted = false;
  scope.own({
    close() {
      throw new Error("first cleanup failed");
    },
  });
  scope.own({
    async close() {
      secondStarted = true;
      await finished.promise;
    },
  });
  const closing = scope.cleanup();
  assert.equal(scope.cleanup(), closing);
  await Promise.resolve();
  assert.equal(secondStarted, true);
  assert.equal(confirmations, 0);
  finished.resolve();
  await closing;
  assert.equal(confirmations, 0);
});

test("late nested cleanup confirmation releases only after all known owners finish closing", async () => {
  const compiled = version("nested");
  const capacity = new AgentRuntimeCapacity({ maximumOwners: 1 });
  const failure = new Error("nested creation failed");
  let confirm!: () => void;
  const factory = new ConfiguredAgentVersionRuntimeFactory([
    {
      tenantId: "tenant",
      agentVersionId: compiled.agentVersionId,
      contentDigest: compiled.contentDigest,
      authorityId: "authority",
      workspaceBindingId: null,
      materializationDigest: `sha256:${"d".repeat(64)}`,
      executionAuthority: "crewonKernel",
      createTransport: () => transport(),
      createToolRuntime: (_version, options) => {
        confirm = options!.failedCreationCleanup!.confirmReleased;
        throw failure;
      },
    },
  ]);
  await assert.rejects(
    createAdmittedAgentRuntime({
      factory,
      capacity,
      ownership: "ownedRuntime",
      tenantId: "tenant",
      version: compiled,
    }),
    (error) => error === failure,
  );
  assert.equal(capacity.snapshot().uncertain, 1);
  confirm();
  confirm();
  assert.equal(capacity.snapshot().owners, 0);
});

test("a creator returning an owner after early confirmation still requires its physical disposal", async () => {
  const compiled = version("returned");
  const capacity = new AgentRuntimeCapacity({ maximumOwners: 1 });
  const gate = deferred();
  const started = deferred();
  let late!: () => void;
  const factory = new ConfiguredAgentVersionRuntimeFactory([
    {
      tenantId: "tenant",
      agentVersionId: compiled.agentVersionId,
      contentDigest: compiled.contentDigest,
      authorityId: "authority",
      workspaceBindingId: null,
      materializationDigest: `sha256:${"d".repeat(64)}`,
      executionAuthority: "crewonKernel",
      createTransport: () => transport(),
      createToolRuntime: (_version, options) => {
        late = options!.failedCreationCleanup!.confirmReleased;
        late();
        return Object.assign(new InMemoryToolBroker(), {
          close: async () => {
            started.resolve();
            await gate.promise;
          },
        });
      },
    },
  ]);
  const admitted = await createAdmittedAgentRuntime({
    factory,
    capacity,
    ownership: "ownedRuntime",
    tenantId: "tenant",
    version: compiled,
  });
  late();
  assert.equal(capacity.snapshot().owners, 1);
  const closing = closeAdmittedAgentRuntime(admitted);
  await started.promise;
  assert.equal(capacity.snapshot().owners, 1);
  gate.resolve();
  await closing;
  assert.equal(capacity.snapshot().owners, 0);
});

test("failed prewarm without a disposer cannot confirm that external resources ended", async () => {
  const compiled = version("prewarm");
  const capacity = new AgentRuntimeCapacity({ maximumOwners: 1 });
  const failure = new Error("prewarm failed after allocating");
  const factory = new ConfiguredAgentVersionRuntimeFactory([
    {
      tenantId: "tenant",
      agentVersionId: compiled.agentVersionId,
      contentDigest: compiled.contentDigest,
      authorityId: "authority",
      workspaceBindingId: null,
      materializationDigest: `sha256:${"d".repeat(64)}`,
      executionAuthority: "crewonKernel",
      createTransport: () => ({
        ...transport(),
        prewarm: async () => {
          throw failure;
        },
      }),
      createToolRuntime: () => new InMemoryToolBroker(),
    },
  ]);
  await assert.rejects(
    createAdmittedAgentRuntime({
      factory,
      capacity,
      ownership: "ownedRuntime",
      tenantId: "tenant",
      version: compiled,
    }),
    (error) => error === failure,
  );
  assert.equal(capacity.snapshot().uncertain, 1);
});

function transport() {
  return {
    adapterName: "fixture",
    adapterVersion: "1",
    modelId: "fixture-model",
    async *stream(): AsyncGenerator<never> {
      throw new Error("unexpected model call");
    },
  };
}
