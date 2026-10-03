import assert from "node:assert/strict";
import { parsePluginPackageDescriptor } from "@crewon/contracts/plugins";
import type {
  PluginActionsService,
  PluginIdentity,
  PluginTaskServiceV2,
} from "@crewon/plugin-sdk/node";
import { PluginNodeHost } from "./plugin-node-host.ts";
import {
  PluginProjectGenerationQueryExecutionBridge,
  type PluginProjectGenerationQueryExecutionInput,
} from "./plugin-project-generation-query-execution-bridge.ts";
import { projectGenerationQueryBridgeFixture } from "./plugin-project-generation-query-action-bridge.test-support.ts";

/** Real Application query receipt; explicit Node borrow double, not SQL or provider execution. */
export async function projectGenerationQueryExecutionFixture() {
  const f = await projectGenerationQueryBridgeFixture();
  const pin = f.app.executionPin;
  const descriptor = parsePluginPackageDescriptor({
    ...f.context.lease.descriptor,
    pluginId: pin.pluginId,
    publisherId: pin.publisherId,
    version: pin.version,
    entrypoints: {
      node: "node.mjs",
      ui: { path: "ui.mjs", mode: "trustedModule" },
    },
    requires: [{ service: "crewon.tasks", apiVersion: "2", optional: false }],
    provides: [{ service: pin.pluginId, apiVersion: "1" }],
    files: [
      ...f.context.lease.descriptor.files,
      { path: "node.mjs", byteLength: 1, sha256: "b".repeat(64) },
    ],
  });
  const state = {
    now: "2026-10-02T03:00:00.000Z",
    releases: 0,
    borrows: 0,
    commits: 0,
    full: 0,
    transaction: 0,
    beforeCommit: null as (() => Promise<void>) | null,
    afterCommit: null as (() => void) | null,
    beforeFull: null as (() => Promise<void>) | null,
    lastInvocation: null as
      | Parameters<PluginActionsService["invoke"]>[0]
      | null,
  };
  const bridge = new PluginProjectGenerationQueryExecutionBridge({
    clock: { now: () => state.now },
    ids: { nextId: () => "q".repeat(40) },
  });
  const identity: PluginIdentity = Object.freeze({
    pluginId: pin.pluginId,
    version: pin.version,
    packageDigest: pin.packageDigest,
  });
  const bound = bridge.hostServiceV2().bindForPlugin!(identity, {
    onDispose() {},
  }) as PluginTaskServiceV2;
  let service: PluginActionsService = {
    actions: [
      {
        contributionId: pin.contributionId,
        action: pin.action,
        kind: "queryTask",
      },
    ],
    async invoke(invocation) {
      state.lastInvocation = invocation;
      return bound.queryTask({
        invocationRef: invocation.invocationRef,
        ...(invocation.input as unknown as Omit<
          Parameters<PluginTaskServiceV2["queryTask"]>[0],
          "invocationRef"
        >),
      });
    },
  };
  const node = {
    acquire(input: Parameters<PluginNodeHost["acquire"]>[0]) {
      assert.equal(input.pluginId, pin.pluginId);
      assert.equal(input.packageDigest, pin.packageDigest);
      assert.equal(input.authorizeBorrow(identity), "allow");
      state.borrows++;
      return {
        identity,
        getService(name: string, version: string) {
          assert.equal(name, pin.pluginId);
          assert.equal(version, "1");
          return service;
        },
        release() {
          state.releases++;
        },
      };
    },
  } as unknown as PluginNodeHost;
  const input: PluginProjectGenerationQueryExecutionInput = {
    context: f.context,
    publication: f.app.publication,
    sourcePin: f.app.sourcePin,
    executionPin: pin,
    targetCandidate: { descriptor, packageDigest: pin.packageDigest },
    request: f.app.request,
    command: f.app.command,
    authority: {
      async assertCurrent() {
        state.full++;
        await state.beforeFull?.();
      },
      async assertTransactionCurrent() {
        state.transaction++;
      },
      assertActive() {},
    },
    async commit(received) {
      state.commits++;
      await state.beforeCommit?.();
      await received.authority.assertTransactionCurrent();
      received.authority.assertActive();
      assert.deepEqual(received.command, f.app.command);
      assert.deepEqual(received.executionPin, pin);
      const result = await f.app.accept();
      state.afterCommit?.();
      return result.result;
    },
  };
  const execute = async (next = input) => {
    const dispose = f.register(next.context);
    try {
      return await bridge.execute(node, next);
    } finally {
      dispose();
    }
  };
  return {
    f,
    state,
    bridge,
    identity,
    bound,
    node,
    input,
    execute,
    setService(next: PluginActionsService) {
      service = next;
    },
  };
}
