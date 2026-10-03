import assert from "node:assert/strict";
import { parsePluginPackageDescriptor } from "@crewon/contracts/plugins";
import { taskPin } from "../../application/src/extension-plugin-task.test-support.ts";
import type {
  PluginActionsService,
  PluginIdentity,
  PluginTaskService,
  PluginTaskServiceV2,
} from "@crewon/plugin-sdk/node";
import { PluginNodeHost } from "./plugin-node-host.ts";
import {
  PluginProjectGenerationExecutionBridge,
  type PluginProjectGenerationExecutionInput,
} from "./plugin-project-generation-execution-bridge.ts";
import { projectGenerationBridgeFixture } from "./plugin-project-generation-action-bridge.test-support.ts";

/** Execution-port unit fixture: actual App receipt values, explicit Node/transaction doubles, no SQL admission claim. */
export function projectGenerationExecutionFixture() {
  const f = projectGenerationBridgeFixture();
  const context = f.app.detachedContext();
  const command = f.app.commandFor(context);
  const sourcePin = {
    ...taskPin,
    pluginId: context.package.pluginId,
    publisherId: context.package.publisherId,
    version: context.package.version,
    packageDigest: context.package.packageDigest,
    selectionRevision: context.selection.revision,
    authorityEpoch: context.authorityEpoch,
    action: context.action,
  };
  const descriptor = parsePluginPackageDescriptor({
    ...context.lease.descriptor,
    pluginId: taskPin.pluginId,
    publisherId: taskPin.publisherId,
    version: taskPin.version,
    entrypoints: {
      node: "node.mjs",
      ui: { path: "ui.mjs", mode: "trustedModule" },
    },
    requires: [{ service: "crewon.tasks", apiVersion: "1", optional: false }],
    provides: [{ service: taskPin.pluginId, apiVersion: "1" }],
    files: [
      ...context.lease.descriptor.files,
      { path: "node.mjs", byteLength: 1, sha256: "b".repeat(64) },
    ],
  });
  const state = {
    now: "2026-10-02T03:00:00.000Z",
    nextId: "e".repeat(40),
    releases: 0,
    borrows: 0,
    commitCalls: 0,
    fullCalls: 0,
    transactionCalls: 0,
    serviceLookups: [] as string[],
    calls: [] as string[],
    beforeCommit: null as (() => Promise<void>) | null,
    afterCommit: null as (() => void) | null,
    beforeFull: null as (() => Promise<void>) | null,
    lastInvocation: null as
      | Parameters<PluginActionsService["invoke"]>[0]
      | null,
  };
  const bridge = new PluginProjectGenerationExecutionBridge({
    clock: { now: () => state.now },
    ids: { nextId: () => state.nextId },
  });
  const identity: PluginIdentity = Object.freeze({
    pluginId: taskPin.pluginId,
    version: taskPin.version,
    packageDigest: taskPin.packageDigest,
  });
  const bound = bridge.hostService().bindForPlugin!(identity, {
    onDispose() {},
  }) as PluginTaskService;
  const boundV2 = bridge.hostServiceV2().bindForPlugin!(identity, {
    onDispose() {},
  }) as PluginTaskServiceV2;
  let service: PluginActionsService = {
    actions: [
      {
        contributionId: taskPin.contributionId,
        action: taskPin.action,
        kind: "generateTask",
      },
    ],
    async invoke(invocation) {
      state.lastInvocation = invocation;
      const request = invocation.input as unknown as Omit<
        Parameters<PluginTaskService["createTask"]>[0],
        "invocationRef"
      >;
      return bound.createTask({
        invocationRef: invocation.invocationRef,
        ...request,
      });
    },
  };
  const node = {
    acquire(input: Parameters<PluginNodeHost["acquire"]>[0]) {
      assert.equal(input.pluginId, taskPin.pluginId);
      assert.equal(input.packageDigest, taskPin.packageDigest);
      assert.equal(input.purpose, "newOperation");
      assert.equal(input.authorizeBorrow(identity), "allow");
      state.borrows++;
      return {
        identity,
        getService(name: string, version: string) {
          state.serviceLookups.push(`${name}@${version}`);
          assert.equal(name, taskPin.pluginId);
          assert.equal(version, "1");
          return service;
        },
        release() {
          state.releases++;
        },
      };
    },
  } as unknown as PluginNodeHost;
  const input: PluginProjectGenerationExecutionInput = {
    context,
    publication: f.app.publication,
    sourcePin,
    executionPin: taskPin,
    targetCandidate: { descriptor, packageDigest: taskPin.packageDigest },
    request: f.app.request,
    command,
    authority: {
      async assertCurrent() {
        state.fullCalls++;
        state.calls.push("full");
        await state.beforeFull?.();
      },
      async assertTransactionCurrent() {
        state.transactionCalls++;
        state.calls.push("transaction");
      },
      assertActive() {
        state.calls.push("active");
      },
    },
    async commit(received) {
      state.commitCalls++;
      await state.beforeCommit?.();
      await received.authority.assertTransactionCurrent();
      received.authority.assertActive();
      assert.deepEqual(received.command, command);
      assert.deepEqual(received.executionPin, taskPin);
      const accepted = await f.app.accept(context);
      state.afterCommit?.();
      return accepted.result;
    },
  };
  async function execute(next = input) {
    const dispose = f.register(next.context);
    try {
      return await bridge.execute(node, next);
    } finally {
      dispose();
    }
  }
  return {
    f,
    state,
    bridge,
    identity,
    bound,
    boundV2,
    node,
    input,
    execute,
    setService(next: PluginActionsService) {
      service = next;
    },
  };
}
